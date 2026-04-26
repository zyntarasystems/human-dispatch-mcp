import { isIP } from "node:net";
import { promises as dns } from "node:dns";

const FORBIDDEN_HOSTNAMES = new Set<string>([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
  "metadata.google.internal",
  "metadata.aws.amazon.com",
  "metadata.azure.com",
]);

const FORBIDDEN_HOSTNAME_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".internal",
];

function checkIPv4Forbidden(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const x = parseInt(p, 10);
    if (x < 0 || x > 255) return null;
    nums.push(x);
  }
  const a = nums[0]!;
  const b = nums[1]!;
  const c = nums[2]!;

  if (a === 0) return "0.0.0.0/8 (current network)";
  if (a === 10) return "10.0.0.0/8 (RFC1918 private)";
  if (a === 100 && b >= 64 && b <= 127) return "100.64.0.0/10 (CGNAT)";
  if (a === 127) return "127.0.0.0/8 (loopback)";
  if (a === 169 && b === 254) return "169.254.0.0/16 (link-local / cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 (RFC1918 private)";
  if (a === 192 && b === 0 && c === 0) return "192.0.0.0/24 (reserved)";
  if (a === 192 && b === 0 && c === 2) return "192.0.2.0/24 (TEST-NET-1)";
  if (a === 192 && b === 168) return "192.168.0.0/16 (RFC1918 private)";
  if (a === 198 && (b === 18 || b === 19)) return "198.18.0.0/15 (benchmark)";
  if (a === 198 && b === 51 && c === 100) return "198.51.100.0/24 (TEST-NET-2)";
  if (a === 203 && b === 0 && c === 113) return "203.0.113.0/24 (TEST-NET-3)";
  if (a >= 224 && a <= 239) return "224.0.0.0/4 (multicast)";
  if (a >= 240) return "240.0.0.0/4 (reserved)";
  return null;
}

function checkIPv6Forbidden(ip: string): string | null {
  const stripped = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (stripped === "::" || stripped === "::1") return "IPv6 loopback/unspecified";

  if (stripped.startsWith("::ffff:")) {
    const tail = stripped.slice(7);
    if (isIP(tail) === 4) {
      const v4Reason = checkIPv4Forbidden(tail);
      if (v4Reason) return `IPv4-mapped IPv6: ${v4Reason}`;
    }
  }

  if (/^fc[0-9a-f]{2}:/.test(stripped) || /^fd[0-9a-f]{2}:/.test(stripped)) {
    return "fc00::/7 (ULA private)";
  }
  if (/^fe[89ab][0-9a-f]:/.test(stripped)) return "fe80::/10 (link-local)";
  if (/^ff[0-9a-f]{2}:/.test(stripped)) return "ff00::/8 (multicast)";
  if (/^2002:/.test(stripped)) return "2002::/16 (6to4)";
  if (/^2001:db8:/.test(stripped)) return "2001:db8::/32 (documentation)";
  if (/^2001:0*[01]?:/.test(stripped)) return "2001::/32 (Teredo)";
  if (/^64:ff9b:/.test(stripped)) return "64:ff9b::/96 (NAT64)";
  return null;
}

function checkHostnameForbidden(hostname: string): string | null {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (FORBIDDEN_HOSTNAMES.has(lower)) return `forbidden hostname: ${lower}`;
  for (const suffix of FORBIDDEN_HOSTNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) return `forbidden suffix: ${suffix}`;
  }
  return null;
}

export class UrlValidationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Forbidden URL: ${reason}`);
    this.name = "UrlValidationError";
    this.reason = reason;
  }
}

/**
 * Synchronous static validation. Rejects non-HTTPS URLs, URLs with userinfo,
 * and IP literals or hostnames pointing at loopback / private / link-local /
 * cloud-metadata targets. Does NOT do DNS resolution — see {@link safeFetch}.
 *
 * Returns the rejection reason, or null if the URL passes.
 */
export function staticValidatePublicHttpsUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "invalid URL";
  }
  if (parsed.protocol !== "https:") return "must be https://";
  if (parsed.username || parsed.password) return "userinfo not allowed";

  const hostnameRaw = parsed.hostname.replace(/^\[|\]$/g, "");
  const ipKind = isIP(hostnameRaw);
  if (ipKind === 4) return checkIPv4Forbidden(hostnameRaw);
  if (ipKind === 6) return checkIPv6Forbidden(hostnameRaw);
  return checkHostnameForbidden(hostnameRaw);
}

/** True iff the URL passes the synchronous public-HTTPS check. */
export function isPublicHttpsUrl(rawUrl: string): boolean {
  return staticValidatePublicHttpsUrl(rawUrl) === null;
}

/** Throws {@link UrlValidationError} if the URL is forbidden. Synchronous. */
export function assertPublicHttpsUrl(rawUrl: string): void {
  const reason = staticValidatePublicHttpsUrl(rawUrl);
  if (reason !== null) throw new UrlValidationError(reason);
}

/**
 * Resolve the hostname and reject if any returned address is non-public.
 * Mitigates DNS rebinding for hostname-based URLs and catches octal/decimal/hex
 * IPv4 forms that bypass the static IP check (the OS resolver canonicalizes
 * them).
 *
 * Residual risk: a TOCTOU window exists between this resolve and the actual
 * fetch's connect. The OS DNS cache mostly closes that window in practice.
 * For full mitigation, deploy behind a network egress firewall.
 */
async function assertResolvedPublicHostname(hostname: string): Promise<void> {
  const stripped = hostname.replace(/^\[|\]$/g, "");
  if (isIP(stripped) !== 0) return; // already an IP literal — static check applies

  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(stripped, { all: true, verbatim: true });
  } catch (err) {
    throw new UrlValidationError(
      `DNS lookup failed for ${stripped}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addrs.length === 0) {
    throw new UrlValidationError(`DNS lookup returned no addresses for ${stripped}`);
  }
  for (const { address, family } of addrs) {
    const reason = family === 6 ? checkIPv6Forbidden(address) : checkIPv4Forbidden(address);
    if (reason) {
      throw new UrlValidationError(`${stripped} resolves to ${address} (${reason})`);
    }
  }
}

/**
 * Fetch wrapper with full SSRF guard. Runs static URL check, resolves the
 * hostname, validates every returned address, then performs the fetch.
 * Throws {@link UrlValidationError} before touching the network if the URL
 * is forbidden.
 */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
  assertPublicHttpsUrl(rawUrl);
  const u = new URL(rawUrl);
  await assertResolvedPublicHostname(u.hostname);
  return fetch(rawUrl, init);
}

/**
 * Strip host / IP / sys-error-code details from an error message before
 * persisting it to attempts[].error or returning it to a tool caller.
 * Defense-in-depth: prevents fetch / DNS / SSRF errors from leaking the
 * provider's hostname or IP back to whoever queries task status.
 */
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let msg = raw.replace(
    /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EHOSTDOWN|ETIMEDOUT|EPROTO|EAI_AGAIN|ECERTHOSTNAMEMISMATCH|ENETUNREACH)\b[\s:]*\S+/g,
    "$1",
  );
  msg = msg.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[redacted-ip]");
  msg = msg.replace(/\[[0-9a-fA-F:]+\](?::\d+)?/g, "[redacted-ip]");
  return msg.slice(0, 300);
}

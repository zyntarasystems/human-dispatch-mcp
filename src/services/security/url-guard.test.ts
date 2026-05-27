import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPublicHttpsUrl,
  safeFetch,
  sanitizeErrorMessage,
  staticValidatePublicHttpsUrl,
  UrlValidationError,
} from "./url-guard.js";

const rejectedUrls = [
  "http://example.com/",
  "https://localhost/",
  "https://service.localhost/",
  "https://127.0.0.1/",
  "https://10.0.0.1/",
  "https://172.16.0.1/",
  "https://172.31.255.255/",
  "https://192.168.1.1/",
  "https://169.254.169.254/",
  "https://0.0.0.0/",
  "https://100.64.0.1/",
  "https://192.0.2.1/",
  "https://198.51.100.1/",
  "https://203.0.113.1/",
  "https://224.0.0.1/",
  "https://240.0.0.1/",
  "https://user:pass@example.com/",
  "https://[::1]/",
  "https://[::ffff:127.0.0.1]/",
  "https://[::ffff:10.0.0.1]/",
  "https://[fc00::1]/",
  "https://[fd00::1]/",
  "https://[fe80::1]/",
  "https://[ff00::1]/",
  "https://[2001:db8::1]/",
];

for (const url of rejectedUrls) {
  test(`staticValidatePublicHttpsUrl rejects ${url}`, () => {
    assert.notEqual(staticValidatePublicHttpsUrl(url), null);
  });
}

test("staticValidatePublicHttpsUrl accepts normal public HTTPS URLs", () => {
  assert.equal(staticValidatePublicHttpsUrl("https://example.com/webhook"), null);
});

test("assertPublicHttpsUrl throws UrlValidationError for forbidden URLs", () => {
  assert.throws(
    () => assertPublicHttpsUrl("https://127.0.0.1/"),
    UrlValidationError,
  );
});

test("safeFetch rejects forbidden URLs before network fetch", async () => {
  await assert.rejects(
    () => safeFetch("https://127.0.0.1/"),
    UrlValidationError,
  );
});

test("sanitizeErrorMessage hides URL validation details and IP addresses", () => {
  assert.equal(
    sanitizeErrorMessage(new UrlValidationError("127.0.0.1 loopback")),
    "URL failed public-host validation",
  );
  assert.equal(
    sanitizeErrorMessage(new Error("connect ECONNREFUSED 192.168.1.5:443")),
    "connect ECONNREFUSED",
  );
});

export const SERVER_NAME = "human-dispatch-mcp";
export const SERVER_VERSION = "0.4.0";

export const DEFAULT_TRANSPORT = "stdio";
export const DEFAULT_PORT = 3000;

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export const DEFAULT_CURRENCY = "USD";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_SIGNATURE_HEADER = "x-dispatch-signature";
export const WEBHOOK_PROVIDER_ID_HEADER = "x-provider-id";

// Wall-clock budget for a single human_dispatch_task call. Walks the routing
// chain, attempting each backend; abandons further attempts once exceeded.
// Per-attempt timeout (WEBHOOK_TIMEOUT_MS) still applies inside each fetch.
export const ROUTING_DEADLINE_MS = 60_000;

// Maximum number of providers WebhookProviderAdapter will walk in a single
// submitTask call. Caps worst-case dispatch latency when many providers all
// reject or time out.
export const MAX_PROVIDER_CANDIDATES = 5;

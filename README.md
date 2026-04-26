# human-dispatch-mcp

**A universal dispatch layer for AI-agent-to-human task routing** — Any business (law firms, VA services, freelancers, agencies) can plug in via webhooks and start receiving AI-dispatched tasks in minutes.

Routes tasks to registered webhook providers with smart matching, fallback chains, and proof-of-completion tracking. Any service provider registers a webhook, and the router matches tasks to providers based on capabilities, region, and budget.

## Quick Start

```bash
# Clone and install
git clone https://github.com/zyntarasystems/human-dispatch-mcp.git
cd human-dispatch-mcp
npm install

# Configure (optional — works out of the box with manual fallback)
cp .env.example .env

# Build and run
npm run build
node dist/index.js
```

## Testing with MCP Inspector

The easiest way to verify the server is working:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Open `http://localhost:5173`, enter the proxy session token shown in your terminal, and click **Connect**.

### Test sequence:

1. **List backends** — call `human_list_backends` to see `webhook_provider` and `manual`

2. **Register a provider** — call `human_register_provider`:
```json
{
  "name": "Test Provider",
  "webhook_url": "https://webhook.site/your-uuid",
  "webhook_secret": "a-secret-that-is-at-least-32-chars-long!",
  "categories": ["digital_micro"],
  "task_types": ["digital"],
  "regions": ["*"],
  "min_budget_usd": 0,
  "max_budget_usd": 500,
  "max_concurrent_tasks": 10
}
```

3. **Dispatch a task** — call `human_dispatch_task` with **Raw JSON** input mode:
```json
{
  "description": "Test task — verify the MCP server is routing correctly",
  "category": "digital_micro",
  "task_type": "digital",
  "budget": { "max_usd": 5, "currency": "USD" },
  "deadline": {
    "complete_by": "2026-04-10T18:00:00Z",
    "urgency": "low"
  },
  "proof_required": ["text_report"],
  "quality_sla": "low",
  "callback_url": null
}
```

The task should route to your registered provider. If no providers match, it falls through to the manual backend.

## MCP Client Configuration

### Claude Desktop / Cursor / Any MCP Client

```json
{
  "mcpServers": {
    "human-dispatch": {
      "command": "npx",
      "args": ["human-dispatch-mcp"]
    }
  }
}
```

### HTTP Transport

> **Note:** HTTP transport binds to `127.0.0.1` only. For remote access, place a TLS-terminating reverse proxy (e.g. nginx, Caddy) in front of the server. Never expose the port directly.

> **Required:** HTTP transport refuses to start without `MCP_AUTH_TOKEN` set. All `POST /mcp` requests must include `Authorization: Bearer <MCP_AUTH_TOKEN>`. The `/callbacks/task/:taskId` endpoint uses HMAC-signature auth instead — providers do not see the bearer token.

```json
{
  "mcpServers": {
    "human-dispatch": {
      "command": "npx",
      "args": ["human-dispatch-mcp"],
      "env": {
        "TRANSPORT": "http",
        "PORT": "3000",
        "MCP_AUTH_TOKEN": "a-long-random-string-32-chars-or-more"
      }
    }
  }
}
```

## Tools Reference

| Tool | Description |
|------|-------------|
| `human_dispatch_task` | Submit a task to be completed by a human worker via the best matching provider |
| `human_get_task_status` | Poll the current status, worker info, and proof submissions for a task |
| `human_cancel_task` | Cancel a pending or in-progress task |
| `human_list_tasks` | List tasks with filters (status, backend, category) and pagination |
| `human_list_backends` | Show available backends, their configuration status, and capabilities |
| `human_register_provider` | Register a webhook provider to receive dispatched tasks |
| `human_list_providers` | List registered providers with stats and filters |
| `human_remove_provider` | Deregister a webhook provider |

## Architecture

```
┌─────────────┐
│   AI Agent   │
│ (Claude, etc)│
└──────┬───────┘
       │ MCP Protocol (stdio or HTTP)
       ▼
┌──────────────────────────────────────┐
│     human-dispatch-mcp Server        │
│                                      │
│  ┌────────────┐  ┌────────────────┐  │
│  │ Task Store │  │ Provider       │  │
│  │ (in-memory)│  │ Registry       │  │
│  └────────────┘  └───────┬────────┘  │
│                          │           │
│  ┌────────────┐  ┌───────▼────────┐  │
│  │   Router   │──│  Webhook       │  │
│  │  (scoring) │  │  Provider      │  │
│  └──────┬─────┘  │  Adapter       │  │
│         │        └───────┬────────┘  │
│         │                │           │
│         │    ┌───────────▼─────────┐ │
│         │    │ Provider A (law)    │ │
│         │    │ Provider B (VA)     │ │
│         │    │ Provider C (photos) │ │
│         │    └─────────────────────┘ │
│         ▼                            │
│  ┌────────────┐                      │
│  │   Manual   │ (always-on fallback) │
│  │  Adapter   │                      │
│  └────────────┘                      │
└──────────────────────────────────────┘
```

## For Service Providers

Any business can register as a provider to receive AI-dispatched tasks. Here's how:

### 1. Set up a webhook endpoint

Your endpoint receives POST requests with these headers:

| Header | Description |
|--------|-------------|
| `x-dispatch-signature` | `sha256=<hmac_hex>` — HMAC-SHA256 of the request body using your shared secret |
| `X-Dispatch-Event` | Event type: `task.new`, `task.cancel`, or `provider.verify` |
| `X-Dispatch-TaskId` | UUID of the task |

### 2. Handle `task.new` events

Request body:
```json
{
  "payload_version": 1,
  "event": "task.new",
  "task_id": "uuid",
  "description": "What needs to be done",
  "category": "photo_video",
  "task_type": "physical",
  "location": { "address": "123 Main St", "region": "US" },
  "budget": { "max_usd": 25, "currency": "USD" },
  "deadline": { "complete_by": "2026-04-10T18:00:00Z", "urgency": "medium" },
  "proof_required": ["photo", "gps_checkin"],
  "quality_sla": "medium"
}
```

`payload_version` is the request-shape version; pin your parser to a known version and reject unknown ones. Today only `1` is sent.

Respond with:
```json
{ "accepted": true, "external_id": "your-internal-id" }
```

Or reject:
```json
{ "accepted": false, "reason": "Outside service area" }
```

### Handle `provider.verify` events

When a provider is registered, the server immediately POSTs a `provider.verify` event to confirm the endpoint is reachable and willing. **A 200 alone is not enough** — your endpoint must return `{ "verified": true }` in the JSON body. Anything else (missing field, `false`, non-JSON) marks verification as unreachable. This makes registration require explicit consent from your endpoint, not just URL reachability.

### 3. Report completion (HTTP transport only)

POST to `http://<server>/callbacks/task/<task_id>` with headers:
- `x-provider-id`: Your provider UUID
- `x-dispatch-signature`: `sha256=<hmac_hex>` of the body

```json
{
  "status": "completed",
  "proof": [
    { "type": "photo", "url": "https://...", "submitted_at": "2026-04-10T12:00:00Z" }
  ],
  "actual_cost_usd": 20,
  "notes": "Task completed successfully"
}
```

### 4. Verify HMAC signatures

Always verify incoming webhooks using your shared secret:

```javascript
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
```

**HMAC canonicalization contract (load-bearing):** the signature is computed over the **exact bytes** the request was POSTed with, not over a re-serialized JSON object. When you send a callback, sign the byte string you put on the wire — do not parse the body, re-stringify it, and sign that, because key ordering or whitespace may differ. Use `JSON.stringify(payload)` once, capture the resulting string, sign that string, send that string. The server applies the same rule on the receiving side: it captures the raw request body buffer before any JSON parser touches it.

## Smart Routing

The router automatically picks the best backend based on:
1. **Agent preferences** — `preferred_backends` and `fallback_chain` are honored first
2. **Provider matching** — category, task type, region, and budget compatibility
3. **Reliability** — providers with higher completion rates are tried first
4. **Speed** — faster providers score higher
5. **Fallback** — the `manual` backend is always available as the ultimate fallback

## Example Agent Usage

### Python with LangGraph

```python
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient

async def dispatch_photo_task():
    async with MultiServerMCPClient({
        "human": {
            "command": "node",
            "args": ["path/to/human-dispatch-mcp/dist/index.js"],
            "transport": "stdio",
        }
    }) as client:
        tools = client.get_tools()

        # Register a provider first
        await client.call_tool("human_register_provider", {
            "name": "Photo Service Co",
            "webhook_url": "https://photos.example.com/webhook",
            "webhook_secret": "your-secret-that-is-at-least-32-characters",
            "categories": ["photo_video"],
            "task_types": ["physical"],
            "regions": ["US"],
            "min_budget_usd": 5,
            "max_budget_usd": 100,
            "max_concurrent_tasks": 20
        })

        # Dispatch a task
        result = await client.call_tool("human_dispatch_task", {
            "description": "Take a photo of the menu board at Starbucks on 5th Ave, NYC",
            "category": "photo_video",
            "task_type": "physical",
            "location": {
                "address": "5th Ave & 42nd St, New York, NY",
                "region": "US"
            },
            "budget": {"max_usd": 15, "currency": "USD"},
            "deadline": {
                "complete_by": "2026-01-15T18:00:00Z",
                "urgency": "medium"
            },
            "proof_required": ["photo", "gps_checkin"],
            "quality_sla": "medium"
        })
        print(result)

asyncio.run(dispatch_photo_task())
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `PORT` | `3000` | HTTP port (when TRANSPORT=http) |
| `MCP_AUTH_TOKEN` | — | Bearer token required on every `POST /mcp` request when `TRANSPORT=http`. The HTTP transport refuses to start if unset. |
| `MANUAL_WEBHOOK_URL` | — | Webhook URL for manual task notifications |
| `PROVIDERS_CONFIG` | — | JSON array of provider objects to pre-seed on startup |

## Security

This server processes outbound HTTP requests on behalf of its callers and is intended to run inside trusted infrastructure. The relevant guarantees:

- **HTTP transport requires authentication.** `MCP_AUTH_TOKEN` is mandatory; the server refuses to start without it. Bearer comparison is constant-time (`timingSafeEqual`).
- **DNS-rebinding protection** is enabled on `POST /mcp`. The transport rejects requests whose `Host` header points at anything other than the configured loopback.
- **Outbound URL guard.** Every webhook URL the server fetches (provider registration, `MANUAL_WEBHOOK_URL`, `callback_url`, proof URLs) goes through a structured validator: HTTPS only, no loopback, no RFC1918 / link-local / unique-local hosts, with a DNS resolution check at fetch time to defeat last-second rebinds. There is no opt-out — use a public tunnel (ngrok, cloudflared) for local testing.
- **Inbound callbacks are authenticated by HMAC, not by IP.** Each provider registers its own webhook secret. The server verifies `x-dispatch-signature` over the **raw request bytes** before parsing JSON. A per-provider token bucket limits callback flood (30 burst, 5/sec sustained).
- **Terminal-state guard.** Once a task reaches `completed`, `failed`, or `cancelled`, callbacks for that task are rejected with 409. This blocks replays, late provider retries, and provider-driven status flips.
- **Webhook payload versioning.** All outbound bodies carry `payload_version` and `event` discriminators. Pin your parser; reject unknown versions.
- **Webhook secrets never leave the server.** Provider data returned by MCP tools is sanitized to drop `webhook_secret`. The same field never appears in logs.
- **No persistence.** Tasks, providers, and per-task state live in memory. Restarting the server discards all state. If you operate this in production, terminate it cleanly so in-flight tasks fail fast rather than hang in providers.

If you discover a security issue, please open a private security advisory on GitHub rather than a public issue.

## Roadmap

- [ ] Persistent provider registry (SQLite / PostgreSQL)
- [ ] Task expiration and automatic retry
- [ ] Provider quality scoring and feedback loops
- [ ] Cost estimation before dispatch
- [ ] Batch task submission
- [ ] Provider dashboard / admin UI
- [ ] OAuth-based provider authentication

## Contributing

### Adding a New Backend Adapter

1. Create a new file in `src/services/backends/`
2. Extend `BaseBackendAdapter`
3. Implement all methods from `BackendAdapter` interface
4. Add the backend ID to the `BackendId` enum in `src/types.ts`
5. Register the adapter in `src/index.ts`

## License

MIT

# human-dispatch-mcp

**Plaid for human-in-the-loop** — A production-grade MCP server that lets any AI agent dispatch physical-world tasks to humans through a single unified API.

Routes tasks across multiple backends (Amazon Mechanical Turk, RentAHuman.ai, and a manual/webhook fallback) with smart selection, fallback chains, and proof-of-completion tracking.

## Quick Start

```bash
# Clone and install
git clone <repo-url>
cd human-dispatch-mcp
npm install

# Configure (optional — works out of the box with manual backend)
cp .env.example .env
# Edit .env to add API keys for MTurk / RentAHuman

# Build and run
npm run build
node dist/index.js
```

## MCP Client Configuration

### Claude Desktop / Cursor / Any MCP Client

Add to your MCP client config:

```json
{
  "mcpServers": {
    "human-dispatch": {
      "command": "npx",
      "args": ["human-dispatch-mcp"],
      "env": {
        "RENTAHUMAN_API_KEY": "your-key-here"
      }
    }
  }
}
```

### HTTP Transport

```json
{
  "mcpServers": {
    "human-dispatch": {
      "command": "npx",
      "args": ["human-dispatch-mcp"],
      "env": {
        "TRANSPORT": "http",
        "PORT": "3000"
      }
    }
  }
}
```

## Tools Reference

| Tool | Description |
|------|-------------|
| `human_dispatch_task` | Submit a task to be completed by a human worker via the best available backend |
| `human_get_task_status` | Poll the current status, worker info, and proof submissions for a task |
| `human_cancel_task` | Cancel a pending or in-progress task |
| `human_list_tasks` | List tasks with filters (status, backend, category) and pagination |
| `human_list_backends` | Show available backends, their configuration status, and capabilities |

## Architecture

```
┌─────────────┐
│   AI Agent   │
│ (Claude, etc)│
└──────┬───────┘
       │ MCP Protocol (stdio or HTTP)
       ▼
┌──────────────────────────────────┐
│     human-dispatch-mcp Server     │
│                                  │
│  ┌────────────┐  ┌────────────┐  │
│  │ Task Store │  │   Router   │  │
│  │ (in-memory)│  │  (scoring) │  │
│  └────────────┘  └─────┬──────┘  │
│                        │         │
│         ┌──────────────┼─────────┤
│         ▼              ▼         ▼
│  ┌───────────┐  ┌───────────┐  ┌────────┐
│  │   MTurk   │  │ RentAHuman│  │ Manual │
│  │  Adapter  │  │  Adapter  │  │Adapter │
│  │(simulated)│  │(simulated)│  │(active)│
│  └───────────┘  └───────────┘  └────────┘
└──────────────────────────────────┘
```

## Backend Adapters

| Backend | Status | Task Types | Regions | Budget Range |
|---------|--------|------------|---------|-------------|
| Amazon Mechanical Turk | Simulated | Digital | Global | $0.01 - $100 |
| RentAHuman.ai | Simulated | Physical | US | $5 - $500 |
| Manual / Webhook | Working | All | Global | $0 - $10,000 |

### Smart Routing

The router automatically picks the best backend based on:
1. **Agent preferences** — `preferred_backends` and `fallback_chain` are honored first
2. **Compatibility** — task type (physical/digital), location requirements, budget range
3. **Speed** — faster backends score higher
4. **Reliability** — real backends preferred over manual fallback

The `manual` backend is always available as the ultimate fallback.

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

        # Dispatch a task
        result = await client.call_tool("human_dispatch_task", {
            "description": "Take a photo of the menu board at Starbucks on 5th Ave, NYC",
            "category": "photo_video",
            "task_type": "physical",
            "location": {
                "address": "5th Ave & 42nd St, New York, NY"
            },
            "budget": {"max_usd": 15, "currency": "USD"},
            "deadline": {
                "complete_by": "2025-01-15T18:00:00Z",
                "urgency": "medium"
            },
            "proof_required": ["photo", "gps_checkin"],
            "quality_sla": "medium"
        })
        print(result)

        # Check status later
        status = await client.call_tool("human_get_task_status", {
            "task_id": "<task-id-from-above>"
        })
        print(status)

asyncio.run(dispatch_photo_task())
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `PORT` | `3000` | HTTP port (when TRANSPORT=http) |
| `MTURK_ACCESS_KEY_ID` | — | AWS access key for Mechanical Turk |
| `MTURK_SECRET_ACCESS_KEY` | — | AWS secret key for Mechanical Turk |
| `MTURK_SANDBOX` | `true` | Use MTurk sandbox environment |
| `RENTAHUMAN_API_KEY` | — | API key for RentAHuman.ai |
| `MANUAL_WEBHOOK_URL` | — | Webhook URL for manual task notifications |

## Roadmap

### Phase 2
- [ ] Real AWS Mechanical Turk API integration
- [ ] Real RentAHuman.ai API integration
- [ ] TaskRabbit adapter
- [ ] Webhook callback delivery for status updates
- [ ] Persistent storage (SQLite / PostgreSQL)
- [ ] Task expiration and automatic retry
- [ ] Worker quality scoring and feedback
- [ ] Cost estimation before dispatch
- [ ] Batch task submission

## Contributing

### Adding a New Backend Adapter

1. Create a new file in `src/services/backends/`
2. Extend `BaseBackendAdapter`
3. Implement all methods from `BackendAdapter` interface
4. Add the backend ID to the `BackendId` enum in `src/types.ts`
5. Register the adapter in `src/index.ts`

```typescript
import { BaseBackendAdapter } from "./base.js";
import { BackendCapabilities, BackendId, Task, BackendSubmitResult, BackendStatusResult } from "../../types.js";

export class MyNewAdapter extends BaseBackendAdapter {
  readonly id = BackendId.MY_NEW_BACKEND; // Add to enum first

  getCapabilities(): BackendCapabilities {
    return {
      id: this.id,
      name: "My New Backend",
      supports_physical: true,
      supports_digital: true,
      supports_location: true,
      available_regions: ["US", "EU"],
      min_budget_usd: 1,
      max_budget_usd: 1000,
      avg_completion_minutes: 60,
      requires_api_key: true,
      configured: this.isConfigured(),
    };
  }

  isConfigured(): boolean {
    return !!process.env["MY_BACKEND_API_KEY"];
  }

  async submitTask(task: Task): Promise<BackendSubmitResult> {
    // Your implementation here
  }

  // ... implement getStatus and cancelTask
}
```

## License

MIT

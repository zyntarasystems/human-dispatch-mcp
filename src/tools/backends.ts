import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BackendAdapter } from "../types.js";

export function registerBackendsTool(
  server: McpServer,
  adapters: BackendAdapter[],
): void {
  server.tool(
    "human_list_backends",
    `List all available backend services and their capabilities.

Shows which backends are configured (have API keys), what types of tasks they support, their regional availability, budget ranges, and average completion times.

Use this to understand what backends are available before dispatching a task, or to debug why a task was routed to a particular backend.

NO PARAMETERS REQUIRED.

RETURNS: Array of backend capabilities including:
- id: Backend identifier
- name: Human-readable name
- supports_physical/digital: What task types it handles
- supports_location: Whether it can handle location-specific tasks
- available_regions: Where it operates
- min/max_budget_usd: Budget range
- avg_completion_minutes: Typical turnaround time
- requires_api_key: Whether an API key is needed
- configured: Whether the API key is present and the backend is ready

EXAMPLES:
1. List all backends: {} (no parameters needed)

DON'T USE WHEN:
- You already know which backend to use (just set preferred_backends in human_dispatch_task)`,
    {},
    async () => {
      const backends = adapters.map(a => a.getCapabilities());

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ backends }, null, 2),
        }],
      };
    },
  );
}

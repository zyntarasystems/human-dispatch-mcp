import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ProviderRegistrationSchema,
  ProviderFilterSchema,
  ProviderIdSchema,
} from "../schemas/task.js";
import { ProviderRegistry } from "../services/providers/registry.js";
import { verifyProviderEndpoint } from "../services/providers/webhook.js";
import { TaskCategory, TaskType, WebhookProvider } from "../types.js";

function sanitizeProvider(provider: WebhookProvider): Omit<WebhookProvider, "webhook_secret"> & { webhook_secret?: undefined } {
  const { webhook_secret: _, ...safe } = provider;
  return safe;
}

export function registerProviderTools(
  server: McpServer,
  registry: ProviderRegistry,
): void {
  // ─── human_register_provider ────────────────────────────
  server.tool(
    "human_register_provider",
    `Register a new webhook provider to receive dispatched tasks.

Any service provider (law firm, VA agency, freelancer, etc.) can register their webhook endpoint to start receiving tasks that match their profile. The system will POST task payloads to the webhook URL, signed with HMAC-SHA256 using the shared secret.

PARAMETERS:
- name: Human-readable provider name (e.g. "Smith & Associates Law")
- webhook_url: HTTPS URL where tasks will be POSTed
- webhook_secret: Shared secret for HMAC-SHA256 webhook signatures (min 32 characters)
- categories: Task categories this provider handles (errand, photo_video, data_collection, verification, delivery, digital_micro, in_person, custom)
- task_types: Task types supported (physical, digital, hybrid)
- regions: Regions served (e.g. ["US", "EU", "*"] where * = global)
- min_budget_usd: Minimum task budget accepted (USD)
- max_budget_usd: Maximum task budget accepted (USD)
- max_concurrent_tasks: Max simultaneous tasks (default 10)

WEBHOOK FORMAT:
Tasks are POSTed with headers:
- x-dispatch-signature: sha256=<hmac_hex>
- X-Dispatch-Event: task.new | task.cancel | provider.verify
- X-Dispatch-TaskId: <task_uuid>

Expected response: { "accepted": true, "external_id": "your-id" } or { "accepted": false, "reason": "..." }`,
    ProviderRegistrationSchema.innerType().shape,
    async (params) => {
      const parsed = ProviderRegistrationSchema.parse(params);

      const provider = registry.registerProvider({
        name: parsed.name,
        webhook_url: parsed.webhook_url,
        webhook_secret: parsed.webhook_secret,
        categories: parsed.categories as TaskCategory[],
        task_types: parsed.task_types as TaskType[],
        regions: parsed.regions,
        min_budget_usd: parsed.min_budget_usd,
        max_budget_usd: parsed.max_budget_usd,
        max_concurrent_tasks: parsed.max_concurrent_tasks,
      });

      // Attempt verification ping
      let verificationStatus: "reachable" | "unreachable" | "skipped" = "skipped";
      try {
        const reachable = await verifyProviderEndpoint(provider);
        verificationStatus = reachable ? "reachable" : "unreachable";
      } catch {
        verificationStatus = "unreachable";
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            provider_id: provider.id,
            name: provider.name,
            status: "registered",
            verification_status: verificationStatus,
          }, null, 2),
        }],
      };
    },
  );

  // ─── human_list_providers ───────────────────────────────
  server.tool(
    "human_list_providers",
    `List all registered webhook providers with their stats.

Returns provider profiles including categories, regions, budget ranges, and performance stats (reliability score, completed/failed counts). Webhook secrets are never included in the output.

PARAMETERS:
- category: Optional — filter by supported task category
- region: Optional — filter by supported region
- active_only: Only show active providers (default true)`,
    ProviderFilterSchema.shape,
    async (params) => {
      const filters = ProviderFilterSchema.parse(params);

      const providers = registry.listProviders({
        category: filters.category as TaskCategory | undefined,
        region: filters.region,
        active_only: filters.active_only,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: providers.length,
            providers: providers.map(sanitizeProvider),
          }, null, 2),
        }],
      };
    },
  );

  // ─── human_remove_provider ──────────────────────────────
  server.tool(
    "human_remove_provider",
    `Remove a registered webhook provider.

Deregisters a provider so it will no longer receive dispatched tasks. Does not affect tasks already dispatched to this provider.

PARAMETERS:
- provider_id: The UUID of the provider to remove (as returned by human_register_provider)`,
    ProviderIdSchema.shape,
    async (params) => {
      const { provider_id } = ProviderIdSchema.parse(params);
      const removed = registry.removeProvider(provider_id);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ provider_id, removed }, null, 2),
        }],
        isError: !removed,
      };
    },
  );
}

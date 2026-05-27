import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Task,
  TaskCategory,
  WebhookProvider,
} from "../../types.js";
import { ProviderRegistrationSchema } from "../../schemas/task.js";
import { sanitizeForLog } from "../security/logging.js";
import { verifyProviderEndpoint } from "./webhook.js";

type RegisterProviderParams = z.infer<typeof ProviderRegistrationSchema>;
type ProviderVerifier = (provider: WebhookProvider) => Promise<boolean>;

// Match a task region against a provider's region list.
// "*" wildcards match anything. Comparisons are case-insensitive, and a
// broader provider region (e.g. "US") matches a more specific task region
// (e.g. "US-CA") via hyphen-bounded prefix match. The reverse does not match:
// a "US-CA"-only provider does not handle a generic "US" task.
function regionMatches(providerRegions: string[], taskRegion: string): boolean {
  const task = taskRegion.toLowerCase();
  for (const r of providerRegions) {
    if (r === "*") return true;
    const provider = r.toLowerCase();
    if (provider === task) return true;
    if (task.startsWith(provider + "-")) return true;
  }
  return false;
}

interface ProviderFilters {
  category?: TaskCategory;
  region?: string;
  active_only?: boolean;
}

export class ProviderRegistry {
  private static readonly MAX_PROVIDERS = 1000;
  private readonly providers = new Map<string, WebhookProvider>();

  registerProvider(
    params: RegisterProviderParams,
    options: { active?: boolean } = {},
  ): WebhookProvider {
    if (this.providers.size >= ProviderRegistry.MAX_PROVIDERS) {
      throw new Error(
        `Provider registry capacity exceeded (${ProviderRegistry.MAX_PROVIDERS}). ` +
        "Remove unused providers before registering new ones.",
      );
    }
    const provider: WebhookProvider = {
      id: randomUUID(),
      name: params.name,
      webhook_url: params.webhook_url,
      webhook_secret: params.webhook_secret,
      categories: params.categories,
      task_types: params.task_types,
      regions: params.regions,
      min_budget_usd: params.min_budget_usd,
      max_budget_usd: params.max_budget_usd,
      max_concurrent_tasks: params.max_concurrent_tasks,
      is_active: options.active ?? true,
      current_task_count: 0,
      stats: {
        completed_count: 0,
        failed_count: 0,
        reliability_score: 1,
        avg_completion_minutes: 60,
      },
      registered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    };

    this.providers.set(provider.id, provider);
    console.error(`[registry] Provider registered: ${sanitizeForLog(provider.name)} (${provider.id})`);
    return provider;
  }

  setProviderActive(id: string, active: boolean): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    provider.is_active = active;
    provider.last_seen_at = new Date().toISOString();
    console.error(`[registry] Provider ${id} active=${active}`);
    return true;
  }

  removeProvider(id: string): boolean {
    const existed = this.providers.delete(id);
    if (existed) {
      console.error(`[registry] Provider removed: ${id}`);
    }
    return existed;
  }

  getProvider(id: string): WebhookProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(filters?: ProviderFilters): WebhookProvider[] {
    let result = Array.from(this.providers.values());

    if (filters?.active_only !== false) {
      result = result.filter(p => p.is_active);
    }

    if (filters?.category) {
      const cat = filters.category;
      result = result.filter(p => p.categories.includes(cat));
    }

    if (filters?.region) {
      const region = filters.region;
      result = result.filter(p => regionMatches(p.regions, region));
    }

    return result;
  }

  findMatchingProviders(task: Task): WebhookProvider[] {
    const req = task.request;

    return Array.from(this.providers.values())
      .filter(p => {
        if (!p.is_active) return false;
        if (p.current_task_count >= p.max_concurrent_tasks) return false;
        if (!p.categories.includes(req.category)) return false;
        if (!p.task_types.includes(req.task_type)) return false;
        if (req.budget.max_usd < p.min_budget_usd) return false;
        if (req.budget.max_usd > p.max_budget_usd) return false;

        // Region matching: provider must serve the task's region or be global.
        // See regionMatches() for the case-insensitive prefix semantics.
        if (req.location?.region && !regionMatches(p.regions, req.location.region)) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        // Primary: reliability descending
        if (b.stats.reliability_score !== a.stats.reliability_score) {
          return b.stats.reliability_score - a.stats.reliability_score;
        }
        // Secondary: speed ascending
        return a.stats.avg_completion_minutes - b.stats.avg_completion_minutes;
      });
  }

  updateProviderStats(id: string, outcome: "completed" | "failed"): void {
    const provider = this.providers.get(id);
    if (!provider) return;

    if (outcome === "completed") {
      provider.stats.completed_count++;
    } else {
      provider.stats.failed_count++;
    }

    const total = provider.stats.completed_count + provider.stats.failed_count;
    provider.stats.reliability_score = total > 0
      ? provider.stats.completed_count / total
      : 1;

    provider.last_seen_at = new Date().toISOString();
  }

  tryReserveTaskSlot(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider || !provider.is_active) return false;
    if (provider.current_task_count >= provider.max_concurrent_tasks) return false;
    provider.current_task_count++;
    return true;
  }

  decrementTaskCount(id: string): void {
    const provider = this.providers.get(id);
    if (provider && provider.current_task_count > 0) {
      provider.current_task_count--;
    }
  }

  hasActiveProviders(): boolean {
    for (const p of this.providers.values()) {
      if (p.is_active) return true;
    }
    return false;
  }

  async seedFromEnv(verifier: ProviderVerifier = verifyProviderEndpoint): Promise<void> {
    const raw = process.env["PROVIDERS_CONFIG"];
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`[registry] Failed to parse PROVIDERS_CONFIG JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      console.error("[registry] PROVIDERS_CONFIG must be a JSON array");
      return;
    }

    let seeded = 0;
    let skipped = 0;
    for (const entry of parsed) {
      const result = ProviderRegistrationSchema.safeParse(entry);
      if (!result.success) {
        const name = (entry as { name?: unknown } | null)?.name;
        const issues = result.error.errors
          .map(e => `${e.path.join(".") || "<root>"}: ${e.message}`)
          .join("; ");
        console.error(`[registry] Skipping invalid provider config "${sanitizeForLog(name ?? "unknown")}": ${sanitizeForLog(issues)}`);
        skipped++;
        continue;
      }

      const provider = this.registerProvider(result.data, { active: false });
      let verified = false;
      try {
        verified = await verifier(provider);
      } catch {
        verified = false;
      }

      if (!verified) {
        this.removeProvider(provider.id);
        console.error(
          `[registry] Skipping provider config "${sanitizeForLog(provider.name)}" (${provider.id}): ` +
          "provider.verify did not return { verified: true }",
        );
        skipped++;
        continue;
      }

      this.setProviderActive(provider.id, true);
      seeded++;
    }

    console.error(`[registry] Seeded ${seeded} verified provider(s) from PROVIDERS_CONFIG; skipped ${skipped}`);
  }
}

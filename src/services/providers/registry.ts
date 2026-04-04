import { randomUUID } from "node:crypto";
import {
  Task,
  TaskCategory,
  TaskType,
  WebhookProvider,
} from "../../types.js";

interface RegisterProviderParams {
  name: string;
  webhook_url: string;
  webhook_secret: string;
  categories: TaskCategory[];
  task_types: TaskType[];
  regions: string[];
  min_budget_usd: number;
  max_budget_usd: number;
  max_concurrent_tasks: number;
}

interface ProviderFilters {
  category?: TaskCategory;
  region?: string;
  active_only?: boolean;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, WebhookProvider>();

  registerProvider(params: RegisterProviderParams): WebhookProvider {
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
      is_active: true,
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
    console.error(`[registry] Provider registered: ${provider.name} (${provider.id})`);
    return provider;
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
      result = result.filter(p =>
        p.regions.includes("*") || p.regions.includes(region),
      );
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

        // Region matching: provider must serve the task's region or be global
        if (req.location?.region) {
          const taskRegion = req.location.region;
          if (!p.regions.includes("*") && !p.regions.includes(taskRegion)) {
            return false;
          }
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

  incrementTaskCount(id: string): void {
    const provider = this.providers.get(id);
    if (provider) {
      provider.current_task_count++;
    }
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

  seedFromEnv(): void {
    const raw = process.env["PROVIDERS_CONFIG"];
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        console.error("[registry] PROVIDERS_CONFIG must be a JSON array");
        return;
      }

      let seeded = 0;
      for (const entry of parsed) {
        const config = entry as Record<string, unknown>;

        // Validate required fields and types
        if (
          typeof config["name"] !== "string" || !config["name"] ||
          typeof config["webhook_url"] !== "string" || !config["webhook_url"] ||
          typeof config["webhook_secret"] !== "string" || config["webhook_secret"].length < 32 ||
          !Array.isArray(config["categories"]) || config["categories"].length === 0 ||
          !Array.isArray(config["task_types"]) || config["task_types"].length === 0 ||
          !Array.isArray(config["regions"]) || config["regions"].length === 0
        ) {
          console.error(`[registry] Skipping invalid provider config: ${JSON.stringify(config["name"] ?? "unknown")}`);
          continue;
        }

        // Validate webhook_url is HTTPS
        try {
          const url = new URL(config["webhook_url"] as string);
          if (url.protocol !== "https:") {
            console.error(`[registry] Skipping provider "${config["name"]}": webhook_url must be HTTPS`);
            continue;
          }
        } catch {
          console.error(`[registry] Skipping provider "${config["name"]}": invalid webhook_url`);
          continue;
        }

        this.registerProvider({
          name: config["name"] as string,
          webhook_url: config["webhook_url"] as string,
          webhook_secret: config["webhook_secret"] as string,
          categories: config["categories"] as TaskCategory[],
          task_types: config["task_types"] as TaskType[],
          regions: config["regions"] as string[],
          min_budget_usd: typeof config["min_budget_usd"] === "number" ? config["min_budget_usd"] : 0,
          max_budget_usd: typeof config["max_budget_usd"] === "number" ? config["max_budget_usd"] : 10000,
          max_concurrent_tasks: typeof config["max_concurrent_tasks"] === "number" ? config["max_concurrent_tasks"] : 10,
        });
        seeded++;
      }

      console.error(`[registry] Seeded ${seeded} provider(s) from PROVIDERS_CONFIG`);
    } catch (err) {
      console.error(`[registry] Failed to parse PROVIDERS_CONFIG: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

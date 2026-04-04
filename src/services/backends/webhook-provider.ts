import {
  BackendCapabilities,
  BackendId,
  BackendStatusResult,
  BackendSubmitResult,
  Task,
  TaskStatus,
} from "../../types.js";
import { BaseBackendAdapter } from "./base.js";
import { ProviderRegistry } from "../providers/registry.js";
import { dispatchToProvider, dispatchCancelToProvider } from "../providers/webhook.js";

export class WebhookProviderAdapter extends BaseBackendAdapter {
  readonly id = BackendId.WEBHOOK_PROVIDER;

  // Maps backend_task_id (external_id from provider) → provider_id
  private readonly taskProviderMap = new Map<string, string>();
  // Status cache updated by callback handler
  private readonly taskStatusMap = new Map<string, BackendStatusResult>();

  constructor(private readonly registry: ProviderRegistry) {
    super();
  }

  getCapabilities(): BackendCapabilities {
    const providers = this.registry.listProviders({ active_only: true });

    let supportsPhysical = false;
    let supportsDigital = false;
    let supportsLocation = false;
    let minBudget = Infinity;
    let maxBudget = 0;

    for (const p of providers) {
      if (p.task_types.some(t => t === "physical" || t === "hybrid")) supportsPhysical = true;
      if (p.task_types.some(t => t === "digital" || t === "hybrid")) supportsDigital = true;
      if (p.regions.length > 0) supportsLocation = true;
      if (p.min_budget_usd < minBudget) minBudget = p.min_budget_usd;
      if (p.max_budget_usd > maxBudget) maxBudget = p.max_budget_usd;
    }

    return {
      id: BackendId.WEBHOOK_PROVIDER,
      name: "Webhook Providers",
      supports_physical: supportsPhysical,
      supports_digital: supportsDigital,
      supports_location: supportsLocation,
      available_regions: ["*"],
      min_budget_usd: minBudget === Infinity ? 0 : minBudget,
      max_budget_usd: maxBudget === 0 ? 10000 : maxBudget,
      avg_completion_minutes: 60,
      requires_api_key: false,
      configured: this.registry.hasActiveProviders(),
    };
  }

  isConfigured(): boolean {
    return this.registry.hasActiveProviders();
  }

  async submitTask(task: Task): Promise<BackendSubmitResult> {
    const candidates = this.registry.findMatchingProviders(task);

    if (candidates.length === 0) {
      throw this.wrapError("submitTask", "No matching providers found");
    }

    const errors: string[] = [];

    for (const provider of candidates) {
      this.log(`Trying provider ${provider.name} (${provider.id})`);

      const result = await dispatchToProvider(provider, task);

      if (result.accepted && result.external_id) {
        this.taskProviderMap.set(result.external_id, provider.id);
        this.taskStatusMap.set(result.external_id, { status: TaskStatus.ROUTED });
        this.registry.incrementTaskCount(provider.id);

        this.log(`Task ${task.id} accepted by ${provider.name} (external_id: ${result.external_id})`);
        return { backend_task_id: result.external_id };
      }

      const reason = result.reason ?? "rejected";
      errors.push(`${provider.name}: ${reason}`);
      this.log(`Provider ${provider.name} did not accept: ${reason}`);
    }

    throw this.wrapError(
      "submitTask",
      `All ${candidates.length} provider(s) rejected the task: ${errors.join("; ")}`,
    );
  }

  async getStatus(backend_task_id: string): Promise<BackendStatusResult> {
    return this.taskStatusMap.get(backend_task_id) ?? { status: TaskStatus.ROUTED };
  }

  async cancelTask(backend_task_id: string): Promise<boolean> {
    const providerId = this.taskProviderMap.get(backend_task_id);
    if (!providerId) {
      this.log(`Cannot cancel — no provider mapped for ${backend_task_id}`);
      return false;
    }

    const provider = this.registry.getProvider(providerId);
    if (!provider) {
      this.log(`Cannot cancel — provider ${providerId} not found`);
      return false;
    }

    // We don't have the original task ID here, use backend_task_id as reference
    const cancelled = await dispatchCancelToProvider(provider, backend_task_id, backend_task_id);

    if (cancelled) {
      this.taskStatusMap.set(backend_task_id, { status: TaskStatus.CANCELLED });
      this.registry.decrementTaskCount(providerId);
    }

    return cancelled;
  }

  updateTaskStatus(backendTaskId: string, status: BackendStatusResult): void {
    this.taskStatusMap.set(backendTaskId, status);

    // Decrement active task count on terminal states
    if (status.status === TaskStatus.COMPLETED || status.status === TaskStatus.FAILED) {
      const providerId = this.taskProviderMap.get(backendTaskId);
      if (providerId) {
        this.registry.decrementTaskCount(providerId);
      }
    }
  }

  getProviderIdForTask(backendTaskId: string): string | undefined {
    return this.taskProviderMap.get(backendTaskId);
  }
}

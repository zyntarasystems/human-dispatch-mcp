import {
  BackendCapabilities,
  BackendId,
  BackendStatusResult,
  BackendSubmitResult,
  Task,
  TaskCategory,
  TaskStatus,
  WebhookDispatchResult,
} from "../../types.js";

const LOCATION_CATEGORIES: ReadonlySet<TaskCategory> = new Set([
  TaskCategory.ERRAND,
  TaskCategory.PHOTO_VIDEO,
  TaskCategory.DELIVERY,
  TaskCategory.IN_PERSON,
]);
import { BaseBackendAdapter } from "./base.js";
import { MAX_PROVIDER_CANDIDATES } from "../../constants.js";
import { ProviderRegistry } from "../providers/registry.js";
import { dispatchToProvider, dispatchCancelToProvider } from "../providers/webhook.js";
import { sanitizeForLog } from "../security/logging.js";
import { sanitizeErrorMessage } from "../security/url-guard.js";

type ProviderDispatch = typeof dispatchToProvider;
type ProviderCancelDispatch = typeof dispatchCancelToProvider;

export class WebhookProviderAdapter extends BaseBackendAdapter {
  readonly id = BackendId.WEBHOOK_PROVIDER;

  // Maps backend_task_id (external_id from provider) → provider_id
  private readonly taskProviderMap = new Map<string, string>();
  // Status cache updated by callback handler
  private readonly taskStatusMap = new Map<string, BackendStatusResult>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly providerDispatch: ProviderDispatch = dispatchToProvider,
    private readonly providerCancelDispatch: ProviderCancelDispatch = dispatchCancelToProvider,
  ) {
    super();
  }

  getCapabilities(): BackendCapabilities {
    const providers = this.registry.listProviders({ active_only: true });

    let supportsPhysical = false;
    let supportsDigital = false;
    let supportsLocation = false;
    let minBudget = Infinity;
    let maxBudget = 0;
    let minCompletionMinutes = Infinity;

    for (const p of providers) {
      if (p.task_types.some(t => t === "physical" || t === "hybrid")) supportsPhysical = true;
      if (p.task_types.some(t => t === "digital" || t === "hybrid")) supportsDigital = true;
      // Location support is a category property, not a regions property — every
      // provider has at least one region (schema min(1)) so the old
      // regions.length>0 check was always true and skipped the routing
      // location-penalty for providers that can't actually do location work.
      if (p.categories.some(c => LOCATION_CATEGORIES.has(c as TaskCategory))) supportsLocation = true;
      if (p.min_budget_usd < minBudget) minBudget = p.min_budget_usd;
      if (p.max_budget_usd > maxBudget) maxBudget = p.max_budget_usd;
      if (p.stats.avg_completion_minutes < minCompletionMinutes) {
        minCompletionMinutes = p.stats.avg_completion_minutes;
      }
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
      // Use the fastest provider's average as the backend's headline metric
      // for routing comparisons. Falls back to the previous default of 60
      // when there are no providers yet.
      avg_completion_minutes: minCompletionMinutes === Infinity ? 60 : minCompletionMinutes,
      requires_api_key: false,
      configured: this.registry.hasActiveProviders(),
    };
  }

  isConfigured(): boolean {
    return this.registry.hasActiveProviders();
  }

  async submitTask(task: Task): Promise<BackendSubmitResult> {
    const allCandidates = this.registry.findMatchingProviders(task);

    if (allCandidates.length === 0) {
      throw this.wrapError("submitTask", "No matching providers found");
    }

    // Cap the candidate walk so a misconfigured registry can't pin the
    // dispatch loop to N * WEBHOOK_TIMEOUT_MS. Already sorted by reliability
    // and speed, so we keep the strongest few.
    const candidates = allCandidates.slice(0, MAX_PROVIDER_CANDIDATES);
    const errors: string[] = [];

    for (const provider of candidates) {
      const providerName = sanitizeForLog(provider.name);
      this.log(`Trying provider ${providerName} (${provider.id})`);

      if (!this.registry.tryReserveTaskSlot(provider.id)) {
        const reason = "provider capacity unavailable";
        errors.push(`${providerName}: ${reason}`);
        this.log(`Provider ${providerName} did not accept: ${reason}`);
        continue;
      }

      const result = await this.providerDispatch(provider, task).catch((err: unknown): WebhookDispatchResult => {
        return { accepted: false, reason: sanitizeErrorMessage(err) };
      });

      if (result.accepted && result.external_id) {
        this.taskProviderMap.set(result.external_id, provider.id);
        this.taskStatusMap.set(result.external_id, { status: TaskStatus.ROUTED });

        this.log(`Task ${task.id} accepted by ${providerName} (external_id: ${sanitizeForLog(result.external_id)})`);
        return { backend_task_id: result.external_id };
      }

      this.registry.decrementTaskCount(provider.id);
      const reason = sanitizeForLog(result.reason ?? "rejected");
      errors.push(`${providerName}: ${reason}`);
      this.log(`Provider ${providerName} did not accept: ${reason}`);
    }

    throw this.wrapError(
      "submitTask",
      `All ${candidates.length} provider(s) rejected the task: ${errors.join("; ")}`,
    );
  }

  async getStatus(backend_task_id: string): Promise<BackendStatusResult> {
    return this.taskStatusMap.get(backend_task_id) ?? { status: TaskStatus.ROUTED };
  }

  async cancelTask(task_id: string, backend_task_id: string): Promise<boolean> {
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

    const cancelled = await this.providerCancelDispatch(provider, task_id, backend_task_id);

    if (cancelled) {
      this.registry.decrementTaskCount(providerId);
      // Free per-task state once the task is terminal. Subsequent callbacks
      // for this backend_task_id will not find an owner mapping and will be
      // rejected by the callback handler's terminal-state check (which runs
      // before the ownership check). Dropping the entry also makes the
      // decrement idempotent: a second cancel finds no providerId and skips.
      this.taskProviderMap.delete(backend_task_id);
      this.taskStatusMap.delete(backend_task_id);
    }

    return cancelled;
  }

  updateTaskStatus(backendTaskId: string, status: BackendStatusResult): void {
    this.taskStatusMap.set(backendTaskId, status);

    // Decrement active task count on terminal states, then drop per-task
    // state. Idempotent by construction: after the delete, a second call for
    // the same backendTaskId finds no providerId and the decrement is skipped.
    if (status.status === TaskStatus.COMPLETED || status.status === TaskStatus.FAILED) {
      const providerId = this.taskProviderMap.get(backendTaskId);
      if (providerId) {
        this.registry.decrementTaskCount(providerId);
        this.taskProviderMap.delete(backendTaskId);
        this.taskStatusMap.delete(backendTaskId);
      }
    }
  }

  getProviderIdForTask(backendTaskId: string): string | undefined {
    return this.taskProviderMap.get(backendTaskId);
  }
}

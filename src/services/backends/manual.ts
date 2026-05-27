import { randomUUID } from "node:crypto";
import {
  BackendCapabilities,
  BackendId,
  BackendStatusResult,
  BackendSubmitResult,
  Task,
  TaskStatus,
} from "../../types.js";
import { WEBHOOK_TIMEOUT_MS } from "../../constants.js";
import { BaseBackendAdapter } from "./base.js";
import { assertPublicHttpsUrl, safeFetch, sanitizeErrorMessage } from "../security/url-guard.js";

export class ManualAdapter extends BaseBackendAdapter {
  readonly id = BackendId.MANUAL;

  private readonly webhookUrl: string | undefined;
  private readonly taskStatuses = new Map<string, TaskStatus>();

  constructor() {
    super();
    const raw = process.env["MANUAL_WEBHOOK_URL"];
    if (raw) {
      try {
        assertPublicHttpsUrl(raw);
        this.webhookUrl = raw;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[manual] MANUAL_WEBHOOK_URL rejected: ${reason}`);
      }
    }
  }

  getCapabilities(): BackendCapabilities {
    return {
      id: BackendId.MANUAL,
      name: "Manual / Webhook Fallback",
      supports_physical: true,
      supports_digital: true,
      supports_location: true,
      available_regions: ["global"],
      min_budget_usd: 0,
      max_budget_usd: 10000,
      avg_completion_minutes: 1440,
      requires_api_key: false,
      configured: true,
    };
  }

  isConfigured(): boolean {
    return true;
  }

  async submitTask(task: Task): Promise<BackendSubmitResult> {
    const manualId = `MANUAL-${randomUUID()}`;
    this.taskStatuses.set(manualId, TaskStatus.PENDING);

    if (this.webhookUrl) {
      const body = JSON.stringify({
        manual_task_id: manualId,
        task_id: task.id,
        description: task.request.description,
        category: task.request.category,
        task_type: task.request.task_type,
        location: task.request.location ?? null,
        budget: task.request.budget,
        deadline: task.request.deadline,
        proof_required: task.request.proof_required,
        quality_sla: task.request.quality_sla,
        metadata: task.request.metadata,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const response = await safeFetch(this.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          this.log(`Manual webhook returned HTTP ${response.status} for task ${task.id}`);
        }
      } catch (err) {
        this.log(`Manual webhook failed for task ${task.id}: ${sanitizeErrorMessage(err)}`);
      } finally {
        clearTimeout(timeout);
      }
    } else {
      this.log(
        `Task ${task.id} created as manual task ${manualId}. ` +
        `No webhook URL configured — task awaits manual completion via status polling.`,
      );
    }

    return { backend_task_id: manualId };
  }

  async getStatus(backend_task_id: string): Promise<BackendStatusResult> {
    const status = this.taskStatuses.get(backend_task_id);
    if (status === undefined) {
      throw this.wrapError("getStatus", `Manual task ${backend_task_id} not found`);
    }

    return { status };
  }

  async cancelTask(_task_id: string, backend_task_id: string): Promise<boolean> {
    const status = this.taskStatuses.get(backend_task_id);
    if (status === undefined) {
      this.log(`Cannot cancel — manual task ${backend_task_id} not found`);
      return false;
    }

    this.taskStatuses.set(backend_task_id, TaskStatus.CANCELLED);
    this.log(`Cancelled manual task ${backend_task_id}`);
    return true;
  }
}

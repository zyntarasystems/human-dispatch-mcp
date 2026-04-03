import { randomUUID } from "node:crypto";
import {
  BackendCapabilities,
  BackendId,
  BackendStatusResult,
  BackendSubmitResult,
  Task,
  TaskStatus,
} from "../../types.js";
import { BaseBackendAdapter } from "./base.js";

export class ManualAdapter extends BaseBackendAdapter {
  readonly id = BackendId.MANUAL;

  private readonly webhookUrl: string | undefined;
  private readonly taskStatuses = new Map<string, TaskStatus>();

  constructor() {
    super();
    this.webhookUrl = process.env["MANUAL_WEBHOOK_URL"];
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
      this.log(
        `Would send webhook to ${this.webhookUrl} with task ${task.id}: ${JSON.stringify({
          manual_task_id: manualId,
          description: task.request.description,
          category: task.request.category,
          budget: task.request.budget,
          deadline: task.request.deadline,
        })}`,
      );
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

  async cancelTask(backend_task_id: string): Promise<boolean> {
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

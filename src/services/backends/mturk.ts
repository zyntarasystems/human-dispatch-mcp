import { randomUUID } from "node:crypto";
import {
  BackendCapabilities,
  BackendId,
  BackendStatusResult,
  BackendSubmitResult,
  ProofType,
  Task,
  TaskStatus,
} from "../../types.js";
import { BaseBackendAdapter } from "./base.js";

// TODO: Replace with real AWS MTurk SDK calls
// import { MTurkClient, CreateHITCommand } from "@aws-sdk/client-mturk";

interface SimulatedHIT {
  hit_id: string;
  task_id: string;
  status: TaskStatus;
  created_at: number;
  cancelled: boolean;
}

export class MTurkAdapter extends BaseBackendAdapter {
  readonly id = BackendId.MTURK;

  private readonly accessKeyId: string | undefined;
  private readonly secretAccessKey: string | undefined;
  private readonly sandbox: boolean;
  private readonly simulatedHITs = new Map<string, SimulatedHIT>();

  constructor() {
    super();
    this.accessKeyId = process.env["MTURK_ACCESS_KEY_ID"];
    this.secretAccessKey = process.env["MTURK_SECRET_ACCESS_KEY"];
    const sandboxEnv = process.env["MTURK_SANDBOX"];
    if (sandboxEnv !== undefined && sandboxEnv !== "true" && sandboxEnv !== "false") {
      console.error(`[warn] MTURK_SANDBOX="${sandboxEnv}" is not "true" or "false" — defaulting to sandbox mode`);
    }
    this.sandbox = sandboxEnv !== "false";
  }

  getCapabilities(): BackendCapabilities {
    return {
      id: BackendId.MTURK,
      name: "Amazon Mechanical Turk",
      supports_physical: false,
      supports_digital: true,
      supports_location: false,
      available_regions: ["global"],
      min_budget_usd: 0.01,
      max_budget_usd: 100,
      avg_completion_minutes: 30,
      requires_api_key: true,
      configured: this.isConfigured(),
    };
  }

  isConfigured(): boolean {
    return !!(this.accessKeyId && this.secretAccessKey);
  }

  async submitTask(task: Task): Promise<BackendSubmitResult> {
    this.log(`Submitting task ${task.id} (simulated)`);

    // TODO: Replace with real AWS MTurk SDK calls
    // const client = new MTurkClient({
    //   region: "us-east-1",
    //   credentials: {
    //     accessKeyId: this.accessKeyId!,
    //     secretAccessKey: this.secretAccessKey!,
    //   },
    //   endpoint: this.sandbox
    //     ? "https://mturk-requester-sandbox.us-east-1.amazonaws.com"
    //     : undefined,
    // });
    //
    // const command = new CreateHITCommand({
    //   Title: task.request.description.slice(0, 128),
    //   Description: task.request.description,
    //   Reward: String(task.request.budget.max_usd),
    //   MaxAssignments: 1,
    //   LifetimeInSeconds: 86400,
    //   AssignmentDurationInSeconds: 3600,
    //   Question: `<ExternalQuestion xmlns="..."><ExternalURL>...</ExternalURL><FrameHeight>600</FrameHeight></ExternalQuestion>`,
    // });
    //
    // const response = await client.send(command);
    // return { backend_task_id: response.HIT!.HITId! };

    const hitId = `HIT-${randomUUID()}`;
    this.simulatedHITs.set(hitId, {
      hit_id: hitId,
      task_id: task.id,
      status: TaskStatus.ROUTED,
      created_at: Date.now(),
      cancelled: false,
    });

    return { backend_task_id: hitId };
  }

  async getStatus(backend_task_id: string): Promise<BackendStatusResult> {
    const hit = this.simulatedHITs.get(backend_task_id);
    if (!hit) {
      throw this.wrapError("getStatus", `HIT ${backend_task_id} not found`);
    }

    if (hit.cancelled) {
      return { status: TaskStatus.CANCELLED };
    }

    // Simulate progression: ROUTED → ASSIGNED → COMPLETED over time
    const elapsed = Date.now() - hit.created_at;
    if (elapsed > 10000) {
      hit.status = TaskStatus.COMPLETED;
      return {
        status: TaskStatus.COMPLETED,
        worker_id: "A2SIMULATED_WORKER",
        proof: [{
          type: ProofType.TEXT_REPORT,
          text: "Simulated MTurk task completion — this is a placeholder proof submission.",
          submitted_at: new Date().toISOString(),
        }],
        cost_usd: 0.50,
      };
    } else if (elapsed > 5000) {
      hit.status = TaskStatus.ASSIGNED;
      return {
        status: TaskStatus.ASSIGNED,
        worker_id: "A2SIMULATED_WORKER",
      };
    }

    return { status: TaskStatus.ROUTED };
  }

  async cancelTask(backend_task_id: string): Promise<boolean> {
    const hit = this.simulatedHITs.get(backend_task_id);
    if (!hit) {
      this.log(`Cannot cancel — HIT ${backend_task_id} not found`);
      return false;
    }

    if (hit.status === TaskStatus.COMPLETED) {
      this.log(`Cannot cancel — HIT ${backend_task_id} already completed`);
      return false;
    }

    hit.cancelled = true;
    hit.status = TaskStatus.CANCELLED;
    this.log(`Cancelled HIT ${backend_task_id} (simulated)`);
    return true;
  }
}

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

// TODO: Replace with real RentAHuman.ai API calls

interface SimulatedRentAHumanTask {
  rah_id: string;
  task_id: string;
  status: TaskStatus;
  created_at: number;
  cancelled: boolean;
}

export class RentAHumanAdapter extends BaseBackendAdapter {
  readonly id = BackendId.RENTAHUMAN;

  private readonly apiKey: string | undefined;
  private readonly simulatedTasks = new Map<string, SimulatedRentAHumanTask>();

  constructor() {
    super();
    this.apiKey = process.env["RENTAHUMAN_API_KEY"];
  }

  getCapabilities(): BackendCapabilities {
    return {
      id: BackendId.RENTAHUMAN,
      name: "RentAHuman.ai",
      supports_physical: true,
      supports_digital: false,
      supports_location: true,
      available_regions: ["US"],
      min_budget_usd: 5,
      max_budget_usd: 500,
      avg_completion_minutes: 120,
      requires_api_key: true,
      configured: this.isConfigured(),
    };
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async submitTask(task: Task): Promise<BackendSubmitResult> {
    this.log(`Submitting task ${task.id} (simulated)`);

    // TODO: Replace with real RentAHuman.ai API calls
    // const response = await fetch("https://api.rentahuman.ai/api/tasks", {
    //   method: "POST",
    //   headers: {
    //     "Authorization": `Bearer ${this.apiKey}`,
    //     "Content-Type": "application/json",
    //   },
    //   body: JSON.stringify({
    //     title: task.request.description.slice(0, 200),
    //     description: task.request.description,
    //     category: task.request.category,
    //     location: task.request.location ? {
    //       address: task.request.location.address,
    //       lat: task.request.location.latitude,
    //       lng: task.request.location.longitude,
    //       radius_km: task.request.location.radius_km,
    //     } : undefined,
    //     budget_usd: task.request.budget.max_usd,
    //     deadline: task.request.deadline.complete_by,
    //     proof_types: task.request.proof_required,
    //   }),
    // });
    //
    // if (!response.ok) {
    //   throw new Error(`RentAHuman API error: ${response.status} ${await response.text()}`);
    // }
    //
    // const data = await response.json();
    // return { backend_task_id: data.task_id };

    const rahId = `RAH-${randomUUID()}`;
    this.simulatedTasks.set(rahId, {
      rah_id: rahId,
      task_id: task.id,
      status: TaskStatus.ROUTED,
      created_at: Date.now(),
      cancelled: false,
    });

    return { backend_task_id: rahId };
  }

  async getStatus(backend_task_id: string): Promise<BackendStatusResult> {
    const simTask = this.simulatedTasks.get(backend_task_id);
    if (!simTask) {
      throw this.wrapError("getStatus", `Task ${backend_task_id} not found`);
    }

    if (simTask.cancelled) {
      return { status: TaskStatus.CANCELLED };
    }

    // Simulate progression over time
    const elapsed = Date.now() - simTask.created_at;
    if (elapsed > 20000) {
      simTask.status = TaskStatus.COMPLETED;
      return {
        status: TaskStatus.COMPLETED,
        worker_id: "RAH-WORKER-42",
        proof: [{
          type: ProofType.PHOTO,
          url: "https://simulated.rentahuman.ai/proof/photo-placeholder.jpg",
          submitted_at: new Date().toISOString(),
        }, {
          type: ProofType.GPS_CHECKIN,
          text: "Simulated GPS check-in at task location",
          submitted_at: new Date().toISOString(),
        }],
        cost_usd: 25.00,
      };
    } else if (elapsed > 10000) {
      simTask.status = TaskStatus.IN_PROGRESS;
      return {
        status: TaskStatus.IN_PROGRESS,
        worker_id: "RAH-WORKER-42",
      };
    } else if (elapsed > 5000) {
      simTask.status = TaskStatus.ASSIGNED;
      return {
        status: TaskStatus.ASSIGNED,
        worker_id: "RAH-WORKER-42",
      };
    }

    return { status: TaskStatus.ROUTED };
  }

  async cancelTask(backend_task_id: string): Promise<boolean> {
    const simTask = this.simulatedTasks.get(backend_task_id);
    if (!simTask) {
      this.log(`Cannot cancel — task ${backend_task_id} not found`);
      return false;
    }

    if (simTask.status === TaskStatus.COMPLETED) {
      this.log(`Cannot cancel — task ${backend_task_id} already completed`);
      return false;
    }

    simTask.cancelled = true;
    simTask.status = TaskStatus.CANCELLED;
    this.log(`Cancelled task ${backend_task_id} (simulated)`);
    return true;
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskRequestSchema } from "../schemas/task.js";
import { TaskStore } from "../services/task-store.js";
import { Router } from "../services/router.js";
import { TaskRequest, TaskStatus } from "../types.js";

export function registerDispatchTool(
  server: McpServer,
  taskStore: TaskStore,
  router: Router,
): void {
  server.tool(
    "human_dispatch_task",
    `Dispatch a task to a human worker via the best available backend service.

This is the primary tool for sending work to humans. You describe what needs to be done, and the system routes it to the most appropriate backend (Amazon Mechanical Turk for digital microtasks, RentAHuman.ai for physical/local tasks, or a manual fallback).

PARAMETERS:
- description: What the human should do. Be specific about location, timing, and deliverables.
- category: Task category (errand, photo_video, data_collection, verification, delivery, digital_micro, in_person, custom)
- task_type: physical (requires presence), digital (remote), or hybrid (both)
- location: Where to perform the task (required for physical tasks). Include address or coordinates.
- budget: Maximum USD to pay. Different backends have different ranges.
- deadline: When it must be done, with urgency level.
- proof_required: What evidence the worker must submit (photo, video, gps_checkin, text_report, receipt, signature).
- quality_sla: low (fast/cheap), medium (default), high (verified workers, multiple proofs).
- preferred_backends: Optional ordered list of backends to try first.
- fallback_chain: Optional ordered fallback list if preferred backends fail.
- callback_url: Optional webhook URL for status notifications.
- metadata: Optional key-value pairs for your own tracking.

EXAMPLES:
1. Photo task: { description: "Take a photo of the menu board at the Starbucks on 5th Ave and 42nd St, NYC", category: "photo_video", task_type: "physical", location: { address: "5th Ave & 42nd St, New York, NY" }, budget: { max_usd: 15, currency: "USD" }, deadline: { complete_by: "2025-01-15T18:00:00Z", urgency: "medium" }, proof_required: ["photo", "gps_checkin"], quality_sla: "medium" }

2. Data collection: { description: "Count the number of electric vehicle charging stations within 1km of Times Square", category: "data_collection", task_type: "physical", location: { address: "Times Square, NYC", radius_km: 1 }, budget: { max_usd: 25, currency: "USD" }, deadline: { complete_by: "2025-01-20T00:00:00Z", urgency: "low" }, proof_required: ["text_report", "photo"], quality_sla: "high" }

3. Digital microtask: { description: "Transcribe the handwritten text in the attached image to typed text", category: "digital_micro", task_type: "digital", budget: { max_usd: 2, currency: "USD" }, deadline: { complete_by: "2025-01-16T00:00:00Z", urgency: "medium" }, proof_required: ["text_report"], quality_sla: "low" }

DON'T USE WHEN:
- The task can be done by an AI (use an AI tool instead)
- You need instant results (humans take minutes to hours)
- The task requires specialized professional credentials not covered by the backends`,
    TaskRequestSchema.shape,
    async (params) => {
      const parsed = TaskRequestSchema.parse(params);
      // Zod infers string literal unions; cast to TaskRequest since values are identical
      const request = parsed as unknown as TaskRequest;
      const task = taskStore.createTask(request);
      const routed = await router.route(task);

      const response = {
        task_id: routed.id,
        status: routed.status,
        backend_id: routed.backend_id,
        estimated_completion_minutes: routed.backend_id === "mturk" ? 30
          : routed.backend_id === "rentahuman" ? 120
          : 1440,
        estimated_cost_usd: routed.request.budget.max_usd,
        error: routed.error,
      };

      if (routed.status === TaskStatus.FAILED) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(response, null, 2),
        }],
      };
    },
  );
}

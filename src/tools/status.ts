import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskIdSchema } from "../schemas/task.js";
import { TaskStore } from "../services/task-store.js";
import { BackendAdapter, BackendId, TaskStatus } from "../types.js";

export function registerStatusTool(
  server: McpServer,
  taskStore: TaskStore,
  adapters: Map<BackendId, BackendAdapter>,
): void {
  server.tool(
    "human_get_task_status",
    `Get the current status of a previously dispatched human task.

Returns the full task state including: current status, which backend is handling it, worker info (if assigned), proof submissions (if any), actual cost, and timing info.

If the task has been routed to a backend, this tool fetches fresh status from that backend and merges any new data (worker assignment, proof uploads, completion).

PARAMETERS:
- task_id: The UUID returned by human_dispatch_task.

RETURNS: Full task object with status, backend_id, worker_id, proof array, cost, timestamps, and routing attempts.

EXAMPLES:
1. Check on a task: { task_id: "550e8400-e29b-41d4-a716-446655440000" }

DON'T USE WHEN:
- You don't have a task_id (use human_list_tasks to find tasks)
- You want to check all tasks at once (use human_list_tasks instead)`,
    TaskIdSchema.shape,
    async (params) => {
      const { task_id } = TaskIdSchema.parse(params);
      const task = taskStore.getTask(task_id);

      if (!task) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Task ${task_id} not found. Use human_list_tasks to see available tasks.`,
            }),
          }],
          isError: true,
        };
      }

      // If routed to a backend, fetch fresh status
      if (task.backend_id && task.backend_task_id) {
        const adapter = adapters.get(task.backend_id);
        if (adapter) {
          try {
            const backendStatus = await adapter.getStatus(task.backend_task_id);

            const updates: Record<string, unknown> = {
              status: backendStatus.status,
            };

            if (backendStatus.worker_id) {
              updates["worker_id"] = backendStatus.worker_id;
            }
            if (backendStatus.proof && backendStatus.proof.length > 0) {
              updates["proof"] = backendStatus.proof;
            }
            if (backendStatus.cost_usd !== undefined) {
              updates["cost_usd"] = backendStatus.cost_usd;
            }
            if (backendStatus.status === TaskStatus.COMPLETED) {
              updates["completed_at"] = new Date().toISOString();
            }

            const updated = taskStore.updateTask(task_id, updates);
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify(updated, null, 2),
              }],
            };
          } catch (err) {
            console.error(`[status] Error fetching backend status: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(task, null, 2),
        }],
      };
    },
  );
}

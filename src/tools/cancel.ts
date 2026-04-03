import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskIdSchema } from "../schemas/task.js";
import { TaskStore } from "../services/task-store.js";
import { BackendAdapter, BackendId, TaskStatus } from "../types.js";

export function registerCancelTool(
  server: McpServer,
  taskStore: TaskStore,
  adapters: Map<BackendId, BackendAdapter>,
): void {
  server.tool(
    "human_cancel_task",
    `Cancel a pending or in-progress human task.

Attempts to cancel the task both in the local system and on the backend service. Cancellation may not be possible if the task is already completed.

PARAMETERS:
- task_id: The UUID of the task to cancel.

RETURNS: { task_id, cancelled: boolean, message: string }

EXAMPLES:
1. Cancel a task: { task_id: "550e8400-e29b-41d4-a716-446655440000" }

DON'T USE WHEN:
- The task is already completed (check status first with human_get_task_status)
- You want to modify a task (cancellation is permanent — dispatch a new task instead)`,
    TaskIdSchema.shape,
    async (params) => {
      const { task_id } = TaskIdSchema.parse(params);
      const task = taskStore.getTask(task_id);

      if (!task) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task_id,
              cancelled: false,
              message: `Task ${task_id} not found. Use human_list_tasks to see available tasks.`,
            }),
          }],
          isError: true,
        };
      }

      if (task.status === TaskStatus.COMPLETED) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task_id,
              cancelled: false,
              message: "Task is already completed and cannot be cancelled.",
            }),
          }],
        };
      }

      if (task.status === TaskStatus.CANCELLED) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task_id,
              cancelled: true,
              message: "Task was already cancelled.",
            }),
          }],
        };
      }

      // Try to cancel on the backend
      let backendCancelled = true;
      if (task.backend_id && task.backend_task_id) {
        const adapter = adapters.get(task.backend_id);
        if (adapter) {
          try {
            backendCancelled = await adapter.cancelTask(task.backend_task_id);
          } catch (err) {
            console.error(`[cancel] Backend cancel failed: ${err instanceof Error ? err.message : String(err)}`);
            backendCancelled = false;
          }
        }
      }

      if (backendCancelled) {
        taskStore.updateTask(task_id, { status: TaskStatus.CANCELLED });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task_id,
              cancelled: true,
              message: "Task successfully cancelled.",
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            task_id,
            cancelled: false,
            message: "Backend could not cancel the task. It may be too far along to cancel. Check status with human_get_task_status.",
          }),
        }],
      };
    },
  );
}

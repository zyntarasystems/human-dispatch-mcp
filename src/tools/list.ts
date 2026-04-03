import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskFilterSchema } from "../schemas/task.js";
import { TaskStore } from "../services/task-store.js";
import { BackendId, TaskCategory, TaskStatus } from "../types.js";

export function registerListTool(
  server: McpServer,
  taskStore: TaskStore,
): void {
  server.tool(
    "human_list_tasks",
    `List all dispatched human tasks with optional filters and pagination.

Returns tasks sorted by creation time (newest first). Use filters to narrow results by status, backend, or category.

PARAMETERS:
- status: (optional) Filter by task status: pending, routed, assigned, in_progress, awaiting_review, completed, failed, cancelled
- backend_id: (optional) Filter by backend: mturk, rentahuman, manual
- category: (optional) Filter by category: errand, photo_video, data_collection, verification, delivery, digital_micro, in_person, custom
- limit: (optional) Max results to return, 1-100, default 20
- offset: (optional) Skip N results for pagination, default 0

RETURNS: { total, count, tasks[], has_more, next_offset }

EXAMPLES:
1. List all tasks: {}
2. List completed tasks: { status: "completed" }
3. List physical tasks on RentAHuman: { backend_id: "rentahuman", limit: 10 }
4. Paginate: { limit: 5, offset: 5 }

DON'T USE WHEN:
- You know the exact task_id (use human_get_task_status for a single task)`,
    TaskFilterSchema.shape,
    async (params) => {
      const filters = TaskFilterSchema.parse(params);

      const { total, tasks } = taskStore.listTasks({
        status: filters.status as TaskStatus | undefined,
        backend_id: filters.backend_id as BackendId | undefined,
        category: filters.category as TaskCategory | undefined,
        limit: filters.limit,
        offset: filters.offset,
      });

      const hasMore = filters.offset + tasks.length < total;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total,
            count: tasks.length,
            tasks,
            has_more: hasMore,
            next_offset: hasMore ? filters.offset + tasks.length : null,
          }, null, 2),
        }],
      };
    },
  );
}

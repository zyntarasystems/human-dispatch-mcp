import { TaskStatus } from "../types.js";
import { TaskStore } from "./task-store.js";
import { WebhookProviderAdapter } from "./backends/webhook-provider.js";

/** How often the reaper scans for expired tasks. */
const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Grace period beyond `deadline.complete_by` before a task is considered
 * expired. Provider callbacks arriving slightly after the deadline still
 * land cleanly; only callbacks that never arrive trigger the reaper.
 */
const DEADLINE_GRACE_MS = 60 * 1000;

/**
 * Periodic scan that times out non-terminal tasks past their deadline,
 * marks them FAILED, and notifies the webhook adapter so it can release
 * the provider's per-task state and decrement current_task_count.
 *
 * Without this, a provider that accepts a task but never callbacks holds
 * its capacity slot forever. Once max_concurrent_tasks slots leak, the
 * provider falls out of findMatchingProviders silently — only a process
 * restart recovers.
 *
 * The interval is .unref()'d so it does not keep the Node event loop
 * alive on its own; the process exits naturally if all other work
 * completes.
 */
export function startTaskReaper(
  taskStore: TaskStore,
  webhookAdapter: WebhookProviderAdapter,
): NodeJS.Timeout {
  const tick = (): void => {
    const cutoff = new Date(Date.now() - DEADLINE_GRACE_MS).toISOString();
    const expired = taskStore.findExpired(cutoff);
    for (const task of expired) {
      console.error(
        `[reaper] Task ${task.id} expired (deadline=${task.request.deadline.complete_by}); ` +
        `marking FAILED`,
      );
      taskStore.updateTask(task.id, {
        status: TaskStatus.FAILED,
        error: "Task deadline exceeded with no provider callback",
      });
      // Notify the webhook adapter so it can clean up its per-task state
      // and decrement the provider's active count. ManualAdapter has no
      // capacity tracking and doesn't need a hook.
      if (task.backend_task_id) {
        webhookAdapter.updateTaskStatus(task.backend_task_id, {
          status: TaskStatus.FAILED,
        });
      }
    }
  };

  const interval = setInterval(tick, REAP_INTERVAL_MS);
  interval.unref();
  return interval;
}

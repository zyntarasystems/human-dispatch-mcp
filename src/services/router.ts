import {
  BackendAdapter,
  BackendId,
  Task,
  TaskStatus,
  TaskType,
} from "../types.js";
import { TaskStore } from "./task-store.js";

export class Router {
  private readonly adapters: Map<BackendId, BackendAdapter>;
  private readonly taskStore: TaskStore;

  constructor(adapters: BackendAdapter[], taskStore: TaskStore) {
    this.adapters = new Map(adapters.map(a => [a.id, a]));
    this.taskStore = taskStore;
  }

  async route(task: Task): Promise<Task> {
    const chain = this.buildRoutingChain(task);

    for (const backendId of chain) {
      const adapter = this.adapters.get(backendId);
      if (!adapter) continue;

      try {
        console.error(`[router] Trying backend ${backendId} for task ${task.id}`);
        const result = await adapter.submitTask(task);

        task = this.taskStore.updateTask(task.id, {
          status: TaskStatus.ROUTED,
          backend_id: backendId,
          backend_task_id: result.backend_task_id,
          routed_at: new Date().toISOString(),
          attempts: [
            ...task.attempts,
            {
              backend_id: backendId,
              attempted_at: new Date().toISOString(),
              success: true,
            },
          ],
        });

        console.error(`[router] Task ${task.id} routed to ${backendId} (backend_task_id: ${result.backend_task_id})`);
        return task;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[router] Backend ${backendId} failed for task ${task.id}: ${errorMessage}`);

        task = this.taskStore.updateTask(task.id, {
          attempts: [
            ...task.attempts,
            {
              backend_id: backendId,
              attempted_at: new Date().toISOString(),
              success: false,
              error: errorMessage,
            },
          ],
        });
      }
    }

    // All backends failed
    task = this.taskStore.updateTask(task.id, {
      status: TaskStatus.FAILED,
      error: `All backends failed. Attempted: ${chain.join(", ")}. Check backend configuration and task requirements.`,
    });

    return task;
  }

  private buildRoutingChain(task: Task): BackendId[] {
    // 1. If agent specified preferred_backends, try those first
    if (task.request.preferred_backends && task.request.preferred_backends.length > 0) {
      const chain = [...task.request.preferred_backends];
      // Add fallback chain if provided
      if (task.request.fallback_chain) {
        for (const fb of task.request.fallback_chain) {
          if (!chain.includes(fb)) chain.push(fb);
        }
      }
      // Always include manual as ultimate fallback
      if (!chain.includes(BackendId.MANUAL)) {
        chain.push(BackendId.MANUAL);
      }
      return chain;
    }

    // 2. If agent specified fallback_chain, use it
    if (task.request.fallback_chain && task.request.fallback_chain.length > 0) {
      const chain = [...task.request.fallback_chain];
      if (!chain.includes(BackendId.MANUAL)) {
        chain.push(BackendId.MANUAL);
      }
      return chain;
    }

    // 3. Score and rank configured backends
    const scored: Array<{ id: BackendId; score: number }> = [];

    for (const adapter of this.adapters.values()) {
      if (!adapter.isConfigured()) continue;

      const caps = adapter.getCapabilities();
      let score = 0;

      // Type compatibility
      if (task.request.task_type === TaskType.PHYSICAL && !caps.supports_physical) continue;
      if (task.request.task_type === TaskType.DIGITAL && !caps.supports_digital) continue;

      // Budget compatibility
      if (task.request.budget.max_usd < caps.min_budget_usd) continue;
      if (task.request.budget.max_usd > caps.max_budget_usd) continue;

      // Location scoring
      if (task.request.location && !caps.supports_location) {
        score -= 50;
      }

      // Speed bonus
      score += 100 - caps.avg_completion_minutes;

      // Prefer real backends over manual
      if (adapter.id !== BackendId.MANUAL) {
        score += 50;
      }

      scored.push({ id: adapter.id, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const chain = scored.map(s => s.id);

    // Always include manual as ultimate fallback
    if (!chain.includes(BackendId.MANUAL)) {
      chain.push(BackendId.MANUAL);
    }

    return chain;
  }
}

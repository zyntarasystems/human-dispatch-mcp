import { randomUUID } from "node:crypto";
import {
  BackendId,
  Task,
  TaskCategory,
  TaskRequest,
  TaskStatus,
} from "../types.js";

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
]);

export class TaskStore {
  private static readonly MAX_TASKS = 10_000;
  private static readonly IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  private readonly tasks = new Map<string, Task>();

  createTask(request: TaskRequest): Task {
    // Idempotency: if a task with the same client-supplied key was created
    // within the dedup window, return it instead of creating a duplicate.
    // Lookup is O(n) over the task map; with the 10k cap this is bounded.
    if (request.idempotency_key) {
      const existing = this.findByIdempotencyKey(request.idempotency_key);
      if (existing) return existing;
    }

    if (this.tasks.size >= TaskStore.MAX_TASKS) {
      this.evictOldestTerminal();
    }
    if (this.tasks.size >= TaskStore.MAX_TASKS) {
      throw new Error(
        "Task store capacity exceeded and no terminal tasks available to evict. " +
        "All slots are held by in-flight work; cancel or wait for tasks to complete.",
      );
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      request,
      status: TaskStatus.PENDING,
      backend_id: null,
      backend_task_id: null,
      worker_id: null,
      proof: [],
      created_at: now,
      updated_at: now,
      routed_at: null,
      completed_at: null,
      cost_usd: null,
      error: null,
      attempts: [],
    };

    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  updateTask(id: string, updates: Partial<Task>): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found. Use human_list_tasks to see available tasks.`);
    }

    const updated: Task = {
      ...task,
      ...updates,
      updated_at: new Date().toISOString(),
    };
    this.tasks.set(id, updated);
    return updated;
  }

  listTasks(filters: {
    status?: TaskStatus;
    backend_id?: BackendId;
    category?: TaskCategory;
    limit: number;
    offset: number;
  }): { total: number; tasks: Task[] } {
    let results = Array.from(this.tasks.values());

    if (filters.status) {
      results = results.filter(t => t.status === filters.status);
    }
    if (filters.backend_id) {
      results = results.filter(t => t.backend_id === filters.backend_id);
    }
    if (filters.category) {
      results = results.filter(t => t.request.category === filters.category);
    }

    // Sort by creation time, newest first
    results.sort((a, b) => b.created_at.localeCompare(a.created_at));

    const total = results.length;
    const paged = results.slice(filters.offset, filters.offset + filters.limit);

    return { total, tasks: paged };
  }

  /**
   * Return all non-terminal tasks whose deadline.complete_by is older than
   * the supplied ISO timestamp. Used by the reaper to time out tasks that
   * never received a provider callback so their state (and the provider's
   * current_task_count) can be released.
   */
  findExpired(beforeIso: string): Task[] {
    const result: Task[] = [];
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATUSES.has(task.status)) continue;
      if (task.request.deadline.complete_by < beforeIso) {
        result.push(task);
      }
    }
    return result;
  }

  private findByIdempotencyKey(key: string): Task | undefined {
    const cutoff = Date.now() - TaskStore.IDEMPOTENCY_WINDOW_MS;
    for (const task of this.tasks.values()) {
      if (task.request.idempotency_key !== key) continue;
      if (Date.parse(task.created_at) >= cutoff) return task;
    }
    return undefined;
  }

  private evictOldestTerminal(): void {
    let oldestId: string | null = null;
    let oldestUpdatedAt = "￿"; // sorts after any ISO 8601 string
    for (const task of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(task.status)) continue;
      if (task.updated_at < oldestUpdatedAt) {
        oldestUpdatedAt = task.updated_at;
        oldestId = task.id;
      }
    }
    if (oldestId !== null) {
      this.tasks.delete(oldestId);
    }
  }
}

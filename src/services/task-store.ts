import { randomUUID } from "node:crypto";
import {
  BackendId,
  Task,
  TaskCategory,
  TaskRequest,
  TaskStatus,
} from "../types.js";

export class TaskStore {
  private readonly tasks = new Map<string, Task>();

  createTask(request: TaskRequest): Task {
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
}

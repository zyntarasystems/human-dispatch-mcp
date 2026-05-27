import test from "node:test";
import assert from "node:assert/strict";

import { TaskStore } from "./task-store.js";
import { BackendId, TaskCategory, TaskStatus } from "../types.js";
import { validTaskRequest } from "../test/helpers.js";

test("TaskStore creates, gets, updates, and lists tasks", () => {
  const store = new TaskStore();
  const task = store.createTask(validTaskRequest());

  assert.equal(store.getTask(task.id)?.id, task.id);
  store.updateTask(task.id, { status: TaskStatus.ROUTED, backend_id: BackendId.MANUAL });

  const listed = store.listTasks({
    status: TaskStatus.ROUTED,
    backend_id: BackendId.MANUAL,
    category: TaskCategory.DIGITAL_MICRO,
    limit: 10,
    offset: 0,
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.tasks[0]?.id, task.id);
});

test("TaskStore reuses idempotency keys within the dedupe window", () => {
  const store = new TaskStore();
  const first = store.createTask(validTaskRequest({ idempotency_key: "same-key" }));
  const second = store.createTask(validTaskRequest({ idempotency_key: "same-key" }));
  const third = store.createTask(validTaskRequest({ idempotency_key: "other-key" }));

  assert.equal(second.id, first.id);
  assert.notEqual(third.id, first.id);
});

test("TaskStore evicts the oldest terminal task at capacity", () => {
  const store = new TaskStore();
  const first = store.createTask(validTaskRequest({ idempotency_key: "first" }));
  store.updateTask(first.id, { status: TaskStatus.COMPLETED });

  for (let i = 1; i < 10_000; i++) {
    store.createTask(validTaskRequest({ idempotency_key: `task-${i}` }));
  }

  const newest = store.createTask(validTaskRequest({ idempotency_key: "newest" }));

  assert.equal(store.getTask(first.id), undefined);
  assert.equal(store.getTask(newest.id)?.id, newest.id);
  assert.equal(store.listTasks({ limit: 1, offset: 0 }).total, 10_000);
});

import test from "node:test";
import assert from "node:assert/strict";

import { Router } from "./router.js";
import { TaskStore } from "./task-store.js";
import { BackendId, Task, TaskType } from "../types.js";
import { StubBackendAdapter, validTaskRequest } from "../test/helpers.js";

function routingChain(router: Router, task: Task): BackendId[] {
  return (router as unknown as { buildRoutingChain(task: Task): BackendId[] }).buildRoutingChain(task);
}

test("Router keeps manual backend last and deduplicated for preferred chains", () => {
  const store = new TaskStore();
  const router = new Router([], store);
  const task = store.createTask(validTaskRequest({
    preferred_backends: [BackendId.MANUAL, BackendId.WEBHOOK_PROVIDER],
    fallback_chain: [BackendId.MANUAL, BackendId.WEBHOOK_PROVIDER],
  }));

  assert.deepEqual(routingChain(router, task), [BackendId.WEBHOOK_PROVIDER, BackendId.MANUAL]);
});

test("Router preserves fallback order before manual", () => {
  const store = new TaskStore();
  const router = new Router([], store);
  const task = store.createTask(validTaskRequest({
    fallback_chain: [BackendId.WEBHOOK_PROVIDER],
  }));

  assert.deepEqual(routingChain(router, task), [BackendId.WEBHOOK_PROVIDER, BackendId.MANUAL]);
});

test("Router scoring path skips unconfigured non-manual backends", () => {
  const store = new TaskStore();
  const webhook = new StubBackendAdapter(BackendId.WEBHOOK_PROVIDER, { configured: false });
  const manual = new StubBackendAdapter(BackendId.MANUAL, { configured: true });
  const router = new Router([webhook, manual], store);
  const task = store.createTask(validTaskRequest());

  assert.deepEqual(routingChain(router, task), [BackendId.MANUAL]);
});

test("Router scoring path skips incompatible task types", () => {
  const store = new TaskStore();
  const webhook = new StubBackendAdapter(BackendId.WEBHOOK_PROVIDER, {
    capabilities: { supports_physical: false, supports_digital: true },
  });
  const manual = new StubBackendAdapter(BackendId.MANUAL);
  const router = new Router([webhook, manual], store);
  const task = store.createTask(validTaskRequest({
    task_type: TaskType.PHYSICAL,
    location: { region: "US" },
  }));

  assert.deepEqual(routingChain(router, task), [BackendId.MANUAL]);
});

test("Router.route records successful backend attempts and routed task state", async () => {
  const store = new TaskStore();
  const webhook = new StubBackendAdapter(BackendId.WEBHOOK_PROVIDER, { backendTaskId: "external-success" });
  const manual = new StubBackendAdapter(BackendId.MANUAL);
  const router = new Router([webhook, manual], store);
  const task = store.createTask(validTaskRequest());

  const routed = await router.route(task);

  assert.equal(routed.status, "routed");
  assert.equal(routed.backend_id, BackendId.WEBHOOK_PROVIDER);
  assert.equal(routed.backend_task_id, "external-success");
  assert.equal(routed.attempts.length, 1);
  assert.equal(routed.attempts[0]?.success, true);
});

test("Router.route records failed attempts and marks task failed when every backend fails", async () => {
  const store = new TaskStore();
  const manual = new StubBackendAdapter(BackendId.MANUAL, { submitError: new Error("manual offline") });
  const router = new Router([manual], store);
  const task = store.createTask(validTaskRequest());

  const routed = await router.route(task);

  assert.equal(routed.status, "failed");
  assert.equal(routed.attempts.length, 1);
  assert.equal(routed.attempts[0]?.success, false);
  assert.match(routed.error ?? "", /All backends failed/);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import { WEBHOOK_PROVIDER_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "../../constants.js";
import { handleCallback } from "./callback-handler.js";
import { ProviderRegistry } from "./registry.js";
import { TaskStore } from "../task-store.js";
import { BackendId, BackendStatusResult, TaskStatus } from "../../types.js";
import { signedCallback, validProviderParams, validTaskRequest } from "../../test/helpers.js";
import { signPayload } from "./webhook.js";
import { WebhookProviderAdapter } from "../backends/webhook-provider.js";

class FakeWebhookAdapter {
  readonly owners = new Map<string, string>();
  readonly statuses = new Map<string, BackendStatusResult>();

  getProviderIdForTask(backendTaskId: string): string | undefined {
    return this.owners.get(backendTaskId);
  }

  updateTaskStatus(backendTaskId: string, status: BackendStatusResult): void {
    this.statuses.set(backendTaskId, status);
  }
}

class FakeResponse {
  statusCode = 200;
  payload: unknown;
  headersSent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    this.headersSent = true;
    return this;
  }
}

function makeRequest(options: {
  taskId: string;
  headers?: Record<string, string | undefined>;
  body?: Buffer | unknown;
}): Request {
  return {
    params: { taskId: options.taskId },
    headers: options.headers ?? {},
    body: options.body ?? Buffer.from("{}"),
  } as unknown as Request;
}

async function invokeCallback(
  req: Request,
  store: TaskStore,
  adapter: FakeWebhookAdapter,
  registry: ProviderRegistry,
): Promise<FakeResponse> {
  const res = new FakeResponse();
  await handleCallback(
    req,
    res as unknown as Response,
    store,
    adapter as unknown as WebhookProviderAdapter,
    registry,
  );
  return res;
}

function assignTask(store: TaskStore, backendTaskId = "external-task") {
  const task = store.createTask(validTaskRequest());
  store.updateTask(task.id, {
    status: TaskStatus.ROUTED,
    backend_id: BackendId.WEBHOOK_PROVIDER,
    backend_task_id: backendTaskId,
  });
  return store.getTask(task.id)!;
}

const completedPayload = {
  status: "completed",
  proof: [{
    type: "text_report",
    text: "done",
    submitted_at: "2099-01-15T18:00:00Z",
  }],
  actual_cost_usd: 3,
};

test("callback handler rejects missing provider headers", async () => {
  const response = await invokeCallback(
    makeRequest({ taskId: "not-a-real-task" }),
    new TaskStore(),
    new FakeWebhookAdapter(),
    new ProviderRegistry(),
  );

  assert.equal(response.statusCode, 400);
});

test("callback handler rejects unknown providers", async () => {
  const response = await invokeCallback(
    makeRequest({
      taskId: "not-a-real-task",
      headers: {
        [WEBHOOK_PROVIDER_ID_HEADER]: "00000000-0000-4000-8000-000000000000",
        [WEBHOOK_SIGNATURE_HEADER]: "sha256=bad",
      },
    }),
    new TaskStore(),
    new FakeWebhookAdapter(),
    new ProviderRegistry(),
  );

  assert.equal(response.statusCode, 404);
});

test("callback handler rejects bad signatures", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  const store = new TaskStore();
  const adapter = new FakeWebhookAdapter();
  const task = assignTask(store);
  adapter.owners.set(task.backend_task_id!, provider.id);
  const body = JSON.stringify(completedPayload);

  const response = await invokeCallback(
    makeRequest({
      taskId: task.id,
      headers: {
        [WEBHOOK_PROVIDER_ID_HEADER]: provider.id,
        [WEBHOOK_SIGNATURE_HEADER]: `sha256=${"0".repeat(64)}`,
      },
      body: Buffer.from(body),
    }),
    store,
    adapter,
    registry,
  );

  assert.equal(response.statusCode, 401);
});

test("callback handler rejects wrong provider ownership", async () => {
  const registry = new ProviderRegistry();
  const caller = registry.registerProvider(validProviderParams({ name: "Caller" }));
  const owner = registry.registerProvider(validProviderParams({ name: "Owner" }));
  const store = new TaskStore();
  const adapter = new FakeWebhookAdapter();
  const task = assignTask(store);
  adapter.owners.set(task.backend_task_id!, owner.id);
  const signed = signedCallback(caller, completedPayload);

  const response = await invokeCallback(
    makeRequest({ taskId: task.id, headers: signed.headers, body: Buffer.from(signed.body) }),
    store,
    adapter,
    registry,
  );

  assert.equal(response.statusCode, 403);
});

test("callback handler fails loudly when raw body has already been parsed", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  const store = new TaskStore();
  const adapter = new FakeWebhookAdapter();
  const task = assignTask(store);
  adapter.owners.set(task.backend_task_id!, provider.id);
  const signed = signedCallback(provider, completedPayload);

  const response = await invokeCallback(
    makeRequest({ taskId: task.id, headers: signed.headers, body: completedPayload }),
    store,
    adapter,
    registry,
  );

  assert.equal(response.statusCode, 500);
});

test("callback handler returns terminal replay conflict before ownership lookup", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  const store = new TaskStore();
  const adapter = new FakeWebhookAdapter();
  const task = assignTask(store);
  store.updateTask(task.id, { status: TaskStatus.COMPLETED });
  const signed = signedCallback(provider, completedPayload);

  const response = await invokeCallback(
    makeRequest({ taskId: task.id, headers: signed.headers, body: Buffer.from(signed.body) }),
    store,
    adapter,
    registry,
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.payload, {
    error: "Task already in terminal state",
    current_status: TaskStatus.COMPLETED,
  });
});

test("callback handler rate limits excessive callbacks per provider", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  const store = new TaskStore();
  const adapter = new FakeWebhookAdapter();
  let sawRateLimit = false;

  for (let i = 0; i < 60; i++) {
    const body = JSON.stringify(completedPayload);
    const response = await invokeCallback(
      makeRequest({
        taskId: `missing-${i}`,
        headers: {
          [WEBHOOK_PROVIDER_ID_HEADER]: provider.id,
          [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signPayload(body, provider.webhook_secret)}`,
        },
        body: Buffer.from(body),
      }),
      store,
      adapter,
      registry,
    );
    if (response.statusCode === 429) {
      sawRateLimit = true;
      break;
    }
  }

  assert.equal(sawRateLimit, true);
});

test("callback handler rejects malformed callback payloads", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  const store = new TaskStore();
  const adapter = new FakeWebhookAdapter();
  const task = assignTask(store);
  adapter.owners.set(task.backend_task_id!, provider.id);
  const signed = signedCallback(provider, { status: "completed", actual_cost_usd: -1 });

  const response = await invokeCallback(
    makeRequest({ taskId: task.id, headers: signed.headers, body: Buffer.from(signed.body) }),
    store,
    adapter,
    registry,
  );

  assert.equal(response.statusCode, 400);
});

test("callback handler accepts completed callbacks and updates task/provider state", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  const store = new TaskStore();
  const adapter = new FakeWebhookAdapter();
  const task = assignTask(store);
  adapter.owners.set(task.backend_task_id!, provider.id);
  const signed = signedCallback(provider, completedPayload);

  const response = await invokeCallback(
    makeRequest({ taskId: task.id, headers: signed.headers, body: Buffer.from(signed.body) }),
    store,
    adapter,
    registry,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(store.getTask(task.id)?.status, TaskStatus.COMPLETED);
  assert.equal(store.getTask(task.id)?.cost_usd, 3);
  assert.equal(registry.getProvider(provider.id)?.stats.completed_count, 1);
  assert.equal(adapter.statuses.get(task.backend_task_id!)?.status, TaskStatus.COMPLETED);
});

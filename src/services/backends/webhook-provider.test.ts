import test from "node:test";
import assert from "node:assert/strict";

import { MAX_PROVIDER_CANDIDATES } from "../../constants.js";
import { ProviderRegistry } from "../providers/registry.js";
import { WebhookProviderAdapter } from "./webhook-provider.js";
import { TaskStore } from "../task-store.js";
import { TaskCategory, TaskStatus, TaskType, WebhookProvider } from "../../types.js";
import { validProviderParams, validTaskRequest } from "../../test/helpers.js";

test("WebhookProviderAdapter reports unconfigured default capabilities with no active providers", () => {
  const adapter = new WebhookProviderAdapter(new ProviderRegistry());
  const caps = adapter.getCapabilities();

  assert.equal(caps.configured, false);
  assert.equal(caps.supports_physical, false);
  assert.equal(caps.supports_digital, false);
  assert.equal(caps.supports_location, false);
});

test("WebhookProviderAdapter derives capabilities from active providers", () => {
  const registry = new ProviderRegistry();
  registry.registerProvider(validProviderParams({
    categories: [TaskCategory.ERRAND],
    task_types: [TaskType.PHYSICAL],
    min_budget_usd: 2,
    max_budget_usd: 50,
  }));
  const adapter = new WebhookProviderAdapter(registry);
  const caps = adapter.getCapabilities();

  assert.equal(caps.configured, true);
  assert.equal(caps.supports_physical, true);
  assert.equal(caps.supports_digital, false);
  assert.equal(caps.supports_location, true);
  assert.equal(caps.min_budget_usd, 2);
  assert.equal(caps.max_budget_usd, 50);
});

test("WebhookProviderAdapter dispatches only to active matching providers", async () => {
  const registry = new ProviderRegistry();
  registry.registerProvider(validProviderParams({ name: "Inactive" }), { active: false });
  const active = registry.registerProvider(validProviderParams({ name: "Active" }));
  const store = new TaskStore();
  const task = store.createTask(validTaskRequest());
  const seen: string[] = [];

  const adapter = new WebhookProviderAdapter(registry, async (provider) => {
    seen.push(provider.name);
    return { accepted: true, external_id: "external-1" };
  });

  const result = await adapter.submitTask(task);

  assert.deepEqual(seen, ["Active"]);
  assert.equal(result.backend_task_id, "external-1");
  assert.equal(adapter.getProviderIdForTask("external-1"), active.id);
});

test("WebhookProviderAdapter releases provider capacity after rejection", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams({ max_concurrent_tasks: 1 }));
  const store = new TaskStore();
  const task = store.createTask(validTaskRequest());

  const adapter = new WebhookProviderAdapter(registry, async () => {
    return { accepted: false, reason: "no" };
  });

  await assert.rejects(() => adapter.submitTask(task), /rejected/);
  assert.equal(registry.getProvider(provider.id)?.current_task_count, 0);
});

test("WebhookProviderAdapter releases provider capacity once on terminal status", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams({ max_concurrent_tasks: 1 }));
  const store = new TaskStore();
  const task = store.createTask(validTaskRequest());
  const adapter = new WebhookProviderAdapter(registry, async () => {
    return { accepted: true, external_id: "external-terminal" };
  });

  await adapter.submitTask(task);
  assert.equal(registry.getProvider(provider.id)?.current_task_count, 1);

  adapter.updateTaskStatus("external-terminal", { status: TaskStatus.COMPLETED });
  adapter.updateTaskStatus("external-terminal", { status: TaskStatus.COMPLETED });

  assert.equal(registry.getProvider(provider.id)?.current_task_count, 0);
});

test("WebhookProviderAdapter cancel plus late callback does not double-decrement capacity", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams({ max_concurrent_tasks: 1 }));
  const store = new TaskStore();
  const task = store.createTask(validTaskRequest());
  const adapter = new WebhookProviderAdapter(
    registry,
    async () => ({ accepted: true, external_id: "external-cancel" }),
    async () => true,
  );

  await adapter.submitTask(task);
  assert.equal(registry.getProvider(provider.id)?.current_task_count, 1);

  assert.equal(await adapter.cancelTask(task.id, "external-cancel"), true);
  adapter.updateTaskStatus("external-cancel", { status: TaskStatus.COMPLETED });

  assert.equal(registry.getProvider(provider.id)?.current_task_count, 0);
});

test("WebhookProviderAdapter caps provider candidate walk", async () => {
  const registry = new ProviderRegistry();
  for (let i = 0; i < MAX_PROVIDER_CANDIDATES + 3; i++) {
    registry.registerProvider(validProviderParams({ name: `Provider ${i}` }));
  }
  const store = new TaskStore();
  const task = store.createTask(validTaskRequest());
  const seen: WebhookProvider[] = [];
  const adapter = new WebhookProviderAdapter(registry, async (provider) => {
    seen.push(provider);
    return { accepted: false, reason: "busy" };
  });

  await assert.rejects(() => adapter.submitTask(task), /All 5 provider/);
  assert.equal(seen.length, MAX_PROVIDER_CANDIDATES);
});

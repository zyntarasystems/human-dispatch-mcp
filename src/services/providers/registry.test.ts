import test from "node:test";
import assert from "node:assert/strict";

import { ProviderRegistry } from "./registry.js";
import { TaskStore } from "../task-store.js";
import { TEST_WEBHOOK_SECRET, captureConsoleError, validProviderParams, validTaskRequest } from "../../test/helpers.js";
import { TaskCategory } from "../../types.js";

async function withProvidersConfig<T>(value: unknown, fn: () => Promise<T>): Promise<T> {
  const original = process.env["PROVIDERS_CONFIG"];
  process.env["PROVIDERS_CONFIG"] = JSON.stringify(value);
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env["PROVIDERS_CONFIG"];
    } else {
      process.env["PROVIDERS_CONFIG"] = original;
    }
  }
}

test("seedFromEnv registers providers inactive before verification and activates only verified providers", async () => {
  await withProvidersConfig([
    validProviderParams({ name: "Verified Provider" }),
    validProviderParams({ name: "Rejected Provider", webhook_url: "https://rejected.example.com/webhook" }),
  ], async () => {
    const registry = new ProviderRegistry();
    const observedActiveStates: boolean[] = [];

    await registry.seedFromEnv(async (provider) => {
      observedActiveStates.push(provider.is_active);
      return provider.name === "Verified Provider";
    });

    const providers = registry.listProviders({ active_only: false });
    assert.deepEqual(observedActiveStates, [false, false]);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.name, "Verified Provider");
    assert.equal(providers[0]?.is_active, true);
  });
});

test("seedFromEnv skips invalid provider configs and does not log webhook secrets", async () => {
  await withProvidersConfig([
    validProviderParams({ webhook_secret: TEST_WEBHOOK_SECRET }),
    { ...validProviderParams(), name: "Invalid Provider", webhook_secret: "too-short" },
  ], async () => {
    const registry = new ProviderRegistry();
    const { messages } = await captureConsoleError(async () => {
      await registry.seedFromEnv(async () => true);
    });

    assert.equal(registry.listProviders({ active_only: false }).length, 1);
    assert.equal(messages.join("\n").includes(TEST_WEBHOOK_SECRET), false);
  });
});

test("findMatchingProviders excludes inactive providers", () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams(), { active: false });
  const task = new TaskStore().createTask(validTaskRequest());

  assert.equal(provider.is_active, false);
  assert.equal(registry.findMatchingProviders(task).length, 0);
  registry.setProviderActive(provider.id, true);
  assert.equal(registry.findMatchingProviders(task).length, 1);
});

test("tryReserveTaskSlot refuses inactive and full providers", () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams({ max_concurrent_tasks: 1 }), { active: false });

  assert.equal(registry.tryReserveTaskSlot(provider.id), false);
  registry.setProviderActive(provider.id, true);
  assert.equal(registry.tryReserveTaskSlot(provider.id), true);
  assert.equal(registry.tryReserveTaskSlot(provider.id), false);
});

test("listProviders filters by active state, category, and region", () => {
  const registry = new ProviderRegistry();
  const active = registry.registerProvider(validProviderParams({
    categories: [TaskCategory.ERRAND],
    regions: ["US"],
  }));
  registry.registerProvider(validProviderParams({
    name: "Inactive",
    categories: [TaskCategory.DIGITAL_MICRO],
    regions: ["EU"],
  }), { active: false });

  assert.deepEqual(registry.listProviders().map(p => p.id), [active.id]);
  assert.deepEqual(registry.listProviders({ category: TaskCategory.ERRAND }).map(p => p.id), [active.id]);
  assert.deepEqual(registry.listProviders({ region: "US-CA" }).map(p => p.id), [active.id]);
  assert.equal(registry.listProviders({ active_only: false }).length, 2);
});

test("updateProviderStats maintains reliability and last_seen_at", () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  const before = provider.last_seen_at;

  registry.updateProviderStats(provider.id, "completed");
  registry.updateProviderStats(provider.id, "failed");

  const updated = registry.getProvider(provider.id)!;
  assert.equal(updated.stats.completed_count, 1);
  assert.equal(updated.stats.failed_count, 1);
  assert.equal(updated.stats.reliability_score, 0.5);
  assert.notEqual(updated.last_seen_at, "");
  assert.ok(updated.last_seen_at >= before);
});

test("seedFromEnv handles invalid JSON and non-array config without seeding", async () => {
  const original = process.env["PROVIDERS_CONFIG"];
  try {
    const registry = new ProviderRegistry();
    process.env["PROVIDERS_CONFIG"] = "{not-json";
    await registry.seedFromEnv(async () => true);
    assert.equal(registry.listProviders({ active_only: false }).length, 0);

    process.env["PROVIDERS_CONFIG"] = JSON.stringify({ name: "not-array" });
    await registry.seedFromEnv(async () => true);
    assert.equal(registry.listProviders({ active_only: false }).length, 0);
  } finally {
    if (original === undefined) {
      delete process.env["PROVIDERS_CONFIG"];
    } else {
      process.env["PROVIDERS_CONFIG"] = original;
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";

import { registerProviderTools } from "./providers.js";
import { ProviderRegistry } from "../services/providers/registry.js";
import { createToolCapture, TEST_WEBHOOK_SECRET, validProviderParams } from "../test/helpers.js";

class TrackingRegistry extends ProviderRegistry {
  readonly activations: Array<{ id: string; active: boolean }> = [];

  override setProviderActive(id: string, active: boolean): boolean {
    this.activations.push({ id, active });
    return super.setProviderActive(id, active);
  }
}

test("human_register_provider verifies while inactive and activates through ProviderRegistry", async () => {
  const registry = new TrackingRegistry();
  const { server, handlers } = createToolCapture();

  registerProviderTools(server, registry, async (provider) => {
    assert.equal(provider.is_active, false);
    return true;
  });

  const result = await handlers.get("human_register_provider")?.(validProviderParams()) as {
    content: Array<{ text: string }>;
  };
  const body = JSON.parse(result.content[0]!.text) as { provider_id: string; status: string };

  assert.equal(body.status, "registered");
  assert.deepEqual(registry.activations, [{ id: body.provider_id, active: true }]);
  assert.equal(registry.getProvider(body.provider_id)?.is_active, true);
});

test("human_register_provider removes providers that fail provider.verify", async () => {
  const registry = new ProviderRegistry();
  const { server, handlers } = createToolCapture();

  registerProviderTools(server, registry, async (provider) => {
    assert.equal(provider.is_active, false);
    return false;
  });

  const result = await handlers.get("human_register_provider")?.(validProviderParams()) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  const body = JSON.parse(result.content[0]!.text) as { status: string };

  assert.equal(result.isError, true);
  assert.equal(body.status, "not_registered");
  assert.equal(registry.listProviders({ active_only: false }).length, 0);
});

test("human_list_providers never returns webhook_secret", async () => {
  const registry = new ProviderRegistry();
  registry.registerProvider(validProviderParams({ webhook_secret: TEST_WEBHOOK_SECRET }));

  const { server, handlers } = createToolCapture();
  registerProviderTools(server, registry, async () => true);

  const result = await handlers.get("human_list_providers")?.({ active_only: false }) as {
    content: Array<{ text: string }>;
  };
  const text = result.content[0]!.text;
  const body = JSON.parse(text) as { providers: Array<Record<string, unknown>> };

  assert.equal(text.includes(TEST_WEBHOOK_SECRET), false);
  assert.equal("webhook_secret" in body.providers[0]!, false);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchCancelToProvider,
  dispatchToProvider,
  signPayload,
  verifyProviderEndpoint,
  verifySignature,
} from "./webhook.js";
import { TEST_WEBHOOK_SECRET, validProviderParams, validTaskRequest } from "../../test/helpers.js";
import { ProviderRegistry } from "./registry.js";
import { TaskStore } from "../task-store.js";

test("signPayload returns an HMAC-SHA256 hex digest", () => {
  const signature = signPayload("{\"ok\":true}", TEST_WEBHOOK_SECRET);
  assert.match(signature, /^[0-9a-f]{64}$/);
});

test("verifySignature accepts the canonical sha256 signature format", () => {
  const body = "{\"ok\":true}";
  const signature = `sha256=${signPayload(body, TEST_WEBHOOK_SECRET)}`;
  assert.equal(verifySignature(body, signature, TEST_WEBHOOK_SECRET), true);
});

test("verifySignature rejects invalid signatures", () => {
  const body = "{\"ok\":true}";
  const signature = `sha256=${"0".repeat(64)}`;
  assert.equal(verifySignature(body, signature, TEST_WEBHOOK_SECRET), false);
});

test("verifySignature rejects malformed and length-mismatched signatures safely", () => {
  assert.equal(verifySignature("{}", "sha256=abc", TEST_WEBHOOK_SECRET), false);
  assert.equal(verifySignature("{}", "not-a-signature", TEST_WEBHOOK_SECRET), false);
});

test("dispatchToProvider returns a sanitized rejection for forbidden provider URLs", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  provider.webhook_url = "https://127.0.0.1/webhook";
  const task = new TaskStore().createTask(validTaskRequest());

  const result = await dispatchToProvider(provider, task);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "URL failed public-host validation");
});

test("dispatchCancelToProvider and verifyProviderEndpoint fail closed for forbidden provider URLs", async () => {
  const registry = new ProviderRegistry();
  const provider = registry.registerProvider(validProviderParams());
  provider.webhook_url = "https://127.0.0.1/webhook";

  assert.equal(await dispatchCancelToProvider(provider, "task-id", "external-id"), false);
  assert.equal(await verifyProviderEndpoint(provider), false);
});

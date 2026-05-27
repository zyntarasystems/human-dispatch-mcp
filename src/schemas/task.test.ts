import test from "node:test";
import assert from "node:assert/strict";

import { TaskRequestSchema, ProviderRegistrationSchema, CallbackPayloadSchema } from "./task.js";
import { validProviderParams, validTaskRequest } from "../test/helpers.js";
import { ProofType, TaskType } from "../types.js";

test("TaskRequestSchema accepts a valid digital task", () => {
  assert.equal(TaskRequestSchema.safeParse(validTaskRequest()).success, true);
});

test("TaskRequestSchema rejects unsupported currencies", () => {
  assert.equal(TaskRequestSchema.safeParse(validTaskRequest({
    budget: { max_usd: 5, currency: "EUR" },
  })).success, false);
});

test("TaskRequestSchema requires location for physical tasks", () => {
  assert.equal(TaskRequestSchema.safeParse(validTaskRequest({
    task_type: TaskType.PHYSICAL,
    location: null,
  })).success, false);
});

test("TaskRequestSchema rejects past deadlines", () => {
  assert.equal(TaskRequestSchema.safeParse(validTaskRequest({
    deadline: { complete_by: "2020-01-01T00:00:00Z", urgency: "low" },
  })).success, false);
});

test("ProviderRegistrationSchema validates provider budget range", () => {
  assert.equal(ProviderRegistrationSchema.safeParse(validProviderParams({
    min_budget_usd: 10,
    max_budget_usd: 5,
  })).success, false);
});

test("CallbackPayloadSchema rejects malformed callback payloads", () => {
  assert.equal(CallbackPayloadSchema.safeParse({
    status: "completed",
    proof: [{
      type: ProofType.TEXT_REPORT,
      text: "done",
      submitted_at: "not-a-date",
    }],
  }).success, false);
});

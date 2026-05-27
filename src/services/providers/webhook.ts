import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WEBHOOK_TIMEOUT_MS, WEBHOOK_SIGNATURE_HEADER } from "../../constants.js";
import {
  WebhookDispatchResult,
  WebhookEvent,
  WebhookProvider,
  Task,
} from "../../types.js";
import { safeFetch, sanitizeErrorMessage } from "../security/url-guard.js";
import { sanitizeForLog } from "../security/logging.js";

export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = `sha256=${signPayload(body, secret)}`;
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Outbound webhook payload version. Increment on any breaking change to
 * `task.new`, `task.cancel`, or `provider.verify` body shapes. Providers
 * SHOULD pin their parser to a known version. Inbound callbacks may
 * include the same field; today the server treats it as informational.
 */
const PAYLOAD_VERSION = 1;

const WebhookDispatchResultSchema = z.object({
  accepted: z.boolean(),
  external_id: z.string().min(1).max(500).optional(),
  reason: z.string().max(500).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.accepted && !value.external_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["external_id"],
      message: "external_id is required when accepted is true",
    });
  }
});

function buildTaskPayload(task: Task): Record<string, unknown> {
  return {
    payload_version: PAYLOAD_VERSION,
    event: "task.new" satisfies WebhookEvent,
    task_id: task.id,
    description: task.request.description,
    category: task.request.category,
    task_type: task.request.task_type,
    location: task.request.location ?? null,
    budget: task.request.budget,
    deadline: task.request.deadline,
    proof_required: task.request.proof_required,
    quality_sla: task.request.quality_sla,
    metadata: task.request.metadata,
  };
}

export async function dispatchToProvider(
  provider: WebhookProvider,
  task: Task,
): Promise<WebhookDispatchResult> {
  const providerName = sanitizeForLog(provider.name);
  const payload = buildTaskPayload(task);
  const body = JSON.stringify(payload);
  const signature = `sha256=${signPayload(body, provider.webhook_secret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await safeFetch(provider.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        "X-Dispatch-Event": "task.new" satisfies WebhookEvent,
        "X-Dispatch-TaskId": task.id,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[webhook] Provider ${providerName} returned ${response.status}`);
      return { accepted: false, reason: `HTTP ${response.status}` };
    }

    const parsed = WebhookDispatchResultSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { accepted: false, reason: "Invalid provider response" };
    }

    return parsed.data as WebhookDispatchResult;
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    console.error(`[webhook] Dispatch to ${providerName} failed: ${sanitizeForLog(message)}`);
    return { accepted: false, reason: message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function dispatchCancelToProvider(
  provider: WebhookProvider,
  taskId: string,
  externalId: string,
): Promise<boolean> {
  const providerName = sanitizeForLog(provider.name);
  const body = JSON.stringify({
    payload_version: PAYLOAD_VERSION,
    event: "task.cancel" satisfies WebhookEvent,
    task_id: taskId,
    external_id: externalId,
  });
  const signature = `sha256=${signPayload(body, provider.webhook_secret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await safeFetch(provider.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        "X-Dispatch-Event": "task.cancel" satisfies WebhookEvent,
        "X-Dispatch-TaskId": taskId,
      },
      body,
      signal: controller.signal,
    });

    return response.ok;
  } catch (err) {
    console.error(`[webhook] Cancel dispatch to ${providerName} failed: ${sanitizeForLog(sanitizeErrorMessage(err))}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyProviderEndpoint(provider: WebhookProvider): Promise<boolean> {
  const body = JSON.stringify({
    payload_version: PAYLOAD_VERSION,
    event: "provider.verify" satisfies WebhookEvent,
    provider_id: provider.id,
  });
  const signature = `sha256=${signPayload(body, provider.webhook_secret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await safeFetch(provider.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        "X-Dispatch-Event": "provider.verify" satisfies WebhookEvent,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) return false;

    // A 200 alone is not enough — any random HTTPS endpoint can return 200,
    // so we'd be confirming "is this URL reachable" rather than "is this URL
    // a willing provider for this id with this secret". Require the body to
    // be JSON containing { verified: true }; the provider has to read our
    // signed payload and explicitly opt in.
    try {
      const result = await response.json() as { verified?: unknown };
      return result?.verified === true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

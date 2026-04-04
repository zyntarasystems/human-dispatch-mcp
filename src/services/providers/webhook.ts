import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_TIMEOUT_MS, WEBHOOK_SIGNATURE_HEADER } from "../../constants.js";
import {
  WebhookDispatchResult,
  WebhookEvent,
  WebhookProvider,
  Task,
} from "../../types.js";

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

function buildTaskPayload(task: Task): Record<string, unknown> {
  return {
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
  const payload = buildTaskPayload(task);
  const body = JSON.stringify(payload);
  const signature = `sha256=${signPayload(body, provider.webhook_secret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(provider.webhook_url, {
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
      console.error(`[webhook] Provider ${provider.name} returned ${response.status}`);
      return { accepted: false, reason: `HTTP ${response.status}` };
    }

    const result = await response.json() as WebhookDispatchResult;
    return {
      accepted: Boolean(result.accepted),
      external_id: result.external_id,
      reason: result.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] Dispatch to ${provider.name} failed: ${message}`);
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
  const body = JSON.stringify({ task_id: taskId, external_id: externalId });
  const signature = `sha256=${signPayload(body, provider.webhook_secret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(provider.webhook_url, {
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
    console.error(`[webhook] Cancel dispatch to ${provider.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyProviderEndpoint(provider: WebhookProvider): Promise<boolean> {
  const body = JSON.stringify({ event: "provider.verify", provider_id: provider.id });
  const signature = `sha256=${signPayload(body, provider.webhook_secret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(provider.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        "X-Dispatch-Event": "provider.verify" satisfies WebhookEvent,
      },
      body,
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

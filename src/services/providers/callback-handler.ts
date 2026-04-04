import { Router as ExpressRouter, raw } from "express";
import type { Request, Response } from "express";
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_PROVIDER_ID_HEADER } from "../../constants.js";
import { CallbackPayloadSchema } from "../../schemas/task.js";
import { TaskStatus, ProofSubmission } from "../../types.js";
import { TaskStore } from "../task-store.js";
import { WebhookProviderAdapter } from "../backends/webhook-provider.js";
import { ProviderRegistry } from "./registry.js";
import { verifySignature } from "./webhook.js";

export function createCallbackRouter(
  taskStore: TaskStore,
  webhookAdapter: WebhookProviderAdapter,
  registry: ProviderRegistry,
): ExpressRouter {
  const router = ExpressRouter();

  // Use raw body parsing on this route for HMAC verification
  router.post(
    "/callbacks/task/:taskId",
    raw({ type: "application/json" }),
    (req: Request, res: Response) => {
      void handleCallback(req, res, taskStore, webhookAdapter, registry);
    },
  );

  return router;
}

async function handleCallback(
  req: Request,
  res: Response,
  taskStore: TaskStore,
  webhookAdapter: WebhookProviderAdapter,
  registry: ProviderRegistry,
): Promise<void> {
  const taskId = String(req.params["taskId"]);

  // Validate required headers
  const rawProviderId = req.headers[WEBHOOK_PROVIDER_ID_HEADER];
  const rawSignature = req.headers[WEBHOOK_SIGNATURE_HEADER];
  const providerId = Array.isArray(rawProviderId) ? rawProviderId[0] : rawProviderId;
  const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;

  if (!providerId || !signature) {
    res.status(400).json({ error: "Missing required headers" });
    return;
  }

  // Look up provider
  const provider = registry.getProvider(providerId);
  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  // Verify HMAC signature
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : String(req.body);
  if (!verifySignature(rawBody, signature, provider.webhook_secret)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Parse and validate payload
  let payload;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    payload = CallbackPayloadSchema.parse(parsed);
  } catch (err) {
    res.status(400).json({ error: "Invalid payload", details: err instanceof Error ? err.message : String(err) });
    return;
  }

  // Find the task — taskId here is the original task UUID
  const task = taskStore.getTask(taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (!task.backend_task_id) {
    res.status(400).json({ error: "Task has no backend assignment" });
    return;
  }

  // Verify the calling provider actually owns this task
  const taskOwnerId = webhookAdapter.getProviderIdForTask(task.backend_task_id);
  if (taskOwnerId !== providerId) {
    res.status(403).json({ error: "Provider does not own this task" });
    return;
  }

  // Map callback status to TaskStatus
  const newStatus = payload.status === "completed" ? TaskStatus.COMPLETED : TaskStatus.FAILED;

  // Update the adapter's internal status cache
  const backendStatus = {
    status: newStatus,
    proof: payload.proof as ProofSubmission[] | undefined,
    cost_usd: payload.actual_cost_usd,
  };
  webhookAdapter.updateTaskStatus(task.backend_task_id, backendStatus);

  // Update task in store
  const updates: Record<string, unknown> = {
    status: newStatus,
  };

  if (payload.proof && payload.proof.length > 0) {
    updates["proof"] = payload.proof;
  }
  if (payload.actual_cost_usd !== undefined) {
    updates["cost_usd"] = payload.actual_cost_usd;
  }
  if (newStatus === TaskStatus.COMPLETED) {
    updates["completed_at"] = new Date().toISOString();
  }
  if (newStatus === TaskStatus.FAILED && payload.notes) {
    updates["error"] = payload.notes;
  }

  taskStore.updateTask(taskId, updates);

  // Update provider stats
  registry.updateProviderStats(providerId, payload.status);
  provider.last_seen_at = new Date().toISOString();

  console.error(`[callback] Task ${taskId} updated to ${newStatus} by provider ${provider.name}`);
  res.status(200).json({ received: true });
}

import { Router as ExpressRouter, raw } from "express";
import type { Request, Response } from "express";
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_PROVIDER_ID_HEADER } from "../../constants.js";
import { CallbackPayloadSchema } from "../../schemas/task.js";
import { TaskStatus, ProofSubmission } from "../../types.js";

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
]);
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

  // Use raw body parsing on this route for HMAC verification.
  // Wrap the async handler in a top-level try/catch so any unhandled rejection
  // is converted into a 500 instead of becoming an UnhandledPromiseRejection
  // (which on Node >=15 default-terminates the process).
  router.post(
    "/callbacks/task/:taskId",
    raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      try {
        await handleCallback(req, res, taskStore, webhookAdapter, registry);
      } catch (err) {
        console.error(`[callback] Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      }
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

  // Verify HMAC signature. The raw body Buffer is load-bearing — the
  // signature was computed over the bytes the provider POSTed, not over a
  // re-serialised JSON string. If the body has already been parsed (e.g.
  // express.json() was mounted before this router) we cannot recover the
  // exact bytes and verification would be unsafe. Fail loudly instead of
  // falling back to String(req.body), which would silently produce 401s.
  if (!Buffer.isBuffer(req.body)) {
    console.error("[callback] Raw body missing — express.json() likely mounted before callback router");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }
  const rawBody = req.body.toString("utf-8");
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

  // Reject callbacks for tasks already in a terminal state. This blocks
  // replay attacks (re-sending a captured callback inflates provider stats
  // and overwrites proof/cost) and prevents a provider from flipping a
  // user-cancelled task back to completed. Runs BEFORE the ownership check
  // because the per-task ownership map is dropped when a task hits terminal
  // state — otherwise a legitimate late callback would surface as 403.
  if (TERMINAL_STATUSES.has(task.status)) {
    res.status(409).json({
      error: "Task already in terminal state",
      current_status: task.status,
    });
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

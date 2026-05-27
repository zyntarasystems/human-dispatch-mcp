import http from "node:http";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

import { WEBHOOK_PROVIDER_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "../constants.js";
import { ProviderRegistrationSchema } from "../schemas/task.js";
import { signPayload } from "../services/providers/webhook.js";
import {
  BackendAdapter,
  BackendCapabilities,
  BackendId,
  ProofType,
  QualitySLA,
  Task,
  TaskCategory,
  TaskRequest,
  TaskStatus,
  TaskType,
  WebhookProvider,
} from "../types.js";

export const TEST_WEBHOOK_SECRET = "test-secret-for-hmac-signatures-123456";

export type ProviderParams = z.infer<typeof ProviderRegistrationSchema>;

export function validProviderParams(overrides: Partial<ProviderParams> = {}): ProviderParams {
  return {
    name: "Regression Provider",
    webhook_url: "https://provider.example.com/webhook",
    webhook_secret: TEST_WEBHOOK_SECRET,
    categories: [TaskCategory.DIGITAL_MICRO],
    task_types: [TaskType.DIGITAL],
    regions: ["*"],
    min_budget_usd: 0,
    max_budget_usd: 100,
    max_concurrent_tasks: 2,
    ...overrides,
  };
}

export function validTaskRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    description: "Complete a focused regression task for validation",
    category: TaskCategory.DIGITAL_MICRO,
    task_type: TaskType.DIGITAL,
    budget: { max_usd: 5, currency: "USD" },
    deadline: { complete_by: "2099-01-15T18:00:00Z", urgency: "low" },
    proof_required: [ProofType.TEXT_REPORT],
    quality_sla: QualitySLA.LOW,
    ...overrides,
  };
}

export function validBackendCapabilities(
  id: BackendId,
  overrides: Partial<BackendCapabilities> = {},
): BackendCapabilities {
  return {
    id,
    name: id,
    supports_physical: true,
    supports_digital: true,
    supports_location: true,
    available_regions: ["*"],
    min_budget_usd: 0,
    max_budget_usd: 10000,
    avg_completion_minutes: 60,
    requires_api_key: false,
    configured: true,
    ...overrides,
  };
}

export class StubBackendAdapter implements BackendAdapter {
  readonly id: BackendId;
  private readonly capabilities: BackendCapabilities;
  private readonly configured: boolean;
  readonly submittedTasks: Task[] = [];

  constructor(
    id: BackendId,
    options: {
      configured?: boolean;
      capabilities?: Partial<BackendCapabilities>;
      backendTaskId?: string;
      submitError?: Error;
    } = {},
  ) {
    this.id = id;
    this.configured = options.configured ?? true;
    this.capabilities = validBackendCapabilities(id, {
      configured: this.configured,
      ...options.capabilities,
    });
    this.backendTaskId = options.backendTaskId ?? `${id}-task`;
    this.submitError = options.submitError;
  }

  private readonly backendTaskId: string;
  private readonly submitError: Error | undefined;

  getCapabilities(): BackendCapabilities {
    return this.capabilities;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async submitTask(task: Task): Promise<{ backend_task_id: string }> {
    this.submittedTasks.push(task);
    if (this.submitError) throw this.submitError;
    return { backend_task_id: this.backendTaskId };
  }

  async getStatus(): Promise<{ status: TaskStatus }> {
    return { status: TaskStatus.ROUTED };
  }

  async cancelTask(): Promise<boolean> {
    return true;
  }
}

export type CapturedToolHandler = (params: unknown) => unknown | Promise<unknown>;

export function createToolCapture(): {
  server: McpServer;
  handlers: Map<string, CapturedToolHandler>;
} {
  const handlers = new Map<string, CapturedToolHandler>();
  const server = {
    tool(name: string, _description: string, _shape: unknown, handler: CapturedToolHandler) {
      handlers.set(name, handler);
    },
  };
  return { server: server as unknown as McpServer, handlers };
}

export function signedCallback(provider: WebhookProvider, payload: unknown): {
  body: string;
  headers: Record<string, string>;
} {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      [WEBHOOK_PROVIDER_ID_HEADER]: provider.id,
      [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signPayload(body, provider.webhook_secret)}`,
    },
  };
}

export async function withHttpServer(app: express.Express): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

export async function captureConsoleError<T>(fn: () => Promise<T> | T): Promise<{
  result: T;
  messages: string[];
}> {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, messages };
  } finally {
    console.error = original;
  }
}

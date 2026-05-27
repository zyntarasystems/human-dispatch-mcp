#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { SERVER_NAME, SERVER_VERSION, DEFAULT_PORT } from "./constants.js";
import { BackendAdapter, BackendId } from "./types.js";
import { TaskStore } from "./services/task-store.js";
import { Router } from "./services/router.js";
import { WebhookProviderAdapter } from "./services/backends/webhook-provider.js";
import { ManualAdapter } from "./services/backends/manual.js";
import { ProviderRegistry } from "./services/providers/registry.js";
import { createCallbackRouter } from "./services/providers/callback-handler.js";
import { startTaskReaper } from "./services/task-reaper.js";
import { registerDispatchTool } from "./tools/dispatch.js";
import { registerStatusTool } from "./tools/status.js";
import { registerCancelTool } from "./tools/cancel.js";
import { registerListTool } from "./tools/list.js";
import { registerBackendsTool } from "./tools/backends.js";
import { registerProviderTools } from "./tools/providers.js";
import { requireBearerAuth } from "./services/security/http-auth.js";

interface ServerDeps {
  taskStore: TaskStore;
  router: Router;
  adapterMap: Map<BackendId, BackendAdapter>;
  adapters: BackendAdapter[];
  registry: ProviderRegistry;
}

/**
 * Build a fresh McpServer with all tools registered against the shared
 * dependencies. For stdio transport this is called once at startup; for HTTP
 * transport it is called per /mcp request so concurrent requests do not
 * share an McpServer instance (which would accumulate transport listeners
 * and risk cross-routing of responses).
 */
function buildMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerDispatchTool(server, deps.taskStore, deps.router);
  registerStatusTool(server, deps.taskStore, deps.adapterMap);
  registerCancelTool(server, deps.taskStore, deps.adapterMap);
  registerListTool(server, deps.taskStore);
  registerBackendsTool(server, deps.adapters);
  registerProviderTools(server, deps.registry);
  return server;
}

async function main(): Promise<void> {
  // Provider registry
  const registry = new ProviderRegistry();
  await registry.seedFromEnv();

  // Backend adapters
  const webhookAdapter = new WebhookProviderAdapter(registry);
  const adapters: BackendAdapter[] = [
    webhookAdapter,
    new ManualAdapter(),
  ];

  const adapterMap = new Map<BackendId, BackendAdapter>(
    adapters.map(a => [a.id, a]),
  );

  for (const adapter of adapters) {
    const caps = adapter.getCapabilities();
    console.error(`[init] Backend ${caps.name}: configured=${caps.configured}`);
  }

  const taskStore = new TaskStore();
  const router = new Router(adapters, taskStore);

  // Start the periodic reaper so tasks past their deadline release their
  // provider's capacity slot rather than leaking current_task_count.
  startTaskReaper(taskStore, webhookAdapter);

  const deps: ServerDeps = { taskStore, router, adapterMap, adapters, registry };

  // Select transport and start
  const transport = process.env["TRANSPORT"] || "stdio";

  if (transport === "http") {
    const portRaw = process.env["PORT"];
    const portParsed = portRaw ? parseInt(portRaw, 10) : DEFAULT_PORT;
    const port = Number.isFinite(portParsed) && portParsed > 0 && portParsed <= 65535
      ? portParsed
      : DEFAULT_PORT;
    if (port !== portParsed) {
      console.error(`[init] Invalid PORT='${portRaw}', falling back to ${DEFAULT_PORT}`);
    }

    const authToken = process.env["MCP_AUTH_TOKEN"];
    if (!authToken || authToken.length < 32) {
      console.error(
        "[init] MCP_AUTH_TOKEN must be set to a >=32-char secret when TRANSPORT=http. " +
        "Generate one with: node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))'. " +
        "Refusing to start.",
      );
      process.exit(1);
    }

    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

    const app = express();

    // Mount callback router BEFORE express.json() so it can use raw body for HMAC.
    // Order is load-bearing: any body-parsing middleware before this consumes the
    // raw bytes and breaks signature verification silently.
    app.use(createCallbackRouter(taskStore, webhookAdapter, registry));

    app.use(express.json());

    const mcpAuth = requireBearerAuth(authToken);
    app.post("/mcp", mcpAuth, async (req, res) => {
      // Per-request McpServer: avoids the SDK pattern where re-connecting
      // a shared server to a new transport accumulates listeners and can
      // cross-route responses under concurrent requests (audit adv-014).
      const server = buildMcpServer(deps);
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts,
      });
      res.on("close", () => {
        httpTransport.close().catch(console.error);
        server.close().catch(console.error);
      });
      await server.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
    });

    console.error(`[warn] HTTP transport is active. Ensure a TLS-terminating reverse proxy is in front of this server. Never expose port directly.`);
    app.listen(port, "127.0.0.1", () => {
      console.error(`[init] ${SERVER_NAME} v${SERVER_VERSION} listening on http://127.0.0.1:${port}/mcp (Streamable HTTP)`);
    });
  } else {
    const server = buildMcpServer(deps);
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error(`[init] ${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

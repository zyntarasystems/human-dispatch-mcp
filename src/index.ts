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
import { registerDispatchTool } from "./tools/dispatch.js";
import { registerStatusTool } from "./tools/status.js";
import { registerCancelTool } from "./tools/cancel.js";
import { registerListTool } from "./tools/list.js";
import { registerBackendsTool } from "./tools/backends.js";
import { registerProviderTools } from "./tools/providers.js";
import { requireBearerAuth } from "./services/security/http-auth.js";

async function main(): Promise<void> {
  // 1. Create MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // 2. Initialize provider registry
  const registry = new ProviderRegistry();
  registry.seedFromEnv();

  // 3. Initialize backend adapters
  const webhookAdapter = new WebhookProviderAdapter(registry);
  const adapters: BackendAdapter[] = [
    webhookAdapter,
    new ManualAdapter(),
  ];

  const adapterMap = new Map<BackendId, BackendAdapter>(
    adapters.map(a => [a.id, a]),
  );

  // Log backend status
  for (const adapter of adapters) {
    const caps = adapter.getCapabilities();
    console.error(`[init] Backend ${caps.name}: configured=${caps.configured}`);
  }

  // 4. Initialize TaskStore
  const taskStore = new TaskStore();

  // 5. Initialize Router
  const router = new Router(adapters, taskStore);

  // 6. Register all tools
  registerDispatchTool(server, taskStore, router);
  registerStatusTool(server, taskStore, adapterMap);
  registerCancelTool(server, taskStore, adapterMap);
  registerListTool(server, taskStore);
  registerBackendsTool(server, adapters);
  registerProviderTools(server, registry);

  // 7. Select transport and start
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
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts,
      });
      res.on("close", () => {
        httpTransport.close().catch(console.error);
      });
      await server.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
    });

    console.error(`[warn] HTTP transport is active. Ensure a TLS-terminating reverse proxy is in front of this server. Never expose port directly.`);
    app.listen(port, "127.0.0.1", () => {
      console.error(`[init] ${SERVER_NAME} v${SERVER_VERSION} listening on http://127.0.0.1:${port}/mcp (Streamable HTTP)`);
    });
  } else {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error(`[init] ${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

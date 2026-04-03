#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { SERVER_NAME, SERVER_VERSION, DEFAULT_PORT } from "./constants.js";
import { BackendAdapter, BackendId } from "./types.js";
import { TaskStore } from "./services/task-store.js";
import { Router } from "./services/router.js";
import { MTurkAdapter } from "./services/backends/mturk.js";
import { RentAHumanAdapter } from "./services/backends/rentahuman.js";
import { ManualAdapter } from "./services/backends/manual.js";
import { registerDispatchTool } from "./tools/dispatch.js";
import { registerStatusTool } from "./tools/status.js";
import { registerCancelTool } from "./tools/cancel.js";
import { registerListTool } from "./tools/list.js";
import { registerBackendsTool } from "./tools/backends.js";

async function main(): Promise<void> {
  // 1. Create MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // 2. Initialize backend adapters
  const adapters: BackendAdapter[] = [
    new MTurkAdapter(),
    new RentAHumanAdapter(),
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

  // 3. Initialize TaskStore
  const taskStore = new TaskStore();

  // 4. Initialize Router
  const router = new Router(adapters, taskStore);

  // 5. Register all tools
  registerDispatchTool(server, taskStore, router);
  registerStatusTool(server, taskStore, adapterMap);
  registerCancelTool(server, taskStore, adapterMap);
  registerListTool(server, taskStore);
  registerBackendsTool(server, adapters);

  // 6. Select transport and start
  const transport = process.env["TRANSPORT"] || "stdio";

  if (transport === "http") {
    const port = parseInt(process.env["PORT"] || String(DEFAULT_PORT), 10);
    const app = express();
    app.use(express.json());

    app.post("/mcp", async (req, res) => {
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
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

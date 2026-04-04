#!/usr/bin/env node

// A minimal test provider that accepts tasks and responds correctly.
// Usage:
//   1. node test-provider.mjs
//   2. In another terminal: ngrok http 4444
//   3. Register the ngrok HTTPS URL as a provider in MCP Inspector
//   4. Dispatch a task — it should be accepted

import { createServer } from "node:http";
import { createHmac } from "node:crypto";

const PORT = 4444;
const SECRET = "test-secret-that-is-at-least-32-characters-long!!";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const event = req.headers["x-dispatch-event"];
    const taskId = req.headers["x-dispatch-taskid"];
    const signature = req.headers["x-dispatch-signature"];

    // Verify HMAC
    const expected = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    const valid = expected === signature;

    console.log(`\n━━━ ${event} ━━━`);
    console.log(`Task ID:   ${taskId}`);
    console.log(`Signature: ${valid ? "✓ valid" : "✗ INVALID"}`);

    if (event === "provider.verify") {
      console.log("→ Verification ping received");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (event === "task.cancel") {
      console.log("→ Cancel request received");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cancelled: true }));
      return;
    }

    // task.new — accept and assign an external ID
    const payload = JSON.parse(body);
    const externalId = `TEST-${Date.now()}`;

    console.log(`Description: ${payload.description}`);
    console.log(`Category:    ${payload.category}`);
    console.log(`Budget:      $${payload.budget?.max_usd}`);
    console.log(`→ Accepting with external_id: ${externalId}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, external_id: externalId }));
  });
});

server.listen(PORT, () => {
  console.log(`Test provider listening on http://localhost:${PORT}`);
  console.log(`Secret: ${SECRET}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Run: ngrok http ${PORT}`);
  console.log(`  2. Copy the https://xxxx.ngrok-free.app URL`);
  console.log(`  3. In MCP Inspector, call human_register_provider with:`);
  console.log(`     {`);
  console.log(`       "name": "Local Test Provider",`);
  console.log(`       "webhook_url": "<your-ngrok-url>",`);
  console.log(`       "webhook_secret": "${SECRET}",`);
  console.log(`       "categories": ["digital_micro", "errand", "photo_video"],`);
  console.log(`       "task_types": ["digital", "physical", "hybrid"],`);
  console.log(`       "regions": ["*"],`);
  console.log(`       "min_budget_usd": 0,`);
  console.log(`       "max_budget_usd": 10000,`);
  console.log(`       "max_concurrent_tasks": 50`);
  console.log(`     }`);
  console.log(`  4. Dispatch a task — should show backend_id: "webhook_provider"`);
});

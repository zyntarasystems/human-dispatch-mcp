import test from "node:test";
import assert from "node:assert/strict";

import { registerStatusTool } from "./status.js";
import { TaskStore } from "../services/task-store.js";
import { BackendId, TaskStatus } from "../types.js";
import { createToolCapture, validTaskRequest } from "../test/helpers.js";

test("human_get_task_status does not poll backends for terminal tasks", async () => {
  const store = new TaskStore();
  const task = store.createTask(validTaskRequest());
  store.updateTask(task.id, {
    status: TaskStatus.COMPLETED,
    backend_id: BackendId.WEBHOOK_PROVIDER,
    backend_task_id: "provider-task",
  });

  let polled = false;
  const adapters = new Map([
    [BackendId.WEBHOOK_PROVIDER, {
      async getStatus() {
        polled = true;
        return { status: TaskStatus.ROUTED };
      },
    }],
  ]);

  const { server, handlers } = createToolCapture();
  registerStatusTool(server, store, adapters as never);

  const result = await handlers.get("human_get_task_status")?.({ task_id: task.id }) as {
    content: Array<{ text: string }>;
  };
  const body = JSON.parse(result.content[0]!.text) as { status: string };

  assert.equal(polled, false);
  assert.equal(body.status, TaskStatus.COMPLETED);
});

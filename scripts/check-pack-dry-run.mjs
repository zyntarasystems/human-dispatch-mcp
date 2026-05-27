#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const cacheDir = mkdtempSync(join(tmpdir(), "human-dispatch-mcp-npm-cache-"));

const result = spawnSync(npmBin, ["pack", "--dry-run", "--cache", cacheDir], {
  stdio: "inherit",
});

if (result.error) {
  console.error(`[pack-dry-run] Failed to launch npm pack: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

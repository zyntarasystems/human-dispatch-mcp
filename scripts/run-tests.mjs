#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const coverage = process.argv.includes("--coverage");
const root = "dist-test";
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

function collectTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(path));
    } else if (entry.isFile() && path.endsWith(".test.js")) {
      files.push(path);
    }
  }
  return files;
}

let tests = [];
try {
  if (statSync(root).isDirectory()) {
    tests = collectTests(root).sort();
  }
} catch {
  tests = [];
}

if (tests.length === 0) {
  console.error(`[test] No compiled test files found under ${root}. Refusing to pass with zero tests.`);
  process.exit(1);
}

console.error(`[test] Running ${tests.length} compiled test file(s):`);
for (const file of tests) {
  console.error(`[test] - ${relative(process.cwd(), file)}`);
}

const args = ["--test"];
if (coverage) {
  if (nodeMajor >= 22) {
    args.push("--experimental-test-coverage");
  } else {
    console.error(
      `[test] Coverage reporting requires Node >=22; current Node is ${process.versions.node}. ` +
      "Running tests without coverage on this runtime.",
    );
  }
}
args.push(...tests);

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
});

if (result.error) {
  console.error(`[test] Failed to launch node:test: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

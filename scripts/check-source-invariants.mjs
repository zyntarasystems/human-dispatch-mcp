#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["src/tools"];
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile() || !path.endsWith(".ts")) continue;
    const source = readFileSync(path, "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\bis_active\s*=/.test(line)) {
        violations.push(`${relative(process.cwd(), path)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

for (const root of roots) {
  walk(root);
}

if (violations.length > 0) {
  console.error("[source-invariants] Direct provider.is_active mutation is not allowed in src/tools:");
  for (const violation of violations) {
    console.error(`[source-invariants] ${violation}`);
  }
  process.exit(1);
}

console.log("[source-invariants] OK");

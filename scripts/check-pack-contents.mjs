#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const dist = "dist";
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "__tests__") {
        violations.push(relative(process.cwd(), path));
      }
      walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.test\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(path)) {
      violations.push(relative(process.cwd(), path));
    }
  }
}

if (existsSync(dist)) {
  walk(dist);
}

if (violations.length > 0) {
  console.error("[pack-contents] Test artifacts found in production dist:");
  for (const violation of violations) {
    console.error(`[pack-contents] ${violation}`);
  }
  process.exit(1);
}

console.log("[pack-contents] OK");

#!/usr/bin/env node
// Pre-publish gate: every place that holds the version or mcp identifier
// must agree, or we'll ship a package whose registry manifest doesn't
// match its runtime banner. Failing here is much cheaper than yanking.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), "..");

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

const pkg = readJson("package.json");
const server = readJson("server.json");
const constants = readFileSync(join(repoRoot, "src/constants.ts"), "utf8");

function pickConstant(name) {
  const m = constants.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
  if (!m) {
    console.error(`[check-versions] Could not find ${name} in src/constants.ts`);
    process.exit(1);
  }
  return m[1];
}

const constantsVersion = pickConstant("SERVER_VERSION");
const constantsName = pickConstant("SERVER_NAME");
const serverPackageVersion = server.packages?.[0]?.version;
const serverPackageIdentifier = server.packages?.[0]?.identifier;

const checks = [
  ["package.json:version === server.json:version",
    pkg.version, server.version],
  ["package.json:version === server.json:packages[0].version",
    pkg.version, serverPackageVersion],
  ["package.json:version === src/constants.ts SERVER_VERSION",
    pkg.version, constantsVersion],
  ["package.json:name === server.json:packages[0].identifier",
    pkg.name, serverPackageIdentifier],
  ["package.json:name === src/constants.ts SERVER_NAME",
    pkg.name, constantsName],
  ["package.json:mcpName === server.json:name",
    pkg.mcpName, server.name],
];

let failed = false;
for (const [label, a, b] of checks) {
  if (a !== b) {
    console.error(`[check-versions] MISMATCH: ${label}`);
    console.error(`                 ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    failed = true;
  }
}

if (failed) {
  console.error("[check-versions] Bump all three files in lockstep before publishing.");
  process.exit(1);
}

console.log(`[check-versions] OK — version=${pkg.version}, name=${pkg.name}, mcpName=${pkg.mcpName}`);

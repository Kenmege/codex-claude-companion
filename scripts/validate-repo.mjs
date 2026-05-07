#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);

const required = [
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  "commands/review.md",
  "commands/adversarial-review.md",
  "commands/elite-review.md",
  "commands/deep-review.md",
  "commands/security-review.md",
  "commands/setup.md",
  "commands/status.md",
  "commands/result.md",
  "commands/cancel.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/architecture.md",
  "scripts/claude-review-companion.mjs",
  "scripts/bin/git-safe.mjs",
  "schemas/review-output.schema.json",
  "schemas/elite-review-output.schema.json",
  "schemas/agentic-review-output.schema.json"
];

for (const relative of required) {
  const fullPath = path.join(root, relative);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${relative}`);
  }
}

const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const marketplaceManifest = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/elite-review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/agentic-review-output.schema.json"), "utf8"));

if (!Array.isArray(pluginManifest.interface?.defaultPrompt) || pluginManifest.interface.defaultPrompt.length === 0) {
  throw new Error("plugin.json interface.defaultPrompt must be a non-empty array.");
}

if (pluginManifest.interface.defaultPrompt.length > 3) {
  throw new Error("plugin.json interface.defaultPrompt must contain at most 3 prompts.");
}

if (packageJson.version !== pluginManifest.version) {
  throw new Error("package.json and .codex-plugin/plugin.json versions must match.");
}

if (marketplaceManifest.name !== "claude-review-private") {
  throw new Error(".agents/plugins/marketplace.json must keep the private marketplace name claude-review-private.");
}

const marketplacePlugin = marketplaceManifest.plugins?.find((entry) => entry?.name === pluginManifest.name);
if (!marketplacePlugin) {
  throw new Error(".agents/plugins/marketplace.json must expose the .codex-plugin plugin name.");
}

if (marketplacePlugin.source?.source !== "local" || marketplacePlugin.source?.path !== ".") {
  throw new Error(".agents/plugins/marketplace.json must install claude-review from the private repo root.");
}

if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  throw new Error("package-lock.json version metadata must match package.json.");
}

if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
  throw new Error("package.json files must explicitly list publishable contents.");
}

for (const file of [
  "scripts/claude-review-companion.mjs",
  "scripts/bin/git-safe.mjs",
  ...fs.readdirSync(path.join(root, "scripts", "lib")).map((name) => path.join("scripts", "lib", name))
]) {
  const result = spawnSync("node", ["--check", path.join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Syntax check failed for ${file}\n${result.stderr || result.stdout}`);
  }
}

console.log("Repository validation passed.");

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);

const required = [
  ".codex-plugin/plugin.json",
  "commands/review.md",
  "commands/adversarial-review.md",
  "commands/elite-review.md",
  "commands/setup.md",
  "commands/status.md",
  "commands/result.md",
  "commands/cancel.md",
  "scripts/claude-review-companion.mjs",
  "schemas/review-output.schema.json",
  "schemas/elite-review-output.schema.json"
];

for (const relative of required) {
  const fullPath = path.join(root, relative);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${relative}`);
  }
}

const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/elite-review-output.schema.json"), "utf8"));

if (!Array.isArray(pluginManifest.interface?.defaultPrompt) || pluginManifest.interface.defaultPrompt.length === 0) {
  throw new Error("plugin.json interface.defaultPrompt must be a non-empty array.");
}

if (pluginManifest.interface.defaultPrompt.length > 3) {
  throw new Error("plugin.json interface.defaultPrompt must contain at most 3 prompts.");
}

for (const file of [
  "scripts/claude-review-companion.mjs",
  ...fs.readdirSync(path.join(root, "scripts", "lib")).map((name) => path.join("scripts", "lib", name))
]) {
  const result = spawnSync("node", ["--check", path.join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Syntax check failed for ${file}\n${result.stderr || result.stdout}`);
  }
}

console.log("Repository validation passed.");

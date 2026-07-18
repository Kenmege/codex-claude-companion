#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const required = [
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  "commands/review.md",
  "commands/adversarial-review.md",
  "commands/elite-review.md",
  "commands/deep-review.md",
  "commands/security-review.md",
  "commands/workspace.md",
  "commands/enable.md",
  "commands/doctor.md",
  "commands/setup.md",
  "commands/status.md",
  "commands/result.md",
  "commands/cancel.md",
  "commands/delegate.md",
  "commands/wait.md",
  "commands/logs.md",
  "commands/recover.md",
  "commands/list.md",
  "commands/attach.md",
  "commands/send.md",
  "commands/bridge-doctor.md",
  "skills/claude-review/SKILL.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/security_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/claude-review-prompt.md",
  ".github/workflows/claude.yml",
  "docs/architecture.md",
  "scripts/claude-review-companion.mjs",
  "scripts/bridge-broker.mjs",
  "scripts/bin/git-safe.mjs",
  "plugins/codex/scripts/app-server-broker.mjs",
  "schemas/review-output.schema.json",
  "schemas/elite-review-output.schema.json",
  "schemas/agentic-review-output.schema.json",
  "schemas/bridge-delegation-request.schema.json",
  "schemas/bridge-event.schema.json",
  "schemas/bridge-message-operation.schema.json",
  "schemas/bridge-result.schema.json",
  "schemas/bridge-receipt.schema.json",
  "docs/bridge-capabilities.md",
  "docs/bridge-migration.md",
  "docs/bridge-runtime-compatibility.md"
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
const currentReleaseNotes = `RELEASE_NOTES_v${packageJson.version}.md`;
if (!fs.existsSync(path.join(root, currentReleaseNotes))) {
  throw new Error(`Missing current release notes file: ${currentReleaseNotes}`);
}
const claudeWorkflow = fs.readFileSync(path.join(root, ".github/workflows/claude.yml"), "utf8");
JSON.parse(fs.readFileSync(path.join(root, "schemas/review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/elite-review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/agentic-review-output.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-delegation-request.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-event.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-message-operation.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-result.schema.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "schemas/bridge-receipt.schema.json"), "utf8"));

const bridgeMigration = fs.readFileSync(path.join(root, "docs/bridge-migration.md"), "utf8");
if (
  !bridgeMigration.includes("Codex-Claude Bridge") ||
  !bridgeMigration.includes("target repository name is `codex-claude-bridge`") ||
  !bridgeMigration.includes("target package name is `@kenmege/codex-claude-bridge`") ||
  !bridgeMigration.includes("otherwise the target package name is `codex-claude-bridge`") ||
  !bridgeMigration.includes("public npm reservation was not performed")
) {
  throw new Error("Bridge migration documentation must preserve product identity and the approval-gated npm reservation boundary.");
}

if (pluginManifest.skills !== "./skills/") {
  throw new Error('plugin.json must expose bundled Codex skills through the "skills": "./skills/" field.');
}

if (!Array.isArray(pluginManifest.interface?.defaultPrompt) || pluginManifest.interface.defaultPrompt.length === 0) {
  throw new Error("plugin.json interface.defaultPrompt must be a non-empty array.");
}

if (pluginManifest.interface.defaultPrompt.length > 3) {
  throw new Error("plugin.json interface.defaultPrompt must contain at most 3 prompts.");
}

if (packageJson.version !== pluginManifest.version) {
  throw new Error("package.json and .codex-plugin/plugin.json versions must match.");
}

if (packageJson.name !== "codex-plugin-cc") {
  throw new Error("package.json name must be the public npm package name: codex-plugin-cc.");
}

const repositoryUrl = packageJson.repository?.url?.replace(/^git\+/, "");
if (repositoryUrl !== "https://github.com/Kenmege/codex-plugin-cc.git") {
  throw new Error(
    "package.json repository.url must point at the canonical GitHub repository (with or without the git+ prefix)."
  );
}

if (
  packageJson.publishConfig?.registry !== "https://registry.npmjs.org" ||
  packageJson.publishConfig?.access !== "public" ||
  Object.hasOwn(packageJson.publishConfig, "provenance")
) {
  throw new Error("package.json publishConfig must target public npmjs publishing without package-level npm provenance.");
}

if (!/anthropics\/claude-code-action@[a-f0-9]{40}/.test(claudeWorkflow)) {
  throw new Error(".github/workflows/claude.yml must pin anthropics/claude-code-action by full commit SHA.");
}

if (/anthropics\/claude-code-action@v1/.test(claudeWorkflow)) {
  throw new Error(".github/workflows/claude.yml must not use the floating anthropics/claude-code-action@v1 ref.");
}

if (/^\s+mode:/m.test(claudeWorkflow) || /^\s+prompt-file:/m.test(claudeWorkflow)) {
  throw new Error(".github/workflows/claude.yml must use current v1 inputs, not deprecated mode or prompt-file inputs.");
}

const hasApiKeyInput = claudeWorkflow.includes("anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}");
const hasOauthInput = claudeWorkflow.includes("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
const hasFailClosedStep = claudeWorkflow.includes("Verify Claude auth secret configured");
const hasForkSecretSkip =
  claudeWorkflow.includes("IS_UNTRUSTED_FORK_PR") &&
  claudeWorkflow.includes("GitHub does not pass repository Actions secrets to forked pull_request workflows");
const hasSeparateAuthSteps =
  claudeWorkflow.includes("Run Claude auto review with OAuth") &&
  claudeWorkflow.includes("Run Claude auto review with API key") &&
  claudeWorkflow.includes("Run Claude interactive response with OAuth") &&
  claudeWorkflow.includes("Run Claude interactive response with API key");
if (!hasApiKeyInput || !hasOauthInput || !hasFailClosedStep || !hasForkSecretSkip || !hasSeparateAuthSteps) {
  throw new Error(
    ".github/workflows/claude.yml must fail closed, skip secretless fork PRs, and provide separate API-key/OAuth action steps so empty secrets do not poison Claude auth."
  );
}

// JUSTIFIED: structural rather than name-locked validation so forks
// can rename their private marketplace without lint breaking. The
// previous string-equality check on "claude-review-private" was a
// forkability bug: anyone forking this repo for their own private
// Codex marketplace would hit a hard lint failure on first
// `npm run check`. Now we enforce shape only; operator chooses the
// name.
if (typeof marketplaceManifest.name !== "string" || marketplaceManifest.name.trim() === "") {
  throw new Error(".agents/plugins/marketplace.json must declare a non-empty `name`.");
}

if (!Array.isArray(marketplaceManifest.plugins) || marketplaceManifest.plugins.length === 0) {
  throw new Error(".agents/plugins/marketplace.json must list at least one plugin.");
}

const marketplacePlugin = marketplaceManifest.plugins.find((entry) => entry?.name === pluginManifest.name);
if (!marketplacePlugin) {
  throw new Error(".agents/plugins/marketplace.json must expose the .codex-plugin plugin name.");
}

if (marketplacePlugin.source?.source !== "local" || marketplacePlugin.source?.path !== "./") {
  throw new Error(".agents/plugins/marketplace.json must install the plugin from the local repo root.");
}

if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  throw new Error("package-lock.json version metadata must match package.json.");
}

if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
  throw new Error("package.json files must explicitly list publishable contents.");
}

if (!packageJson.files.includes("skills/")) {
  throw new Error("package.json files must include bundled Codex skills.");
}

for (const file of [
  "scripts/claude-review-companion.mjs",
  "scripts/bridge-broker.mjs",
  "scripts/bin/git-safe.mjs",
  "plugins/codex/scripts/app-server-broker.mjs",
  ...fs.readdirSync(path.join(root, "scripts", "lib")).map((name) => path.join("scripts", "lib", name)),
  ...fs.readdirSync(path.join(root, "plugins", "codex", "scripts", "lib")).map((name) =>
    path.join("plugins", "codex", "scripts", "lib", name)
  )
]) {
  const result = spawnSync("node", ["--check", path.join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Syntax check failed for ${file}\n${result.stderr || result.stdout}`);
  }
}

console.log("Repository validation passed.");

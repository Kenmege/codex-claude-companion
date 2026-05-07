import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("pull request workflow cancels superseded matrix runs", () => {
  const source = read(".github/workflows/pull-request-ci.yml");
  assert.match(source, /concurrency:/);
  assert.match(source, /group: pr-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(source, /cancel-in-progress: true/);
});

test("package files list excludes bump-version from the shipped tarball surface", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.ok(packageJson.files.includes("scripts/claude-review-companion.mjs"));
  assert.ok(packageJson.files.includes("scripts/bin/"));
  assert.ok(packageJson.files.includes("scripts/lib/"));
  assert.ok(!packageJson.files.includes("scripts/"));
});

test("public-facing docs do not contain private local machine paths", () => {
  for (const relativePath of [
    "README.md",
    "docs/CODEX_ELITE_SHIP_PROMPT.md",
    "commands/review.md",
    "commands/adversarial-review.md",
    "commands/elite-review.md",
    "commands/deep-review.md",
    "commands/security-review.md",
    "commands/setup.md",
    "commands/status.md",
    "commands/result.md",
    "commands/cancel.md"
  ]) {
    assert.doesNotMatch(read(relativePath), /\/Users\/kenmege/, relativePath);
  }
});

test("Copilot code review instructions are present for GitHub review agents", () => {
  const source = read(".github/copilot-instructions.md");
  assert.match(source, /Copilot Code Review Instructions/);
  assert.match(source, /security-sensitive CLI plugin/);
  assert.match(source, /JSON schemas and `validateStructuredReviewOutput` stay in sync/);
});

test("security docs describe inherit-mcp Task subagent trust expansion", () => {
  const architecture = read("docs/architecture.md");
  const security = read("SECURITY.md");
  for (const source of [architecture, security]) {
    assert.match(source, /--inherit-mcp/);
    assert.match(source, /Task subagents?/i);
    assert.match(source, /second-order trust expansion|expands trust indirectly/i);
    assert.match(source, /docs\.anthropic\.com\/en\/docs\/claude-code\/sub-agents/);
  }
});

test("release checklist documents GitHub publish switch, npm token, and v-tag trigger", () => {
  const source = read("CONTRIBUTING.md");
  assert.match(source, /NPM_PUBLISH_ENABLED=true/);
  assert.match(source, /NPM_TOKEN/);
  assert.match(source, /v\*\.\*\.\*/);
});

test("architecture docs reference the exported structured parser name", () => {
  const source = read("docs/architecture.md");
  assert.match(source, /parseClaudeStructuredOutput/);
  assert.doesNotMatch(source, new RegExp("parseClaudeStructured" + "Review"));
});

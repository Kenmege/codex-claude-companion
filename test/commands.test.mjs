import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildJobRecord, createJob, readJob, writeJobInput } from "../scripts/lib/state.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const helper = path.join(root, "scripts", "claude-review-companion.mjs");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

function makeDirtyRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-command-"));
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test User");
  fs.writeFileSync(path.join(cwd, "index.js"), "const value = 1;\n", "utf8");
  git(cwd, "add", "index.js");
  git(cwd, "commit", "-m", "initial");
  fs.writeFileSync(path.join(cwd, "index.js"), "const value = 2;\n", "utf8");
  return cwd;
}

function withFakeClaudeForReview(stdout) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-command-bin-"));
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(
    claudePath,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
      "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
      "cat <<'EOF'",
      stdout,
      "EOF"
    ].join("\n"),
    { mode: 0o755 }
  );
  return {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
  };
}

function validBasicStructuredStream() {
  return JSON.stringify({
    type: "result",
    structured_output: {
      verdict: "ok",
      summary: "No blockers.",
      findings: [],
      next_steps: []
    }
  });
}

function basicSnapshot() {
  return {
    reviewKind: "review",
    reviewLabel: "Review",
    targetLabel: "working tree diff",
    model: "claude-opus-4-7",
    effort: "high",
    profile: "quality",
    agentic: false,
    contextMode: "inline",
    notes: [],
    quiet: false
  };
}

function completedJob(cwd, jobId, result) {
  createJob(
    cwd,
    jobId,
    {
      ...buildJobRecord(cwd, jobId, { kind: "review", title: "completed job" }),
      status: "completed",
      result
    }
  );
  writeJobInput(cwd, jobId, basicSnapshot());
}

test("review command prefers the helper binary and public install guidance", () => {
  const source = read("commands/review.md");
  assert.match(source, /codex-claude-review review/);
  assert.match(source, /npm install -g \./);
  assert.doesNotMatch(source, /\/Users\/kenmege/);
  assert.match(source, /Return the helper stdout verbatim/i);
});

test("adversarial command stays read-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /Keep this command read-only/i);
  assert.match(source, /codex-claude-review adversarial-review/);
});

test("elite command exposes the exhaustive review lane", () => {
  const source = read("commands/elite-review.md");
  assert.match(source, /codex-claude-review elite-review/);
  assert.match(source, /elite adversarial review pass/i);
  assert.match(source, /Keep this command read-only/i);
});

test("plugin manifest has the expected plugin name", () => {
  const manifest = JSON.parse(read(".codex-plugin/plugin.json"));
  assert.equal(manifest.name, "claude-review");
  assert.equal(manifest.interface.displayName, "Claude Review");
  assert.ok(Array.isArray(manifest.interface.defaultPrompt));
  assert.ok(manifest.interface.defaultPrompt.length > 0);
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
});

test("deep-review command advertises agentic multi-agent mode", () => {
  const source = read("commands/deep-review.md");
  assert.match(source, /codex-claude-review deep-review/);
  assert.match(source, /max effort/i);
  assert.match(source, /sub-agents?/i);
  assert.match(source, /read-only/i);
});

test("security-review command advertises security-focused agentic mode", () => {
  const source = read("commands/security-review.md");
  assert.match(source, /codex-claude-review security-review/);
  assert.match(source, /OWASP|CWE/);
  assert.match(source, /read-only/i);
});

test("review command advertises agentic mode and read-only tools", () => {
  const source = read("commands/review.md");
  assert.match(source, /agentic/i);
  assert.match(source, /read-only/i);
  assert.match(source, /Read, Glob, Grep/);
});

test("helper rejects unsafe --add-dir before invoking Claude", () => {
  const cwd = makeDirtyRepo();
  const result = spawnSync(process.execPath, [helper, "review", "--cwd", cwd, "--add-dir", "../outside"], {
    cwd,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --add-dir path/);
});

test("helper accepts --add-dir symlink when realpath stays inside the allowed boundary", { skip: process.platform === "win32" }, () => {
  const cwd = makeDirtyRepo();
  const target = fs.mkdtempSync(path.join(path.dirname(cwd), "inside-add-dir-"));
  const link = path.join(cwd, "linked-inside");
  fs.symlinkSync(target, link, "dir");
  const fake = withFakeClaudeForReview(validBasicStructuredStream());

  const result = spawnSync(process.execPath, [helper, "review", "--legacy", "--cwd", cwd, "--add-dir", "linked-inside"], {
    cwd,
    encoding: "utf8",
    env: fake.env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: ok/);
});

test("helper rejects --add-dir symlink when realpath escapes the allowed boundary", { skip: process.platform === "win32" }, () => {
  const cwd = makeDirtyRepo();
  const link = path.join(cwd, "linked-outside");
  fs.symlinkSync(os.homedir(), link, "dir");

  const result = spawnSync(process.execPath, [helper, "review", "--legacy", "--cwd", cwd, "--add-dir", "linked-outside"], {
    cwd,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /resolves outside allowed boundary/);
});

test("helper validates --mcp-config JSON before invoking Claude", () => {
  const cwd = makeDirtyRepo();
  fs.writeFileSync(path.join(cwd, "bad-mcp.json"), "{not json", "utf8");
  const result = spawnSync(process.execPath, [helper, "review", "--cwd", cwd, "--mcp-config", "bad-mcp.json"], {
    cwd,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --mcp-config/);
});

test("setup supports machine-parseable --json output", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-setup-bin-"));
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(
    claudePath,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
      "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":false}'; exit 0; fi",
      "exit 1"
    ].join("\n"),
    { mode: 0o755 }
  );
  const result = spawnSync(process.execPath, [helper, "setup", "--cwd", root, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
  });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.ready, "boolean");
  assert.equal(typeof payload.defaults.model, "string");
  assert.equal(payload.auth.raw, undefined);
});

test("setup json redacts authenticated account identity", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-setup-bin-"));
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(
    claudePath,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
      "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"email\":\"person@example.com\",\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'; exit 0; fi",
      "echo '{\"type\":\"result\",\"structured_output\":{\"answer\":\"OK\"}}'"
    ].join("\n"),
    { mode: 0o755 }
  );
  const result = spawnSync(process.execPath, [helper, "setup", "--cwd", root, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /person@example\.com/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.auth.detail, "claude.ai auth detected");
  assert.equal(payload.auth.subscriptionType, "max");
  assert.equal(payload.auth.redacted, true);
});

test("status marks running jobs older than timeout as stalled", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-stale";
  createJob(
    cwd,
    jobId,
    {
      ...buildJobRecord(cwd, jobId, { kind: "review", title: "stale job", status: "running" }),
      updatedAt: "2000-01-01T00:00:00.000Z"
    }
  );
  writeJobInput(cwd, jobId, { timeoutMs: 1 });
  const result = spawnSync(process.execPath, [helper, "status", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /review-stale \| stalled/);
});

test("result exits 3 for a persisted job with ship-blocking findings", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-no-ship";
  completedJob(cwd, jobId, {
    verdict: "request changes",
    summary: "Blocking finding.",
    findings: [
      {
        severity: "high",
        title: "Ship blocker",
        body: "This should fail the gate.",
        file: "index.js",
        line_start: 1,
        line_end: 1,
        recommendation: "Fix before release."
      }
    ],
    next_steps: ["Fix the blocker."]
  });

  const result = spawnSync(process.execPath, [helper, "result", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 3);
  assert.match(result.stdout, /Ship blocker/);
});

test("result validates persisted job output before rendering", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-invalid-result";
  completedJob(cwd, jobId, {
    verdict: "ok",
    summary: "Missing required fields.",
    findings: []
  });

  const result = spawnSync(process.execPath, [helper, "result", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Persisted result is invalid/);
});

test("cancel marks a running job stalled when the detached pid is already dead", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-dead-pid";
  createJob(
    cwd,
    jobId,
    {
      ...buildJobRecord(cwd, jobId, { kind: "review", title: "dead pid", status: "running" }),
      pid: 2147483647,
      status: "running"
    }
  );

  const result = spawnSync(process.execPath, [helper, "cancel", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Status: stalled/);
  assert.equal(readJob(cwd, jobId).status, "stalled");
});

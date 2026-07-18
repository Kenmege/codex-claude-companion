import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildJobRecord, createJob, readJob, writeJobInput } from "../scripts/lib/state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function withFakeClaudeForReview(stdout, { version = "2.1.183" } = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-command-bin-"));
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(
    claudePath,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
      `if [ "$1" = "--version" ]; then echo '${version} (Claude Code)'; exit 0; fi`,
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
    model: "opus",
    effort: "xhigh",
    profile: "quality",
    agentic: false,
    contextMode: "inline",
    notes: [],
    quiet: false
  };
}

function eliteSnapshot() {
  return {
    ...basicSnapshot(),
    reviewKind: "elite-review",
    reviewLabel: "Elite Review"
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

function completedEliteJob(cwd, jobId, result) {
  createJob(
    cwd,
    jobId,
    {
      ...buildJobRecord(cwd, jobId, { kind: "elite-review", title: "completed elite job" }),
      status: "completed",
      result
    }
  );
  writeJobInput(cwd, jobId, eliteSnapshot());
}

test("review command prefers the helper binary and public install guidance", () => {
  const source = read("commands/review.md");
  assert.match(source, /codex-claude review/);
  assert.match(source, /npm install -g \./);
  assert.doesNotMatch(source, /\/Users\/kenmege/);
  assert.match(source, /Return the helper stdout verbatim/i);
});

test("helper help exits successfully while unknown commands remain usage errors", () => {
  for (const arg of ["--help", "-h", "help"]) {
    const result = spawnSync(process.execPath, [helper, arg], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `${arg}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /codex-claude setup/);
    assert.match(result.stdout, /Compatibility alias:\s+codex-claude-review\b/);
  }

  const unknown = spawnSync(process.execPath, [helper, "not-a-command"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stdout, /Usage:/);
});

test("helper usage advertises folder subcommand and --path flag", () => {
  const result = spawnSync(process.execPath, [helper, "--help"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-claude folder <path>/);
  assert.match(result.stdout, /--path <dir>\s+target directory/);
  assert.match(result.stdout, /--preset quick\|ship\|security\|research\|deep/);
  assert.match(result.stdout, /--exclude <basename>/);
  assert.match(result.stdout, /--scope auto\|working-tree\|branch\|directory/);
});

test("helper usage advertises split-terminal Claude workspaces and Codex supervision controls", () => {
  const result = spawnSync(process.execPath, [helper, "--help"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-claude workspace \[flags\] -- <coding request>/);
  assert.match(result.stdout, /workspace-status/);
  assert.match(result.stdout, /workspace-logs/);
  assert.match(result.stdout, /workspace-stop/);
  assert.match(result.stdout, /--panel-only/);
  assert.match(result.stdout, /--no-panel/);
  assert.doesNotMatch(result.stdout, /--codex-model/);
  assert.match(result.stdout, /--json-events/);
});

test("folder subcommand requires a positional path argument", () => {
  const result = spawnSync(process.execPath, [helper, "folder"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "folder must fail without a path");
  assert.match(result.stderr, /Expected a directory path/);
});

test("preset support routes public role workflows to rich lanes", () => {
  const source = read("scripts/claude-review-companion.mjs");
  assert.match(source, /const PRESET_CONFIG =/);
  assert.match(source, /ship:[\s\S]*reviewKind: "elite-review"/);
  assert.match(source, /security:[\s\S]*reviewKind: "security-review"/);
  assert.match(source, /research:[\s\S]*reviewKind: "deep-review"/);
  assert.match(source, /deep:[\s\S]*reviewKind: "deep-review"/);
  assert.match(source, /Preset research:[\s\S]*source quality/);
});

test("invalid preset fails as a usage error", () => {
  const result = spawnSync(process.execPath, [helper, "review", "--preset", "chaos"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid --preset "chaos"/);
  assert.match(result.stderr, /quick, ship, security, research, deep/);
});

test("doctor --json emits the full diagnostic payload with all expected keys", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-json-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  fs.writeFileSync(fakeConfig, "", "utf8");
  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8"
  });
  assert.ok(result.stdout, result.stderr);
  const payload = JSON.parse(result.stdout);
  for (const key of [
    "ok",
    "plugin_configured",
    "plugin_config_method",
    "plugin_cli_available",
    "plugin_cli_detail",
    "plugin_loaded_in_current_session",
    "requires_codex_reload",
    "helper_available",
    "helper_version",
    "node_version",
    "node_required",
    "node_supported",
    "claude_cli_available",
    "claude_cli_version",
    "claude_cli_minimum_version",
    "claude_cli_version_detail",
    "claude_authenticated",
    "claude_runtime_probe_performed",
    "claude_runtime_ready",
    "claude_runtime_detail",
    "git_available",
    "git_version",
    "job_dir",
    "job_dir_writable",
    "supports_non_git_directory",
    "prompt_transport",
    "codex_config_path",
    "codex_config_exists",
    "problems",
    "recommended_action"
  ]) {
    assert.ok(key in payload, `doctor payload missing key: ${key}`);
  }
  assert.equal(payload.prompt_transport, "stdin");
  assert.equal(payload.helper_available, true);
});

test("doctor reports PLUGIN_NOT_CONFIGURED when config is empty", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-noplug-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  fs.writeFileSync(fakeConfig, "model = \"gpt-5.5\"\n", "utf8");
  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8"
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.plugin_configured, false);
  assert.ok(payload.problems.some((p) => p.code === "PLUGIN_NOT_CONFIGURED"));
  assert.equal(payload.recommended_action, "Run `codex-claude enable` to register the plugin.");
  assert.doesNotMatch(JSON.stringify(payload.problems), /codex-claude-review/);
});

test("doctor recognizes quoted marketplace config when plugin is enabled", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-quoted-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  const safeRoot = JSON.stringify(root.split(path.sep).join("/"));
  fs.writeFileSync(
    fakeConfig,
    `[marketplaces."claude-review-private"]\nsource_type = "local"\nsource = ${safeRoot}\n\n` +
      `[plugins."claude-review@claude-review-private"]\nenabled = true\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8"
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.plugin_configured, true);
  assert.equal(payload.problems.some((p) => p.code === "PLUGIN_NOT_CONFIGURED"), false);
});

test("doctor recognizes dotted plugin config and preserves hash characters inside quoted strings", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-dotted-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  const safeRoot = JSON.stringify(root.split(path.sep).join("/"));
  fs.writeFileSync(
    fakeConfig,
    `[marketplaces."claude-review-private"]\nsource_type = "local" # real comment\nsource = ${safeRoot} # comment after string\nlabel = "path#segment"\n\n` +
      `[plugins.claude-review.claude-review-private]\nenabled = true\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8"
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.plugin_configured, true);
  assert.equal(payload.problems.some((p) => p.code === "PLUGIN_NOT_CONFIGURED"), false);
});

test("doctor requires flat TOML scalars for plugin registration fields", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-nonscalar-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  const safeRoot = JSON.stringify(root.split(path.sep).join("/"));
  fs.writeFileSync(
    fakeConfig,
    `[marketplaces.claude-review-private]\nsource_type = "local"\nsource = [\n  ${safeRoot}\n]\n\n` +
      `[plugins."claude-review@claude-review-private"]\nenabled = true\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8"
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.plugin_configured, false);
  assert.ok(payload.problems.some((p) => p.code === "PLUGIN_NOT_CONFIGURED"));
});

test("doctor ignores commented and disabled plugin stanzas", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-disabled-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  const safeRoot = JSON.stringify(root.split(path.sep).join("/"));
  fs.writeFileSync(
    fakeConfig,
    `# [marketplaces.claude-review-private]\n# source_type = "local"\n# source = ${safeRoot}\n\n` +
      `[marketplaces.claude-review-private]\nsource_type = "local"\nsource = ${safeRoot}\n\n` +
      `[plugins."claude-review@claude-review-private"]\nenabled = false\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8"
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.plugin_configured, false);
  assert.ok(payload.problems.some((p) => p.code === "PLUGIN_NOT_CONFIGURED"));
});

test("doctor JSON output is parseable on the human-readable path too", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-human-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  fs.writeFileSync(fakeConfig, "", "utf8");
  const result = spawnSync(process.execPath, [helper, "doctor", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8"
  });
  // Human-readable path: assert key labels are present.
  assert.match(result.stdout, /Helper version:/);
  assert.match(result.stdout, /Node:/);
  assert.match(result.stdout, /Plugin configured in Codex:/);
  assert.match(result.stdout, /Claude CLI available:/);
  assert.match(result.stdout, /Claude runtime probe:\s+SKIPPED/);
  assert.match(result.stdout, /Git available:/);
  assert.match(result.stdout, /Prompt transport:\s+stdin/);
  assert.match(result.stdout, /Recommended action:/);
});

test("doctor --probe-runtime reports the live runtime probe fields", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-probe-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  fs.writeFileSync(fakeConfig, "", "utf8");
  const fake = withFakeClaudeForReview(
    JSON.stringify({
      type: "result",
      structured_output: {
        answer: "ok"
      }
    })
  );
  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--probe-runtime", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8",
    env: fake.env
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.claude_cli_available, true);
  assert.equal(payload.claude_cli_version, "2.1.183");
  assert.equal(payload.claude_authenticated, true);
  assert.equal(payload.claude_runtime_probe_performed, true);
  assert.equal(payload.claude_runtime_ready, true);
});

test("doctor reports stale Claude Code versions before defaulting to xhigh reviews", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-old-claude-"));
  const fakeConfig = path.join(tmpDir, "config.toml");
  fs.writeFileSync(fakeConfig, "", "utf8");
  const fake = withFakeClaudeForReview(
    JSON.stringify({
      type: "result",
      structured_output: {
        answer: "ok"
      }
    }),
    { version: "2.1.182" }
  );

  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8",
    env: fake.env
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.claude_cli_version, "2.1.182");
  assert.equal(payload.claude_cli_minimum_version, "2.1.183");
  assert.ok(payload.problems.some((p) => p.code === "CLAUDE_VERSION_TOO_OLD"));
});

test("CODEX_CLAUDE_REVIEW_JOB_DIR env var redirects job dir via fallback chain", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-jobdir-env-"));
  const customJobDir = path.join(tmpDir, "custom-jobs");
  const fakeConfig = path.join(tmpDir, "config.toml");
  fs.writeFileSync(fakeConfig, "", "utf8");
  const result = spawnSync(process.execPath, [helper, "doctor", "--json", "--config", fakeConfig], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_CLAUDE_REVIEW_JOB_DIR: customJobDir }
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job_dir, path.resolve(customJobDir));
  assert.equal(payload.job_dir_writable, true);
});

test("errors emitted from any command honour --json with the structured envelope", () => {
  const result = spawnSync(process.execPath, [helper, "folder", "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  // stdout should carry the JSON envelope so callers parsing piped output get a useful object.
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.ok(typeof envelope.error_code === "string" && envelope.error_code.length > 0);
  assert.ok(typeof envelope.message === "string" && envelope.message.length > 0);
});

test("--job-dir flag overrides everything else", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-jobdir-flag-"));
  const customJobDir = path.join(tmpDir, "flag-jobs");
  const fakeConfig = path.join(tmpDir, "config.toml");
  fs.writeFileSync(fakeConfig, "", "utf8");
  const result = spawnSync(
    process.execPath,
    [helper, "doctor", "--json", "--config", fakeConfig, "--job-dir", customJobDir],
    { cwd: root, encoding: "utf8" }
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job_dir, path.resolve(customJobDir));
});

test("an unusable explicit --job-dir fails closed without creating workspace artifacts", () => {
  const cwd = makeDirtyRepo();
  const unusableJobDir = path.join(cwd, "not-a-directory");
  const fakeConfig = path.join(cwd, "config.toml");
  fs.writeFileSync(unusableJobDir, "regular file\n", "utf8");
  fs.writeFileSync(fakeConfig, "", "utf8");

  const result = spawnSync(
    process.execPath,
    [helper, "doctor", "--json", "--config", fakeConfig, "--job-dir", unusableJobDir],
    { cwd, encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /explicit job directory/i);
  assert.equal(fs.existsSync(path.join(cwd, ".claude-review", "jobs")), false);
});

test("review and control commands keep every artifact in an explicit --job-dir", () => {
  const cwd = makeDirtyRepo();
  const customJobDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-jobdir-e2e-"));
  const fake = withFakeClaudeForReview(validBasicStructuredStream());
  const run = spawnSync(
    process.execPath,
    [helper, "review", "--legacy", "--cwd", cwd, "--job-dir", customJobDir],
    { cwd, encoding: "utf8", env: fake.env }
  );

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const entries = fs.readdirSync(customJobDir);
  for (const suffix of [".job.json", ".input.json", ".log", ".prompt.md"]) {
    assert.ok(entries.some((entry) => entry.endsWith(suffix)), `missing ${suffix} in explicit job dir`);
  }
  assert.equal(fs.existsSync(path.join(cwd, ".claude-review", "jobs")), false);

  const jobId = entries.find((entry) => entry.endsWith(".job.json")).replace(/\.job\.json$/, "");
  const status = spawnSync(
    process.execPath,
    [helper, "status", jobId, "--cwd", cwd, "--job-dir", customJobDir],
    { cwd, encoding: "utf8" }
  );
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, new RegExp(jobId));

  const result = spawnSync(
    process.execPath,
    [helper, "result", jobId, "--cwd", cwd, "--job-dir", customJobDir],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Verdict: OK/);
});

test("status, result, and cancel reject path-like job IDs before state lookup", () => {
  const cwd = makeDirtyRepo();
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-jobid-reject-"));

  for (const command of ["status", "result", "cancel"]) {
    const result = spawnSync(
      process.execPath,
      [helper, command, "../escape", "--cwd", cwd, "--job-dir", jobDir],
      { cwd, encoding: "utf8" }
    );
    assert.equal(result.status, 1, `${command}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /Invalid job id/);
  }
});

test("adversarial command stays read-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /Keep this command read-only/i);
  assert.match(source, /codex-claude adversarial-review/);
});

test("elite command exposes the exhaustive review lane", () => {
  const source = read("commands/elite-review.md");
  assert.match(source, /codex-claude elite-review/);
  assert.match(source, /elite adversarial review pass/i);
  assert.match(source, /Keep this command read-only/i);
});

test("plugin manifest preserves the package id and exposes the bridge identity", () => {
  const manifest = JSON.parse(read(".codex-plugin/plugin.json"));
  assert.equal(manifest.name, "claude-review");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "Codex-Claude Bridge");
  assert.ok(Array.isArray(manifest.interface.defaultPrompt));
  assert.ok(manifest.interface.defaultPrompt.length > 0);
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
});

test("workspace command defines active-model Codex supervision and a writable Claude lane", () => {
  const source = read("commands/workspace.md");
  assert.match(source, /codex-claude(?:-review)? workspace/);
  assert.match(source, /active Codex (?:session )?model/i);
  assert.match(source, /write|edit files/i);
  assert.match(source, /verify|verification/i);
  assert.match(source, /review/i);
  assert.doesNotMatch(source, /dangerously-skip-permissions/);
});

test("deep-review command advertises agentic multi-agent mode", () => {
  const source = read("commands/deep-review.md");
  assert.match(source, /codex-claude deep-review/);
  assert.match(source, /max effort/i);
  assert.match(source, /sub-agents?/i);
  assert.match(source, /read-only/i);
});

test("security-review command advertises security-focused agentic mode", () => {
  const source = read("commands/security-review.md");
  assert.match(source, /codex-claude security-review/);
  assert.match(source, /OWASP|CWE/);
  assert.match(source, /read-only/i);
});

test("doctor command exposes first-run diagnostics", () => {
  const source = read("commands/doctor.md");
  assert.match(source, /codex-claude doctor/);
  assert.match(source, /--probe-runtime/);
  assert.match(source, /Node, Git, Claude Code CLI/);
});

test("review command advertises agentic mode and read-only tools", () => {
  const source = read("commands/review.md");
  assert.match(source, /agentic/i);
  assert.match(source, /read-only/i);
  assert.match(source, /Read, Glob, Grep/);
});

test("safe-mode runtime note matches the tools actually exposed to Claude", () => {
  const helperSource = read("scripts/claude-review-companion.mjs");
  assert.match(helperSource, /read-only native tools \(Read\/Glob\/Grep\/Task\/WebSearch\)/);
  assert.doesNotMatch(helperSource, /SAFE mode[^\n]*fenced git wrapper/i);
});

test("review command preserves positional focus text in the job snapshot", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeForReview(validBasicStructuredStream());
  const result = spawnSync(
    process.execPath,
    [helper, "review", "--legacy", "--cwd", cwd, "focus on rollback safety"],
    {
      cwd,
      encoding: "utf8",
      env: fake.env
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const jobsDir = path.join(cwd, ".claude-review", "jobs");
  const inputFile = fs.readdirSync(jobsDir).find((entry) => entry.endsWith(".input.json"));
  assert.ok(inputFile);
  const snapshot = JSON.parse(fs.readFileSync(path.join(jobsDir, inputFile), "utf8"));
  assert.equal(snapshot.focusText, "focus on rollback safety");
});

test("review focus text is never reinterpreted as privileged review flags", () => {
  for (const focusText of [
    "--unrestricted audit permission handling",
    "--mcp-config config must remain focus text",
    "--add-dir linked path must remain focus text",
    "--permission-mode plan must remain focus text"
  ]) {
    const cwd = makeDirtyRepo();
    const fake = withFakeClaudeForReview(validBasicStructuredStream());
    const result = spawnSync(
      process.execPath,
      [helper, "review", "--legacy", "--cwd", cwd, "--", focusText],
      { cwd, encoding: "utf8", env: fake.env }
    );

    assert.equal(result.status, 0, `${focusText}: ${result.stderr}`);
    const jobsDir = path.join(cwd, ".claude-review", "jobs");
    const inputFile = fs.readdirSync(jobsDir).find((entry) => entry.endsWith(".input.json"));
    assert.ok(inputFile);
    const snapshot = JSON.parse(fs.readFileSync(path.join(jobsDir, inputFile), "utf8"));
    assert.equal(snapshot.focusText, focusText);
    assert.equal(snapshot.unrestricted, false);
    assert.deepEqual(snapshot.mcpConfigs, []);
    assert.deepEqual(snapshot.addDirs, []);
    assert.equal(snapshot.permissionMode, "default");
  }
});

test("review rejects misspelled inline safety booleans with usage exit code", () => {
  const cwd = makeDirtyRepo();
  const result = spawnSync(
    process.execPath,
    [helper, "review", "--cwd", cwd, "--unrestricted=flase"],
    { cwd, encoding: "utf8" }
  );

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Invalid --unrestricted boolean value/i);
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
  assert.match(result.stdout, /Verdict: OK/);
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

test("helper rejects MCP config files larger than the validated byte ceiling", () => {
  const cwd = makeDirtyRepo();
  const oversized = path.join(cwd, "oversized-mcp.json");
  const prefix = '{"mcpServers":{"safe":{"command":"server"}},"padding":"';
  const suffix = '"}';
  fs.writeFileSync(oversized, `${prefix}${"x".repeat(1024 * 1024)}${suffix}`, "utf8");

  const result = spawnSync(
    process.execPath,
    [helper, "review", "--legacy", "--cwd", cwd, "--mcp-config", "oversized-mcp.json"],
    { cwd, encoding: "utf8" }
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /exceeds 1048576 bytes/);
});

test("helper binds validated MCP bytes to a private staged file and cleans it", () => {
  const cwd = makeDirtyRepo();
  const original = path.join(cwd, "mcp.json");
  const capture = path.join(cwd, "mcp-capture.json");
  const validConfig = JSON.stringify({ mcpServers: { safe: { command: "safe-server" } } });
  const swappedConfig = JSON.stringify({ mcpServers: { swapped: { command: "attacker-server" } } });
  fs.writeFileSync(original, validConfig, { encoding: "utf8", mode: 0o600 });

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-mcp-bin-"));
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(
    claudePath,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
      "if [ \"$1\" = \"--version\" ]; then echo '2.1.183 (Claude Code)'; exit 0; fi",
      "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
      `printf '%s' '${swappedConfig}' > \"$ORIGINAL_MCP\"`,
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = \"--mcp-config\" ]; then",
      "    shift",
      "    node -e 'const fs=require(\"fs\"); fs.writeFileSync(process.env.MCP_CAPTURE, JSON.stringify({path:process.argv[1], source:fs.readFileSync(process.argv[1],\"utf8\")}))' \"$1\"",
      "    break",
      "  fi",
      "  shift",
      "done",
      "cat <<'EOF'",
      validBasicStructuredStream(),
      "EOF"
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = spawnSync(
    process.execPath,
    [helper, "review", "--legacy", "--cwd", cwd, "--mcp-config", "mcp.json"],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        ORIGINAL_MCP: original,
        MCP_CAPTURE: capture
      }
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const staged = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.notEqual(staged.path, original);
  assert.deepEqual(JSON.parse(staged.source), JSON.parse(validConfig));
  assert.deepEqual(JSON.parse(fs.readFileSync(original, "utf8")), JSON.parse(swappedConfig));
  assert.equal(fs.existsSync(staged.path), false, "staged MCP file must be removed after review");
});

test("helper rejects invalid numeric safety flags before invoking Claude", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeForReview(validBasicStructuredStream());

  for (const [flag, value] of [
    ["--max-budget-usd", "nope"],
    ["--max-budget-usd", "0"],
    ["--timeout-ms", "nope"],
    ["--timeout-ms", "1m"]
  ]) {
    const result = spawnSync(process.execPath, [helper, "review", "--cwd", cwd, flag, value], {
      cwd,
      encoding: "utf8",
      env: fake.env
    });

    assert.equal(result.status, 2, `${flag} ${value}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, new RegExp(`Invalid ${flag}`));
  }
});

test("helper rejects budget caps on legacy structured reviews", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeForReview(validBasicStructuredStream());

  const result = spawnSync(process.execPath, [helper, "review", "--legacy", "--cwd", cwd, "--max-budget-usd", "5"], {
    cwd,
    encoding: "utf8",
    env: fake.env
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /--max-budget-usd requires agentic mode/);
});

test("background directory snapshots are cleaned when validation fails before worker launch", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-source-"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-snaps-"));
  fs.writeFileSync(path.join(source, "index.js"), "const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(source, "bad-mcp.json"), "{not json", "utf8");

  const result = spawnSync(
    process.execPath,
    [
      helper,
      "folder",
      source,
      "--background",
      "--snapshot-temp-root",
      tempRoot,
      "--mcp-config",
      path.join(source, "bad-mcp.json")
    ],
    { cwd: root, encoding: "utf8" }
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Invalid --mcp-config/);
  const remainingSnapshots = fs.readdirSync(tempRoot).filter((name) => name.startsWith("snapshot-"));
  assert.deepEqual(remainingSnapshots, []);
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

test("enable writes marketplace and plugin stanzas to a fresh config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-fresh-"));
  const configPath = path.join(tmpDir, "config.toml");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin registered/);
  assert.match(result.stdout, /Changed:/);
  assert.match(result.stdout, /Restart Codex CLI/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /\[marketplaces\.claude-review-private\]/);
  assert.match(written, /source_type = "local"/);
  assert.match(written, /\[plugins\."claude-review@claude-review-private"\]/);
  assert.match(written, /enabled = true/);
});

test("enable is idempotent — running twice does not duplicate stanzas", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-idempotent-"));
  const configPath = path.join(tmpDir, "config.toml");
  spawnSync(process.execPath, [helper, "enable", "--config", configPath], { cwd: root, encoding: "utf8" });
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already registered/);
  const written = fs.readFileSync(configPath, "utf8");
  const marketplaceCount = (written.match(/\[marketplaces\.claude-review-private\]/g) ?? []).length;
  const pluginCount = (written.match(/\[plugins\."claude-review@claude-review-private"\]/g) ?? []).length;
  assert.equal(marketplaceCount, 1);
  assert.equal(pluginCount, 1);
});

test("enable --dry-run reports what would be added without writing the config file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-dryrun-"));
  const configPath = path.join(tmpDir, "config.toml");
  const result = spawnSync(process.execPath, [helper, "enable", "--dry-run", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\]/);
  assert.match(result.stdout, /claude-review-private/);
  assert.equal(fs.existsSync(configPath), false, "--dry-run must not write the config file");
});

test("enable --json emits machine-parseable registration result", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-json-"));
  const configPath = path.join(tmpDir, "config.toml");
  const result = spawnSync(process.execPath, [helper, "enable", "--json", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.configPath, "string");
  assert.equal(typeof payload.pluginRoot, "string");
  assert.equal(payload.alreadyEnabled, false);
  assert.equal(payload.dryRun, false);
  assert.equal(payload.backupPath, null);
  assert.ok(Array.isArray(payload.added) && payload.added.length > 0);
});

test("enable uses Codex plugin CLI for the default CODEX_HOME path", { skip: process.platform === "win32" }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-cli-"));
  const codexHome = path.join(tmpDir, "codex-home");
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;
const statePath = path.join(codexHome, "installed.json");
const wrapperRoot = path.join(codexHome, "marketplaces", "claude-review-private");
const sourcePath = "./plugins/claude-review";
fs.mkdirSync(codexHome, { recursive: true });
if (args.join(" ") === "plugin marketplace add --help") {
  console.log("Add a local or Git marketplace");
  process.exit(0);
}
if (args.join(" ") === "plugin list --json") {
  if (fs.existsSync(statePath)) {
    console.log(JSON.stringify({ installed: [{ pluginId: "claude-review@claude-review-private", name: "claude-review", marketplaceName: "claude-review-private", version: "1.0.14", installed: true, enabled: true, source: { source: "local", path: sourcePath }, marketplaceSource: { sourceType: "local", source: wrapperRoot } }], available: [] }));
  } else {
    console.log(JSON.stringify({ installed: [], available: [] }));
  }
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  fs.writeFileSync(path.join(codexHome, "config.toml"), '[marketplaces.claude-review-private]\\nsource_type = "local"\\nsource = "' + args[3].replaceAll('\\\\', '/') + '"\\n');
  console.log(JSON.stringify({ marketplaceName: "claude-review-private", installedRoot: args[3], alreadyAdded: false }));
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "add") {
  fs.writeFileSync(statePath, JSON.stringify({ installed: true }));
  fs.appendFileSync(path.join(codexHome, "config.toml"), '\\n[plugins."claude-review@claude-review-private"]\\nenabled = true\\n');
  console.log(JSON.stringify({ pluginId: "claude-review@claude-review-private", name: "claude-review", marketplaceName: "claude-review-private", version: "1.0.14", installedPath: path.join(codexHome, "plugins", "cache", "claude-review-private", "claude-review", "1.0.14") }));
  process.exit(0);
}
console.error("unexpected codex args", args.join(" "));
process.exit(1);
`,
    { mode: 0o755 }
  );

  const result = spawnSync(process.execPath, [helper, "enable"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex plugin CLI/);
  assert.equal(fs.realpathSync(path.join(codexHome, "marketplaces", "claude-review-private", "plugins", "claude-review")), fs.realpathSync(root));
  const wrapperManifest = JSON.parse(
    fs.readFileSync(path.join(codexHome, "marketplaces", "claude-review-private", ".agents", "plugins", "marketplace.json"), "utf8")
  );
  assert.equal(wrapperManifest.plugins[0].source.path, "./plugins/claude-review");
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /\[plugins\."claude-review@claude-review-private"\]/);
});

test("enable preserves existing config content when appending stanzas", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-preserve-"));
  const configPath = path.join(tmpDir, "config.toml");
  const existing = `model = "gpt-5.5"\n\n[agents]\nmax_depth = 2\n`;
  fs.writeFileSync(configPath, existing, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  assert.ok(written.startsWith(existing), "existing config content must be preserved verbatim");
  assert.match(written, /\[marketplaces\.claude-review-private\]/);
  assert.match(result.stdout, /Backup written to /);
  const backups = fs.readdirSync(tmpDir).filter((name) => name.startsWith("config.toml.bak."));
  assert.equal(backups.length, 1, "existing config must be backed up before mutation");
  assert.equal(fs.readFileSync(path.join(tmpDir, backups[0]), "utf8"), existing);
  assert.equal(fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp")).length, 0, "atomic temp file must be cleaned up");
});

test("enable --json reports backup path when mutating an existing config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-json-backup-"));
  const configPath = path.join(tmpDir, "config.toml");
  const existing = `model = "codex"\n`;
  fs.writeFileSync(configPath, existing, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--json", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.backupPath, /config\.toml\.bak\./);
  assert.equal(fs.readFileSync(payload.backupPath, "utf8"), existing);
});

test("enable source path uses forward slashes on all platforms", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-slashes-"));
  const configPath = path.join(tmpDir, "config.toml");
  spawnSync(process.execPath, [helper, "enable", "--config", configPath], { cwd: root, encoding: "utf8" });
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /source = ".*\\.*"/, "TOML source path must use forward slashes");
});

test("enable updates a stale marketplace source path", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-stale-"));
  const configPath = path.join(tmpDir, "config.toml");
  const staleConfig =
    `[marketplaces.claude-review-private]\nsource_type = "local"\nsource = "/old/stale/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, staleConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changed:/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /\/old\/stale\/path/, "stale source path must be replaced");
  assert.ok(
    written.includes(root.split(path.sep).join("/")),
    "source must reflect current install path"
  );
});

test("enable flips enabled = false to true for a disabled plugin", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-reenable-"));
  const configPath = path.join(tmpDir, "config.toml");
  const disabledConfig =
    `[marketplaces.claude-review-private]\nsource_type = "local"\nsource = "/some/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = false\n`;
  fs.writeFileSync(configPath, disabledConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changed:/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /enabled = false/);
  assert.match(written, /enabled = true/);
});

test("enable rejects unknown flags before touching the config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-unknownflag-"));
  const configPath = path.join(tmpDir, "config.toml");
  const result = spawnSync(process.execPath, [helper, "enable", "--dryrun", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "enable must exit non-zero for unknown flags");
  assert.equal(fs.existsSync(configPath), false, "config must not be written when unknown flag passed");
});

test("enable rejects --config with no value", () => {
  const result = spawnSync(process.execPath, [helper, "enable", "--config"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "enable must exit non-zero when --config has no value");
});

test("enable recognises the quoted-key form [marketplaces.\"claude-review-private\"] as already present", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-quotedkey-"));
  const configPath = path.join(tmpDir, "config.toml");
  const quotedConfig =
    `[marketplaces."claude-review-private"]\nsource_type = "local"\nsource = "/some/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, quotedConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  const marketplaceCount = (written.match(/\[marketplaces[.\s"]*claude-review-private/g) ?? []).length;
  assert.equal(marketplaceCount, 1, "must not append a duplicate marketplace stanza for a quoted-key config");
});

test("enable ignores commented-out marketplace headers when deciding registration", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-commented-"));
  const configPath = path.join(tmpDir, "config.toml");
  const commentedConfig = `# [marketplaces.claude-review-private]\n# source_type = "local"\n`;
  fs.writeFileSync(configPath, commentedConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin registered/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /^\[marketplaces\.claude-review-private\]/m, "real (uncommented) stanza must be written");
});

test("enable recognises a header with a trailing inline comment", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-trailcomment-"));
  const configPath = path.join(tmpDir, "config.toml");
  const taggedConfig =
    `[marketplaces.claude-review-private] # set up by earlier installer\n` +
    `source_type = "local"\nsource = "/some/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, taggedConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  const marketplaceCount = (written.match(/\[marketplaces\.claude-review-private\]/g) ?? []).length;
  assert.equal(marketplaceCount, 1, "must not duplicate stanzas because of an inline comment on the header");
});

test("enable handles CRLF line endings without duplicating stanzas", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-crlf-"));
  const configPath = path.join(tmpDir, "config.toml");
  const crlfConfig =
    `[marketplaces.claude-review-private]\r\nsource_type = "local"\r\nsource = "/some/path"\r\n\r\n` +
    `[plugins."claude-review@claude-review-private"]\r\nenabled = true\r\n`;
  fs.writeFileSync(configPath, crlfConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  const marketplaceCount = (written.match(/\[marketplaces\.claude-review-private\]/g) ?? []).length;
  const pluginCount = (written.match(/\[plugins\."claude-review@claude-review-private"\]/g) ?? []).length;
  assert.equal(marketplaceCount, 1, "CRLF config must not produce a duplicate marketplace stanza");
  assert.equal(pluginCount, 1, "CRLF config must not produce a duplicate plugin stanza");
});

test("enable updates single-quoted TOML source strings", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-singlequote-"));
  const configPath = path.join(tmpDir, "config.toml");
  const singleQuotedConfig =
    `[marketplaces.claude-review-private]\nsource_type = 'local'\nsource = '/old/stale/path'\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, singleQuotedConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changed:/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /\/old\/stale\/path/, "single-quoted stale source must be replaced");
});

test("enable refreshes an indented source key", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-indented-"));
  const configPath = path.join(tmpDir, "config.toml");
  const indentedConfig =
    `[marketplaces.claude-review-private]\n  source_type = "local"\n  source = "/old/indented/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\n  enabled = true\n`;
  fs.writeFileSync(configPath, indentedConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changed:/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /\/old\/indented\/path/, "indented stale source must be refreshed");
});

test("enable inserts missing source key into an existing marketplace stanza", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-nosource-"));
  const configPath = path.join(tmpDir, "config.toml");
  const incompleteConfig =
    `[marketplaces.claude-review-private]\nsource_type = "local"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, incompleteConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changed:/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /\nsource\s*=\s*"/, "source key must be inserted when absent from marketplace stanza");
});

test("enable normalises a wrong source_type to local", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-srctype-"));
  const configPath = path.join(tmpDir, "config.toml");
  const wrongTypeConfig =
    `[marketplaces.claude-review-private]\nsource_type = "git"\nsource = "/some/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, wrongTypeConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source_type/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /source_type = "local"/);
  assert.doesNotMatch(written, /source_type = "git"/);
});

test("enable inserts missing source_type when only source is set", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-nosrctype-"));
  const configPath = path.join(tmpDir, "config.toml");
  const noSourceTypeConfig =
    `[marketplaces.claude-review-private]\nsource = "/some/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, noSourceTypeConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /source_type = "local"/, "source_type must be inserted when absent");
});

test("enable inserts missing enabled key into an existing plugin stanza", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-noenabled-"));
  const configPath = path.join(tmpDir, "config.toml");
  const noEnabledConfig =
    `[marketplaces.claude-review-private]\nsource_type = "local"\nsource = "/some/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\n# (no enabled key)\n`;
  fs.writeFileSync(configPath, noEnabledConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changed:/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /enabled = true/, "enabled key must be inserted when absent");
});

test("enable rejects unknown positional with exit code 2 (usage error)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-exit2-"));
  const configPath = path.join(tmpDir, "config.toml");
  const result = spawnSync(process.execPath, [helper, "enable", "--dryrun", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 2, "unknown-flag must use the usage/validation exit code (2)");
});

test("enable does not mistake multiline array elements for section headers", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-multiarr-"));
  const configPath = path.join(tmpDir, "config.toml");
  // Multiline nested-array value before the source key. A naive `startsWith("[")`
  // boundary detector would treat `  ["a"]` as a section header and corrupt the file.
  const multilineArrayConfig =
    `[marketplaces.claude-review-private]\n` +
    `source_type = "local"\n` +
    `labels = [\n` +
    `  ["a"],\n` +
    `  ["b"]\n` +
    `]\n` +
    `source = "/old/stale/path"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, multilineArrayConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /\/old\/stale\/path/, "stale source must be refreshed past the multiline array");
  // The labels array must still be intact.
  assert.match(written, /labels = \[\n\s*\["a"\],\n\s*\["b"\]\n\]/);
});

test("enable preserves existing indentation on key replacements (idempotent for indented configs)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-keepindent-"));
  const configPath = path.join(tmpDir, "config.toml");
  // First run from clean: writes flush-left source.
  spawnSync(process.execPath, [helper, "enable", "--config", configPath], { cwd: root, encoding: "utf8" });
  // Manually re-indent the source line to 4 spaces.
  let content = fs.readFileSync(configPath, "utf8");
  content = content.replace(/\nsource = /, "\n    source = ");
  content = content.replace(/\nsource_type = /, "\n    source_type = ");
  fs.writeFileSync(configPath, content, "utf8");
  // Second run must NOT rewrite the file (indented value still matches current root → no change).
  const before = fs.readFileSync(configPath, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(configPath, "utf8");
  assert.equal(after, before, "config must be untouched when indented values already match");
  assert.match(result.stdout, /already registered/);
});

test("enable treats [[array_table]] as a stanza boundary", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-arraytbl-"));
  const configPath = path.join(tmpDir, "config.toml");
  // Marketplace stanza has source_type but no source; followed by an array-of-tables.
  // The missing source key MUST land inside the marketplace stanza, not under [[profiles]].
  const arrayTableConfig =
    `[marketplaces.claude-review-private]\nsource_type = "local"\n\n` +
    `[[profiles]]\nname = "default"\n\n` +
    `[[profiles]]\nname = "alt"\n\n` +
    `[plugins."claude-review@claude-review-private"]\nenabled = true\n`;
  fs.writeFileSync(configPath, arrayTableConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  // The inserted source= line must appear BEFORE the first [[profiles]] header.
  const marketplaceIdx = written.indexOf("[marketplaces.claude-review-private]");
  const firstProfileIdx = written.indexOf("[[profiles]]");
  const sourceIdx = written.search(/\nsource\s*=\s*"/);
  assert.ok(marketplaceIdx >= 0 && firstProfileIdx >= 0 && sourceIdx >= 0);
  assert.ok(sourceIdx < firstProfileIdx, "source key must be inserted before [[profiles]], not after");
  assert.ok(sourceIdx > marketplaceIdx, "source key must be inserted after the marketplace header");
  // Array-of-tables content must be intact.
  assert.match(written, /\[\[profiles\]\]\nname = "default"/);
});

test("enable bounds stanza correctly when next header is indented", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enable-indentnext-"));
  const configPath = path.join(tmpDir, "config.toml");
  const indentedNextConfig =
    `[marketplaces.claude-review-private]\n` +
    `source_type = "local"\n` +
    `  [marketplaces.something-else]\n` +
    `  source_type = "git"\n`;
  fs.writeFileSync(configPath, indentedNextConfig, "utf8");
  const result = spawnSync(process.execPath, [helper, "enable", "--config", configPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(configPath, "utf8");
  // The other marketplace's source_type must NOT have been rewritten to "local".
  assert.match(written, /\[marketplaces\.something-else\][\s\S]*source_type = "git"/);
});

test("status finalizes running jobs older than timeout as failed with a reason", () => {
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
  assert.match(result.stdout, /review-stale \| failed/);
  assert.match(result.stdout, /Reason: stale_timeout/);
});



test("status finalizes legacy stalled jobs as failed instead of leaving ambiguity", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-legacy-stalled";
  createJob(
    cwd,
    jobId,
    {
      ...buildJobRecord(cwd, jobId, { kind: "review", title: "legacy stalled job", status: "stalled" }),
      updatedAt: "2000-01-01T00:00:00.000Z",
      error: "process is not running"
    }
  );
  writeJobInput(cwd, jobId, { timeoutMs: 1 });

  const result = spawnSync(process.execPath, [helper, "status", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /review-legacy-stalled \| failed/);
  assert.match(result.stdout, /Reason: stale_timeout/);
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

test("result exits 0 for a clean no-changes-requested verdict", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-no-changes";
  completedJob(cwd, jobId, {
    verdict: "no changes requested",
    summary: "Clean result.",
    findings: [],
    next_steps: []
  });

  const result = spawnSync(process.execPath, [helper, "result", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
});

test("result exits 0 for negated blocker phrases", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-not-blocked";
  completedEliteJob(cwd, jobId, {
    verdict: "not blocked",
    ship_recommendation: "not a ship blocker",
    executive_summary: "Clean result with negated blocker language.",
    systemic_risks: [],
    findings: [],
    verified_claims: [],
    exploration_log: [],
    blind_spots: [],
    next_steps: []
  });

  const result = spawnSync(process.execPath, [helper, "result", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("result exits 3 for explicit do-not-ship recommendations without high severity findings", () => {
  const cwd = makeDirtyRepo();
  const jobId = "elite-do-not-ship";
  completedEliteJob(cwd, jobId, {
    verdict: "OK",
    ship_recommendation: "NO_SHIP",
    executive_summary: "Medium issue should still block because ship recommendation says no.",
    systemic_risks: [],
    findings: [
      {
        severity: "medium",
        confidence: 0.9,
        risk_category: "correctness",
        title: "Medium blocker",
        body: "The explicit ship recommendation blocks release.",
        failure_scenario: "Operator relies on exit code.",
        why_vulnerable: "Structured ship recommendation was ignored.",
        impact: "Release gate can pass incorrectly.",
        exploitability: "local automation",
        file: "index.js",
        line_start: 1,
        line_end: 1,
        recommendation: "Honor ship_recommendation.",
        test_gap: "No no-ship phrase regression.",
        evidence: [
          {
            tool: "Read",
            query: "index.js",
            confirmed: "The persisted result carries an explicit do-not-ship recommendation."
          }
        ]
      }
    ],
    verified_claims: [],
    exploration_log: [],
    blind_spots: [],
    next_steps: []
  });

  const result = spawnSync(process.execPath, [helper, "result", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 3);
  assert.match(result.stdout, /Medium blocker/);
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

test("cancel leaves completed jobs unchanged and does not reuse stale pids", () => {
  const cwd = makeDirtyRepo();
  const jobId = "review-completed-pid";
  completedJob(cwd, jobId, {
    verdict: "ok",
    summary: "Already completed.",
    findings: [],
    next_steps: []
  });
  const before = readJob(cwd, jobId);
  const jobPath = path.join(cwd, ".claude-review", "jobs", `${jobId}.job.json`);
  fs.writeFileSync(jobPath, `${JSON.stringify({ ...before, pid: 2147483647 }, null, 2)}\n`, "utf8");

  const result = spawnSync(process.execPath, [helper, "cancel", "--cwd", cwd, jobId], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const after = readJob(cwd, jobId);
  assert.equal(after.status, "completed");
  assert.deepEqual(after.result, before.result);
});


test("--version prints the package version", () => {
  const result = spawnSync(process.execPath, [helper, "--version"], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), JSON.parse(read("package.json")).version);
});

function withFakeClaudeScript(lines) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-command-bin-"));
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(claudePath, ["#!/bin/sh", ...lines].join("\n"), { mode: 0o755 });
  return {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
  };
}

function onlyJob(cwd) {
  const jobsDir = path.join(cwd, ".claude-review", "jobs");
  const jobFile = fs.readdirSync(jobsDir).find((entry) => entry.endsWith(".job.json"));
  assert.ok(jobFile, "expected a job record");
  return JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
}

test("failed foreground reviews persist actionable timeout diagnostics visible in status and result", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeScript([
    "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
    "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
    "echo 'stdout-before-timeout'",
    "echo 'stderr-before-timeout' >&2",
    "sleep 2"
  ]);

  const run = spawnSync(process.execPath, [helper, "review", "--legacy", "--cwd", cwd, "--timeout-ms", "50", "diagnose timeout"], {
    cwd,
    encoding: "utf8",
    env: fake.env
  });

  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr, /^timed out after 50ms\s*$/);
  assert.match(run.stderr, /timeout/);
  const job = onlyJob(cwd);
  assert.equal(job.status, "failed");
  assert.equal(job.failureReason, "timeout");
  assert.equal(job.diagnostics.cwd, cwd);
  assert.equal(job.diagnostics.model, "opus");
  assert.equal(job.diagnostics.effort, "xhigh");
  assert.equal(job.diagnostics.timeoutMs, 50);
  assert.equal(typeof job.diagnostics.childPid, "number");
  assert.match(job.diagnostics.promptPath, /\.prompt\.md$/);
  assert.match(job.diagnostics.command, /^claude /);
  assert.doesNotMatch(job.diagnostics.command, /API[_-]?KEY|sk-/i);
  assert.match(job.diagnostics.stdoutTail, /stdout-before-timeout/);
  assert.match(job.diagnostics.stderrTail, /stderr-before-timeout/);
  assert.match(job.diagnostics.currentPhase, /claude/);

  const status = spawnSync(process.execPath, [helper, "status", "--cwd", cwd, job.id], { cwd, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Reason: timeout/);
  assert.match(status.stdout, /stdout-before-timeout/);
  assert.match(status.stdout, /stderr-before-timeout/);

  const result = spawnSync(process.execPath, [helper, "result", "--cwd", cwd, job.id], { cwd, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Failure Diagnostics/);
  assert.match(result.stdout, /Reason: timeout/);
  assert.match(result.stdout, /stderr-before-timeout/);
});

test("agentic no-output probe falls back to Claude-only markdown review", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeScript([
    "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
    "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
    "case \"$*\" in",
    "  *--output-format*) sleep 2 ;;",
    "  *) echo 'VERDICT: ship after diagnostics fix'; echo 'BLOCKERS: none detected' ;;",
    "esac"
  ]);

  const run = spawnSync(process.execPath, [helper, "elite-review", "--cwd", cwd, "--timeout-ms", "500", "validate fallback"], {
    cwd,
    encoding: "utf8",
    env: { ...fake.env, CODEX_CLAUDE_AGENTIC_NO_OUTPUT_TIMEOUT_MS: "20" }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Fallback Markdown Review/);
  assert.match(run.stdout, /ship after diagnostics fix/);
  const job = onlyJob(cwd);
  assert.equal(job.status, "completed");
  assert.equal(job.invocationMeta.fallbackUsed, true);
});

test("markdown fallback does not treat clean blocker negations as no-ship", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeScript([
    "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
    "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
    "case \"$*\" in",
    "  *--output-format*) sleep 2 ;;",
    "  *) echo 'SHIP_RECOMMENDATION: no ship blockers'; echo 'VERDICT: no ship blockers'; echo 'BLOCKERS: No ship blockers.' ;;",
    "esac"
  ]);

  const run = spawnSync(process.execPath, [helper, "elite-review", "--cwd", cwd, "--timeout-ms", "500", "validate fallback negation"], {
    cwd,
    encoding: "utf8",
    env: { ...fake.env, CODEX_CLAUDE_AGENTIC_NO_OUTPUT_TIMEOUT_MS: "20" }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Fallback Markdown Review/);
  assert.match(run.stdout, /No ship blockers/);
});

test("markdown fallback maps explicit no-ship verdicts to a blocking exit", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeScript([
    "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
    "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
    "case \"$*\" in",
    "  *--output-format*) sleep 2 ;;",
    "  *) echo 'Verdict: do not ship'; echo 'Blockers: Release gate must remain closed.' ;;",
    "esac"
  ]);

  const run = spawnSync(process.execPath, [helper, "elite-review", "--cwd", cwd, "--timeout-ms", "500", "validate fallback no ship"], {
    cwd,
    encoding: "utf8",
    env: { ...fake.env, CODEX_CLAUDE_AGENTIC_NO_OUTPUT_TIMEOUT_MS: "20" }
  });

  assert.equal(run.status, 3, run.stderr || run.stdout);
  assert.match(run.stdout, /Fallback Markdown Review/);
  assert.match(run.stdout, /do not ship/);
});

test("markdown fallback treats plural ship blockers as blocking", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeScript([
    "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
    "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
    "case \"$*\" in",
    "  *--output-format*) sleep 2 ;;",
    "  *) echo 'VERDICT: Ship blockers found'; echo 'BLOCKERS: Ship blockers remain.' ;;",
    "esac"
  ]);

  const run = spawnSync(process.execPath, [helper, "elite-review", "--cwd", cwd, "--timeout-ms", "500", "validate fallback blockers"], {
    cwd,
    encoding: "utf8",
    env: { ...fake.env, CODEX_CLAUDE_AGENTIC_NO_OUTPUT_TIMEOUT_MS: "20" }
  });

  assert.equal(run.status, 3, run.stderr || run.stdout);
  assert.match(run.stdout, /Ship blockers found/);
});

test("agentic structured chatter probe falls back before the overall timeout", () => {
  const cwd = makeDirtyRepo();
  const fake = withFakeClaudeScript([
    "if [ \"$1\" = \"--help\" ]; then echo 'Usage: claude'; exit 0; fi",
    "if [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"api-key\"}'; exit 0; fi",
    "structured=0",
    "for arg in \"$@\"; do if [ \"$arg\" = \"--output-format\" ]; then structured=1; fi; done",
    "if [ \"$structured\" = \"1\" ]; then echo 'thinking without structured output'; sleep 2; else echo 'VERDICT: recovered after chatter'; echo 'BLOCKERS: none found'; fi"
  ]);

  const run = spawnSync(process.execPath, [helper, "elite-review", "--cwd", cwd, "--timeout-ms", "2500", "validate chatter fallback"], {
    cwd,
    encoding: "utf8",
    env: {
      ...fake.env,
      CODEX_CLAUDE_AGENTIC_STRUCTURED_PROBE_TIMEOUT_MS: "30",
      CODEX_CLAUDE_AGENTIC_NO_OUTPUT_TIMEOUT_MS: "400"
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Fallback Markdown Review/);
  assert.match(run.stdout, /recovered after chatter/);
  const job = onlyJob(cwd);
  assert.equal(job.status, "completed");
  assert.equal(job.invocationMeta.fallbackUsed, true);
  assert.equal(job.invocationMeta.structuredFailure.structuredProbeTimeoutMs, 30);
  assert.equal(job.invocationMeta.structuredFailure.overallTimeoutMs, 2500);
});

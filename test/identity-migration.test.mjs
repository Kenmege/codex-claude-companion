import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const shimRoot = path.join(root, "packages/codex-plugin-cc-shim");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function installShimFixture(targetSource) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-cc-shim-"));
  const binRoot = path.join(tempRoot, "bin");
  const targetRoot = path.join(tempRoot, "node_modules/@kenmege/codex-claude-bridge");
  fs.mkdirSync(binRoot, { recursive: true });
  fs.mkdirSync(path.join(targetRoot, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(shimRoot, "bin/codex-claude.mjs"), path.join(binRoot, "codex-claude.mjs"));
  fs.writeFileSync(path.join(targetRoot, "package.json"), JSON.stringify({
    name: "@kenmege/codex-claude-bridge",
    version: "0.0.0-development",
    type: "module",
    bin: { "codex-claude": "scripts/target.mjs" }
  }));
  fs.writeFileSync(path.join(targetRoot, "scripts/target.mjs"), targetSource);
  return { tempRoot, shim: path.join(binRoot, "codex-claude.mjs") };
}

test("identity documentation distinguishes the two product directions", () => {
  const readme = read("README.md");
  const migration = read("docs/bridge-migration.md");
  const launchGuide = read("docs/CODEX_CLAUDE_BRIDGE_LAUNCH_GUIDE.html");

  assert.match(readme, /independent community project/i);
  assert.match(readme, /not affiliated with or endorsed by OpenAI or Anthropic/i);
  assert.match(readme, /OpenAI[\s\S]{0,80}`openai\/codex-plugin-cc`[\s\S]{0,80}Claude Code[\s\S]{0,40}Codex/i);
  assert.match(readme, /this project[\s\S]{0,80}Codex[\s\S]{0,40}Claude/i);
  assert.match(readme, /Delegate to Claude from Codex, keep control, and get verified work back/i);
  assert.match(readme, /stable `latest` release remains `1\.1\.1`[\s\S]{0,180}`1\.2\.0-rc\.1`/i);
  assert.match(readme, /npm install -g codex-plugin-cc@next/i);
  assert.doesNotMatch(readme, /Public npm is the frictionless install lane/i);
  assert.match(migration, /unscoped\s+`codex-claude-bridge`[^\n]*already occupied/i);
  assert.match(migration, /`@kenmege\/codex-claude-bridge`[^\n]*candidate/i);
  assert.doesNotMatch(migration, /otherwise the target package name is `codex-claude-bridge`/i);
  assert.match(launchGuide, /Codex-Claude Bridge by Kenmege/i);
  assert.match(launchGuide, /not affiliated with or endorsed by OpenAI or Anthropic/i);
  assert.match(launchGuide, /openai\/codex-plugin-cc[\s\S]{0,180}Claude Code[\s\S]{0,80}Codex/i);
  assert.match(launchGuide, /this bridge[\s\S]{0,180}Codex[\s\S]{0,80}Claude/i);
  assert.match(launchGuide, /separate from CAMPUS/i);
  assert.doesNotMatch(launchGuide, /npm install -g @kenmege\/codex-claude-bridge/i);
});

test("established plugin and marketplace identifiers remain aligned", () => {
  const marketplace = JSON.parse(read(".agents/plugins/marketplace.json"));
  const companion = read("scripts/claude-review-companion.mjs");
  const migration = read("docs/bridge-migration.md");
  const readme = read("README.md");

  assert.equal(marketplace.name, "claude-review-private");
  assert.equal(marketplace.plugins[0].name, "claude-review");
  assert.match(companion, /CODEX_MARKETPLACE_KEY\s*=\s*"claude-review-private"/);
  assert.match(companion, /CODEX_PLUGIN_NAME\s*=\s*"claude-review"/);
  assert.match(migration, /checked-in root[\s\S]{0,240}generated compatibility wrapper[\s\S]{0,240}`claude-review-private`/i);
  assert.doesNotMatch(migration, /marketplace is\s+named `codex-claude-bridge-local`/i);
  assert.match(readme, /loads `.agents\/plugins\/marketplace\.json` as the\s+`claude-review-private` marketplace/i);
  assert.doesNotMatch(readme, /`codex-claude-bridge-local` marketplace/i);
});

test("existing-package RC is approved while scoped cutover remains fail-closed", () => {
  const migration = read("docs/bridge-migration.md");

  assert.match(migration, /verified npm authentication and control of the `@kenmege` scope/i);
  assert.match(migration, /clean-install parity/i);
  assert.match(migration, /trusted publisher, provenance, badges, workflows, and repository\s+redirects/i);
  assert.match(migration, /OpenAI-derived files[\s\S]{0,180}Apache-2\.0[\s\S]{0,180}modification notices/i);
  assert.match(migration, /explicit public-release approval/i);
  assert.match(migration, /existing-package prerelease verdict:\s*approved/i);
  assert.match(migration, /codex-plugin-cc@1\.2\.0-rc\.1[\s\S]{0,80}dist-tag `next`/i);
  assert.match(migration, /scoped cutover verdict:\s*blocked/i);
});

test("modified OpenAI-derived files carry Apache-2.0 change notices", () => {
  const modifiedInheritedFiles = [
    ".github/workflows/pull-request-ci.yml",
    ".gitignore",
    "package.json",
    "package-lock.json",
    "plugins/codex/scripts/app-server-broker.mjs",
    "plugins/codex/scripts/lib/app-server.mjs",
    "plugins/codex/scripts/lib/broker-lifecycle.mjs",
    "plugins/codex/scripts/lib/codex.mjs",
    "plugins/codex/scripts/session-lifecycle-hook.mjs",
    "tests/helpers.mjs",
    "tests/runtime.test.mjs"
  ];

  for (const file of modifiedInheritedFiles) {
    assert.match(
      read(file).slice(0, 1_024),
      /Modified by Kennedy Umege for Codex-Claude Bridge, 2026\./,
      `${file} must carry a prominent modification notice`
    );
  }
});

test("legacy package scaffold is inert until the coordinated cutover", () => {
  const shimPackage = JSON.parse(read("packages/codex-plugin-cc-shim/package.json"));

  assert.equal(shimPackage.name, "codex-plugin-cc");
  assert.equal(shimPackage.private, true);
  assert.deepEqual(shimPackage.bin, {
    "codex-claude": "bin/codex-claude.mjs",
    "codex-claude-review": "bin/codex-claude.mjs"
  });
  assert.equal(shimPackage.dependencies["@kenmege/codex-claude-bridge"], "0.0.0-development");
  assert.match(shimPackage.description, /compatibility shim/i);
  assert.match(read("packages/codex-plugin-cc-shim/README.md"), /non-publishable placeholder/i);
  assert.match(read("docs/bridge-migration.md"), /atomically replace[^\n]*`0\.0\.0-development`/i);
});

test("legacy shim prints one migration notice and preserves process I/O, arguments, environment, and exit code", () => {
  const { tempRoot, shim } = installShimFixture(`
    import fs from "node:fs";
    const input = fs.readFileSync(0, "utf8");
    process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, marker: process.env.BRIDGE_TEST_MARKER }));
    process.stderr.write("target-stderr\\n");
    process.exitCode = 23;
  `);
  try {
    const result = spawnSync(process.execPath, [shim, "delegate", "--model", "opus"], {
      cwd: tempRoot,
      env: { ...process.env, BRIDGE_TEST_MARKER: "preserved" },
      input: "stdin-payload",
      encoding: "utf8"
    });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["delegate", "--model", "opus"],
      input: "stdin-payload",
      marker: "preserved"
    });
    assert.equal((result.stderr.match(/codex-plugin-cc has moved/g) || []).length, 1);
    assert.match(result.stderr, /npm install -g @kenmege\/codex-claude-bridge/);
    assert.match(result.stderr, /target-stderr/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("legacy shim preserves target termination signals", () => {
  const { tempRoot, shim } = installShimFixture("process.kill(process.pid, 'SIGTERM');");
  try {
    const result = spawnSync(process.execPath, [shim], { cwd: tempRoot, encoding: "utf8" });
    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGTERM");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("legacy shim fails closed instead of recursively invoking itself", () => {
  const { tempRoot, shim } = installShimFixture("process.exitCode = 0;");
  const manifestPath = path.join(tempRoot, "node_modules/@kenmege/codex-claude-bridge/package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.bin["codex-claude"] = "../../../bin/codex-claude.mjs";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  try {
    const result = spawnSync(process.execPath, [shim], { cwd: tempRoot, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing recursive self-invocation/i);
    assert.doesNotMatch(result.stderr, /^NOTICE:/m);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("legacy shim package has a deterministic dry-run payload", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: shimRoot,
    encoding: "utf8"
  }));
  const files = packed[0].files.map(({ path: filePath }) => filePath).sort();
  assert.deepEqual(files, ["LICENSE", "NOTICE", "README.md", "bin/codex-claude.mjs", "package.json"]);
});

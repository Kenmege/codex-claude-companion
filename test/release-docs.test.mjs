import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bumpVersion, recoverInterruptedTransaction } from "../scripts/bump-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function workflowStep(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const indent = lines[start].match(/^\s*/)?.[0].length ?? 0;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim().startsWith("- name: ") && lineIndent === indent) break;
    if (line.trim() && lineIndent < indent) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

test("pull request workflow cancels superseded matrix runs", () => {
  const source = read(".github/workflows/pull-request-ci.yml");
  assert.match(source, /concurrency:/);
  assert.match(source, /group: pr-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(source, /cancel-in-progress: true/);
});

test("pull request workflow proves the platform-neutral surface on minimum Node for Windows", () => {
  const source = read(".github/workflows/pull-request-ci.yml");
  assert.match(source, /windows-test:/);
  assert.match(source, /runs-on: windows-latest/);
  assert.match(source, /node-version: 18\.18\.0/);
  assert.match(source, /run: npm run lint/);
  assert.match(source, /run: npm run test:windows/);
  assert.match(source, /run: npm run pack:check/);
});

test("pull request workflow runs the real tmux executor on macOS", () => {
  const source = read(".github/workflows/pull-request-ci.yml");
  const macosJob = source.match(/\n  macos-tmux:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n|$)/)?.[0] ?? "";

  assert.match(macosJob, /runs-on: macos-latest/);
  assert.match(macosJob, /brew install tmux/);
  assert.match(macosJob, /run: npm ci/);
  assert.match(macosJob, /node --test test\/tmux-executor\.test\.mjs/);
});

test("release workflow binds manual recovery to the triggering tag for accurate OIDC provenance", () => {
  const source = read(".github/workflows/release.yml");
  const refGate = workflowStep(source, "Verify release workflow ref");
  const checkout = workflowStep(source, "Check out repository");

  assert.match(refGate, /GITHUB_REF/);
  assert.match(refGate, /refs\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(checkout, /ref: \$\{\{ github\.ref \}\}/);
  assert.doesNotMatch(checkout, /refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/);
});

const packageJson = JSON.parse(read("package.json"));

test("package test command uses shell-independent Node discovery", () => {
  assert.equal(packageJson.scripts.test, "node --test");
  assert.match(packageJson.scripts["test:windows"], /^node --test /);
});

test("packed package installs working primary and compatibility command aliases", { timeout: 60_000 }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-packed-bin-"));
  const packDirectory = path.join(tempRoot, "pack");
  const installPrefix = path.join(tempRoot, "install");
  fs.mkdirSync(packDirectory, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  try {
    const packed = JSON.parse(execFileSync(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
      { cwd: root, encoding: "utf8" }
    ));
    assert.equal(packed.length, 1);
    const tarball = path.join(packDirectory, packed[0].filename);
    execFileSync(
      npm,
      ["install", "--prefix", installPrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      { cwd: tempRoot, encoding: "utf8" }
    );

    for (const alias of ["codex-claude", "codex-claude-review"]) {
      const executable = path.join(
        installPrefix,
        "node_modules",
        ".bin",
        `${alias}${process.platform === "win32" ? ".cmd" : ""}`
      );
      const result = spawnSync(executable, ["--help"], {
        cwd: tempRoot,
        encoding: "utf8",
        shell: process.platform === "win32"
      });
      assert.equal(result.status, 0, `${alias}: ${result.stderr || result.stdout}`);
      assert.match(result.stdout, /codex-claude workspace/);
      assert.match(result.stdout, /Compatibility alias:\s+codex-claude-review/);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("package files list excludes bump-version from the shipped tarball surface", () => {
  assert.ok(packageJson.files.includes("scripts/claude-review-companion.mjs"));
  assert.ok(packageJson.files.includes("scripts/validate-repo.mjs"));
  assert.ok(packageJson.files.includes("scripts/bin/"));
  assert.ok(packageJson.files.includes("scripts/lib/"));
  assert.ok(!packageJson.files.includes("scripts/"));
});

test("bump-version checks the current release manifests", () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["scripts/bump-version.mjs", "--check"], {
      cwd: root,
      encoding: "utf8"
    });
  });
});

test("bump-version enforces Semantic Versioning identifier rules", () => {
  const invalidVersions = [
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3-alpha.",
    "1.2.3+build..1",
    "1.2.3+build."
  ];

  for (const version of invalidVersions) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "bump-version.mjs"), "--check", version, "--root", root],
      { cwd: root, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, `${version} must be rejected`);
    assert.match(result.stderr, /Expected a valid Semantic Version/);
  }

  for (const version of ["1.2.3-alpha.1", "1.2.3+001"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "bump-version.mjs"), "--check", version, "--root", root],
      { cwd: root, encoding: "utf8" }
    );
    assert.doesNotMatch(result.stderr, /Expected a valid Semantic Version/, `${version} must be accepted`);
  }
});

test("bump-version updates the package and Codex plugin manifests", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-targets-"));
  fs.mkdirSync(path.join(tempRoot, ".codex-plugin"), { recursive: true });
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
    fs.copyFileSync(path.join(root, relative), path.join(tempRoot, relative));
  }

  execFileSync(process.execPath, [path.join(root, "scripts", "bump-version.mjs"), "9.9.9", "--root", tempRoot], {
    cwd: tempRoot,
    encoding: "utf8"
  });

  const packageJson = JSON.parse(fs.readFileSync(path.join(tempRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(tempRoot, "package-lock.json"), "utf8"));
  const pluginJson = JSON.parse(fs.readFileSync(path.join(tempRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(packageJson.version, "9.9.9");
  assert.equal(packageLock.version, "9.9.9");
  assert.equal(packageLock.packages[""].version, "9.9.9");
  assert.equal(pluginJson.version, "9.9.9");
});

test("bump-version validates every manifest before changing any file", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-atomic-"));
  fs.mkdirSync(path.join(tempRoot, ".codex-plugin"), { recursive: true });
  for (const relative of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(root, relative), path.join(tempRoot, relative));
  }
  fs.writeFileSync(path.join(tempRoot, ".codex-plugin", "plugin.json"), "{ malformed\n", "utf8");

  const packageBefore = fs.readFileSync(path.join(tempRoot, "package.json"));
  const lockBefore = fs.readFileSync(path.join(tempRoot, "package-lock.json"));
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "bump-version.mjs"), "9.9.9", "--root", tempRoot],
    { cwd: tempRoot, encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(path.join(tempRoot, "package.json")), packageBefore);
  assert.deepEqual(fs.readFileSync(path.join(tempRoot, "package-lock.json")), lockBefore);
});

test("bump-version preserves a concurrent manifest edit made after staging", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-concurrent-"));
  fs.mkdirSync(path.join(tempRoot, ".codex-plugin"), { recursive: true });
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
    fs.copyFileSync(path.join(root, relative), path.join(tempRoot, relative));
  }

  const packagePath = path.join(tempRoot, "package.json");
  const lockBefore = fs.readFileSync(path.join(tempRoot, "package-lock.json"));
  const pluginBefore = fs.readFileSync(path.join(tempRoot, ".codex-plugin", "plugin.json"));
  const concurrent = `${fs.readFileSync(packagePath, "utf8").trimEnd()}\n `;

  assert.throws(
    () => bumpVersion(tempRoot, "9.9.9", {
      beforeCommit() {
        fs.writeFileSync(packagePath, concurrent, "utf8");
      }
    }),
    /Manifest changed during version preparation: package\.json/
  );
  assert.equal(fs.readFileSync(packagePath, "utf8"), concurrent);
  assert.deepEqual(fs.readFileSync(path.join(tempRoot, "package-lock.json")), lockBefore);
  assert.deepEqual(fs.readFileSync(path.join(tempRoot, ".codex-plugin", "plugin.json")), pluginBefore);
});

test("bump-version never overwrites a manifest changed at the replacement boundary", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-replace-race-"));
  fs.mkdirSync(path.join(tempRoot, ".codex-plugin"), { recursive: true });
  const originals = new Map();
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
    fs.copyFileSync(path.join(root, relative), path.join(tempRoot, relative));
    originals.set(relative, fs.readFileSync(path.join(tempRoot, relative)));
  }

  const packagePath = path.join(tempRoot, "package.json");
  const concurrent = `${fs.readFileSync(packagePath, "utf8").trimEnd()}\n `;

  assert.throws(
    () => bumpVersion(tempRoot, "9.9.9", {
      beforeReplace({ index }) {
        if (index === 0) fs.writeFileSync(packagePath, concurrent, "utf8");
      }
    }),
    /Manifest changed at version replacement boundary: package\.json/
  );

  assert.equal(fs.readFileSync(packagePath, "utf8"), concurrent);
  assert.deepEqual(fs.readFileSync(path.join(tempRoot, "package-lock.json")), originals.get("package-lock.json"));
  assert.deepEqual(fs.readFileSync(path.join(tempRoot, ".codex-plugin", "plugin.json")), originals.get(".codex-plugin/plugin.json"));
  assert.ok(!fs.existsSync(path.join(tempRoot, ".codex-version-bump.transaction")));
});

test("bump-version rolls back every replacement when an in-process commit fails", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-rollback-"));
  fs.mkdirSync(path.join(tempRoot, ".codex-plugin"), { recursive: true });
  const originals = new Map();
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
    fs.copyFileSync(path.join(root, relative), path.join(tempRoot, relative));
    originals.set(relative, fs.readFileSync(path.join(tempRoot, relative)));
  }

  assert.throws(
    () => bumpVersion(tempRoot, "9.9.9", {
      afterReplace({ index }) {
        if (index === 0) throw new Error("injected replacement failure");
      }
    }),
    /injected replacement failure/
  );

  for (const [relative, original] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(tempRoot, relative)), original, relative);
  }
  assert.ok(!fs.existsSync(path.join(tempRoot, ".codex-version-bump.transaction")));
});

test("bump-version recovers an abrupt process exit without leaving a canonical manifest absent", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-crash-"));
  fs.mkdirSync(path.join(tempRoot, ".codex-plugin"), { recursive: true });
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
    fs.copyFileSync(path.join(root, relative), path.join(tempRoot, relative));
  }

  const moduleUrl = new URL("../scripts/bump-version.mjs", import.meta.url).href;
  const childScript = [
    `import { bumpVersion } from ${JSON.stringify(moduleUrl)};`,
    `bumpVersion(${JSON.stringify(tempRoot)}, "9.9.9", {`,
    "  afterReplace({ index }) { if (index === 0) process.exit(91); }",
    "});"
  ].join("\n");
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: tempRoot,
    encoding: "utf8"
  });

  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
    assert.ok(fs.statSync(path.join(tempRoot, relative)).isFile(), `${relative} must remain present`);
  }
  assert.ok(fs.existsSync(path.join(tempRoot, ".codex-version-bump.transaction")));

  execFileSync(process.execPath, [path.join(root, "scripts", "bump-version.mjs"), "9.9.9", "--root", tempRoot], {
    cwd: tempRoot,
    encoding: "utf8"
  });

  const packageJson = JSON.parse(fs.readFileSync(path.join(tempRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(tempRoot, "package-lock.json"), "utf8"));
  const pluginJson = JSON.parse(fs.readFileSync(path.join(tempRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(packageJson.version, "9.9.9");
  assert.equal(packageLock.version, "9.9.9");
  assert.equal(packageLock.packages[""].version, "9.9.9");
  assert.equal(pluginJson.version, "9.9.9");
  assert.ok(!fs.existsSync(path.join(tempRoot, ".codex-version-bump.transaction")));
});

test("bump-version recovery distinguishes a stale reused PID from the original process", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-pid-reuse-"));
  fs.mkdirSync(path.join(tempRoot, ".codex-plugin"), { recursive: true });
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json"]) {
    fs.copyFileSync(path.join(root, relative), path.join(tempRoot, relative));
  }

  const moduleUrl = new URL("../scripts/bump-version.mjs", import.meta.url).href;
  const childScript = [
    `import { bumpVersion } from ${JSON.stringify(moduleUrl)};`,
    `bumpVersion(${JSON.stringify(tempRoot)}, "9.9.9", {`,
    "  afterReplace({ index }) { if (index === 0) process.exit(92); }",
    "});"
  ].join("\n");
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: tempRoot,
    encoding: "utf8"
  });
  assert.equal(crashed.status, 92, crashed.stderr || crashed.stdout);

  const ownerPath = path.join(tempRoot, ".codex-version-bump.transaction", "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  owner.pid = process.pid;
  owner.processIdentity = "original-process-instance";
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });

  assert.throws(
    () => recoverInterruptedTransaction(tempRoot, {
      isProcessAlive: () => true,
      processIdentityLookup: () => "original-process-instance"
    }),
    /transaction is active/
  );

  const conflicts = recoverInterruptedTransaction(tempRoot, {
    isProcessAlive: () => true,
    processIdentityLookup: () => "reused-process-instance"
  });
  assert.deepEqual(conflicts, []);
  assert.equal(fs.existsSync(path.dirname(ownerPath)), false);
});

test("package.json shape supports public npm publish", () => {
  const packageJson = JSON.parse(read("package.json"));

  assert.notEqual(packageJson.private, true);
  assert.notEqual(packageJson.private, "true");
  assert.equal(packageJson.name, "codex-plugin-cc");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+/);
  assert.ok(Array.isArray(packageJson.files));
  assert.ok(packageJson.files.length > 0);
  assert.equal(typeof packageJson.repository?.url, "string");
  assert.match(packageJson.repository.url, /Kenmege\/codex-plugin-cc/);
});

test("npmjs release configuration is public and trusted-publisher safe", () => {
  const packageJson = JSON.parse(read("package.json"));
  const workflow = read(".github/workflows/release.yml");

  assert.equal(packageJson.name, "codex-plugin-cc");
  assert.match(
    packageJson.repository.url,
    /^(git\+)?https:\/\/github\.com\/Kenmege\/codex-plugin-cc\.git$/
  );
  assert.deepEqual(packageJson.publishConfig, {
    registry: "https://registry.npmjs.org",
    access: "public"
  });
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /packages: write/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.doesNotMatch(workflow, /^\s+cache: npm$/m);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN/);
  assert.match(workflow, /npm install --global --ignore-scripts --no-audit --no-fund npm@11\.5\.1/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_tag:/);
  assert.match(workflow, /name: Verify release workflow ref/);
  assert.doesNotMatch(workflow, /github\.event\.repository\.default_branch/);
  assert.match(workflow, /ref: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /NPMJS_PUBLISH_ENABLED/);
  assert.doesNotMatch(workflow, /npm pkg set private=false/);
  assert.match(workflow, /id: publish-package/);
  assert.match(workflow, /npm view "codex-plugin-cc@\$\{VERSION\}" version/);
  assert.match(workflow, /Package codex-plugin-cc@\$\{VERSION\} already exists; skipping npm publish/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /gh release view "v\$\{VERSION\}"/);
  assert.match(workflow, /gh release edit "v\$\{VERSION\}"/);
  assert.match(workflow, /gh release create "v\$\{VERSION\}"/);
  assert.match(workflow, /--latest/);
  assert.match(workflow, /--prerelease/);
  assert.doesNotMatch(workflow, /--access restricted/);
  assert.equal(workflow.indexOf(["npm", "pkg", "github", "com"].join(".")), -1);
});

test("release workflow fails closed when tag and package version differ", () => {
  const workflow = read(".github/workflows/release.yml");
  const contributing = read("CONTRIBUTING.md");
  const tagPatternMatch = workflow.match(/const tagPattern = \/(.+)\/; process\.exit/);

  assert.match(workflow, /Verify tag matches package version/);
  assert.match(workflow, /id: tag-version-gate/);
  assert.match(workflow, /node -p "require\('\.\/package\.json'\)\.version" > \.release-package-version/);
  assert.match(workflow, /read -r PACKAGE_VERSION < \.release-package-version/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /Release tag '\$RELEASE_TAG' is not a supported semantic-version tag/);
  assert.ok(tagPatternMatch, "release workflow must expose its exact SemVer tag pattern");
  const tagPattern = new RegExp(tagPatternMatch[1]);
  for (const tag of ["v1.2.3", "v1.2.3-alpha.1", "v1.2.3+build.1", "v0.0.0-0+meta"]) {
    assert.equal(tagPattern.test(tag), true, `${tag} must be accepted`);
  }
  for (const tag of ["1.2.3", "v01.2.3", "v1.2.3.foo", "v1.2.3-01", "v1.2.3+build..1"]) {
    assert.equal(tagPattern.test(tag), false, `${tag} must be rejected`);
  }
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /git rev-parse --verify "refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}"/);
  assert.match(workflow, /Checked-out commit \$\{CHECKED_OUT_COMMIT\} does not match tag \$\{RELEASE_TAG\} commit \$\{TAG_COMMIT\}/);
  assert.match(workflow, /TAG_VERSION="\$\{RELEASE_TAG#v\}"/);
  assert.match(workflow, /Release tag v\$\{TAG_VERSION\} does not match package\.json version \$\{PACKAGE_VERSION\}/);
  assert.match(workflow, /printf 'version=%s\\n' "\$PACKAGE_VERSION" >> "\$GITHUB_OUTPUT"/);
  assert.match(contributing, /tag and package version differ/);
  assert.match(contributing, /1\.0\.3-rc\.1/);
});

test("release runbooks require npm trusted publishing without long-lived tokens", () => {
  for (const relativePath of [
    "CONTRIBUTING.md",
    "README.md",
    "docs/NPM_PUBLISH_CHECKLIST.md"
  ]) {
    const source = read(relativePath);

    assert.match(source, /npm\s+trusted\s+publish(?:er|ing)/i, relativePath);
    assert.doesNotMatch(source, /NPM_TOKEN/, relativePath);
    assert.doesNotMatch(source, /NODE_AUTH_TOKEN/, relativePath);
  }

  const contributing = read("CONTRIBUTING.md");
  const checklist = read("docs/NPM_PUBLISH_CHECKLIST.md");
  assert.match(contributing, /id-token: write/);
  assert.match(checklist, /release\.yml/);
  assert.match(checklist, /allowed action[^\n]*npm publish/i);
});

test("README release docs do not pin stale package versions", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, /package\.json` version `\d+\.\d+\.\d+`/);
  assert.doesNotMatch(readme, /v1\.0\.10/);
  assert.match(readme, /package\.json` version `X\.Y\.Z`/);
  assert.match(readme, /tag `vX\.Y\.Z`/);
});

test("public-facing docs do not contain private local machine paths", () => {
  for (const relativePath of [
    "README.md",
    "commands/review.md",
    "commands/adversarial-review.md",
    "commands/elite-review.md",
    "commands/deep-review.md",
    "commands/security-review.md",
    "commands/workspace.md",
    "commands/delegate.md",
    "commands/wait.md",
    "commands/logs.md",
    "commands/recover.md",
    "commands/list.md",
    "commands/attach.md",
    "commands/send.md",
    "commands/bridge-doctor.md",
    "commands/doctor.md",
    "commands/setup.md",
    "commands/status.md",
    "commands/result.md",
    "commands/cancel.md"
  ]) {
    assert.doesNotMatch(read(relativePath), /\/Users\/kenmege/, relativePath);
  }
});

test("public trust metadata is attribution-safe and precise", () => {
  const notice = read("NOTICE");
  const packageJson = JSON.parse(read("package.json"));
  const plugin = JSON.parse(read(".codex-plugin/plugin.json"));
  const claudeMarketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const readme = read("README.md");
  const security = read("SECURITY.md");
  const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
  const historicalLaunchNotes = [
    "RELEASE_NOTES_v1.0.2.md",
    "RELEASE_NOTES_v1.0.3.md",
    "RELEASE_NOTES_v1.0.9.md"
  ].map(read).join("\n");
  const currentReleaseNotes = read(`RELEASE_NOTES_v${packageJson.version}.md`);

  assert.match(notice, /Copyright 2026 Kennedy Umege/);
  assert.match(notice, /Copyright 2026 OpenAI/);
  assert.deepEqual(plugin.interface.capabilities, ["Interactive", "Read", "Write"]);
  assert.equal(packageJson.bin["codex-claude"], "scripts/claude-review-companion.mjs");
  assert.equal(claudeMarketplace.owner.name, "Kennedy Umege");
  assert.doesNotMatch(claudeMarketplace.owner.name, /OpenAI/);
  assert.match(readme, /Windows is not a supported v1 platform/);
  assert.doesNotMatch(readme, /macOS, Linux, and Windows are supported/);
  assert.equal(readme.includes("scorecard.dev"), false);
  assert.equal(readme.includes("api.scorecard.dev"), false);
  assert.equal(readme.includes("openai/codex-plugin-cc"), false);
  assert.match(readme, /OpenAI's Apache-2\.0 Codex plugin reference/);
  assert.equal(
    security.includes("github.com/Kenmege/codex-plugin-cc/security/advisories/new"),
    true
  );
  assert.equal(
    bug.includes("npm ls -g codex-plugin-cc") || bug.includes("codex-claude-review --version"),
    true
  );
  assert.doesNotMatch(bug, /@kenmege\/codex-plugin-cc/);
  assert.doesNotMatch(historicalLaunchNotes, /GPT-5\.5|gpt-5\.5/);
  assert.equal(plugin.name, "claude-review");
  assert.equal(plugin.interface.displayName, "Codex-Claude Bridge");
  assert.match(readme, /durable Codex-to-Claude control plane/i);
  assert.match(readme, /separate ephemeral, read-only\s+Codex process/i);
  assert.match(readme, /\/claude-review:delegate/);
  assert.match(security, /cooperative same-UID host trust/i);
  assert.match(security, /not a multi-tenant\s+security sandbox/i);
  assert.match(currentReleaseNotes, /Codex-supervised Claude coding workspace/);
  assert.match(currentReleaseNotes, /never launches a nested\s+Codex process/);
});

test("internal prompt artifacts are not tracked for public release", () => {
  const trackedPromptFiles = execFileSync("git", ["ls-files", "docs/*_PROMPT.md"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  assert.equal(trackedPromptFiles, "");
  assert.match(read(".gitignore"), /^docs\/\*_PROMPT\.md$/m);
});

test("release hygiene grep scope preserves reviewer WebFetch allowlist domains", () => {
  const contributing = read("CONTRIBUTING.md");
  const claude = read("scripts/lib/claude.mjs");
  assert.match(claude, /https:\/\/registry\.npmjs\.org\/\*/);
  assert.match(contributing, /scripts\/lib\/claude\.mjs/);
  assert.match(contributing, /WebFetch allowlist/);
});

test("Copilot code review instructions are present for GitHub review agents", () => {
  const source = read(".github/copilot-instructions.md");
  assert.match(source, /Copilot Code Review Instructions/);
  assert.match(source, /security-sensitive CLI plugin/);
  assert.match(source, /JSON schemas and `validateStructuredReviewOutput` stay in sync/);
});

test("Claude Code workflow is pinned, current, and auth-gated", () => {
  const workflow = read(".github/workflows/claude.yml");
  const prompt = read(".github/claude-review-prompt.md");
  const readme = read("README.md");
  const contributing = read("CONTRIBUTING.md");
  const interactiveOauthStep = workflowStep(workflow, "Run Claude interactive response with OAuth");
  const interactiveApiKeyStep = workflowStep(workflow, "Run Claude interactive response with API key");

  assert.match(workflow, /pull_request:\r?\n\s+types: \[opened, synchronize, ready_for_review, reopened\]/);
  assert.match(workflow, /anthropics\/claude-code-action@[a-f0-9]{40}/);
  assert.doesNotMatch(workflow, /anthropics\/claude-code-action@v1/);
  assert.doesNotMatch(workflow, /^\s+mode:/m);
  assert.doesNotMatch(workflow, /prompt-file:/);
  assert.match(workflow, /Run Claude auto review with OAuth/);
  assert.match(workflow, /Run Claude auto review with API key/);
  assert.match(workflow, /Run Claude interactive response with OAuth/);
  assert.match(workflow, /Run Claude interactive response with API key/);
  assert.match(workflow, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(workflow, /Verify Claude auth secret configured/);
  assert.match(workflow, /Claude Code Action requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(workflow, /IS_UNTRUSTED_FORK_PR/);
  assert.match(workflow, /does not pass repository Actions secrets to forked pull_request workflows/);
  assert.match(workflow, /--append-system-prompt/);
  assert.match(workflow, /HEAD_SHA=\$\(gh api "repos\/\$\{\{ github\.repository \}\}\/pulls\/\$\{PR_NUM\}" --jq '\.head\.sha'\)/);
  assert.match(workflow, /echo "head_sha=\$\{HEAD_SHA\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /ref: \$\{\{ steps\.resolve_pr_head\.outputs\.head_sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(interactiveOauthStep, /--max-turns 80/);
  assert.match(interactiveApiKeyStep, /--max-turns 80/);
  assert.doesNotMatch(interactiveOauthStep, /--max-turns 10/);
  assert.doesNotMatch(interactiveApiKeyStep, /--max-turns 10/);
  assert.match(workflow, /--model opus/);
  assert.doesNotMatch(workflow, /claude-opus-4-7/);
  assert.match(prompt, /Trust boundary:/);
  assert.match(prompt, /Review priorities, in order:/);
  assert.match(readme, /Reviewer Composition/);
  assert.match(readme, /Claude \(Anthropic Opus alias\)/);
  assert.match(contributing, /Working With Reviewers/);
  assert.match(contributing, /ANTHROPIC_API_KEY/);
});

test("public launch community files and release notes are present", () => {
  const codeowners = read(".github/CODEOWNERS");
  const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
  const feature = read(".github/ISSUE_TEMPLATE/feature_request.yml");
  const security = read(".github/ISSUE_TEMPLATE/security_report.yml");
  const issueConfig = read(".github/ISSUE_TEMPLATE/config.yml");
  const prTemplate = read(".github/PULL_REQUEST_TEMPLATE.md");
  const conduct = read("CODE_OF_CONDUCT.md");
  const releaseNotes = read("RELEASE_NOTES_v1.0.3.md");

  assert.match(codeowners, /^\*\s+@Kenmege/m);
  assert.match(codeowners, /CODEOWNERS only auto-requests humans\/teams with/);
  assert.match(bug, /Claude CLI version/);
  assert.match(bug, /Sanitized log tail/);
  assert.match(feature, /Affected review lane\(s\)/);
  assert.match(security, /Do not include exploit details in a public issue/);
  assert.match(issueConfig, /blank_issues_enabled: false/);
  assert.match(prTemplate, /No tokens, API keys, or credentials/);
  assert.match(conduct, /Contributor Covenant/);
  assert.match(releaseNotes, /v1\.0\.3/);
  assert.match(releaseNotes, /first public OSS release/);
  assert.match(releaseNotes, /Security Hardening/);
});

test("security docs describe inherit-mcp Task subagent trust expansion", () => {
  const architecture = read("docs/architecture.md");
  const security = read("SECURITY.md");
  for (const source of [architecture, security]) {
    assert.match(source, /--inherit-mcp/);
    assert.match(source, /Task subagents?/i);
    assert.match(source, /second-order trust expansion|expands trust indirectly/i);
    assert.equal(source.includes("docs.anthropic.com/en/docs/claude-code/sub-agents"), true);
  }
});

test("public docs document the add-dir boundary override", () => {
  const readme = read("README.md");
  const security = read("SECURITY.md");
  for (const source of [readme, security]) {
    assert.match(source, /CODEX_CLAUDE_ADD_DIR_BOUNDARY/);
    assert.match(source, /--add-dir/);
    assert.match(source, /workspace root/);
  }
});

test("workspace documentation promises stdin prompt transport", () => {
  const readme = read("README.md");
  const architecture = read("docs/architecture.md");
  const changelog = read("CHANGELOG.md");

  assert.match(readme, /delivered to Claude over stdin instead of the process argument list/);
  assert.match(architecture, /coding request is piped over stdin rather than included in process arguments/);
  assert.match(changelog, /transported to Claude over stdin/);
  assert.doesNotMatch(architecture, /--bg \"coding request\"/);
});

test("release checklist documents npmjs publish switch and v-tag trigger", () => {
  const source = read("CONTRIBUTING.md");
  assert.match(source, /NPMJS_PUBLISH_ENABLED=true/);
  assert.match(source, /npm trusted publisher/);
  assert.match(source, /GitHub OIDC identity/);
  assert.match(source, /v1\.0\.3/);
  assert.match(source, /matching the package version exactly/);
  assert.match(source, /RELEASE_NOTES_v\$\{VERSION\}\.md/);
  assert.match(source, /generated stub/);
});

test("architecture docs reference the exported structured parser name", () => {
  const source = read("docs/architecture.md");
  assert.match(source, /parseClaudeStructuredOutput/);
  assert.doesNotMatch(source, new RegExp("parseClaudeStructured" + "Review"));
});

test("repository validation accepts fork-renamed local marketplace names", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-cc-fork-"));
  try {
    fs.cpSync(root, tempRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(root, source);
        return (
          relative !== ".git" &&
          !relative.startsWith(".git/") &&
          relative !== ".claude-review" &&
          !relative.startsWith(".claude-review/")
        );
      }
    });
    const marketplacePath = path.join(tempRoot, ".agents/plugins/marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
    marketplace.name = "my-forked-review-marketplace";
    fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

    const output = execFileSync("node", ["scripts/validate-repo.mjs"], {
      cwd: tempRoot,
      encoding: "utf8"
    });
    assert.match(output, /Repository validation passed/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("repository validation works from paths containing spaces and Unicode", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-path-"));
  const tempRoot = path.join(parent, "plugin review 雪");
  try {
    fs.cpSync(root, tempRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(root, source);
        return (
          relative !== ".git" &&
          !relative.startsWith(".git/") &&
          relative !== ".claude-review" &&
          !relative.startsWith(".claude-review/")
        );
      }
    });

    const output = execFileSync(process.execPath, ["scripts/validate-repo.mjs"], {
      cwd: tempRoot,
      encoding: "utf8"
    });
    assert.match(output, /Repository validation passed/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

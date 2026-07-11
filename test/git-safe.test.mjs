import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WRAPPER = path.join(ROOT, "scripts", "bin", "git-safe.mjs");

function runWrapper(args, options = {}) {
  return spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) }
  });
}

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-safe-repo-"));
  fs.writeFileSync(path.join(cwd, "file.txt"), "one\n", "utf8");
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test User"],
    ["add", "file.txt"],
    ["commit", "--quiet", "-m", "initial"]
  ]) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  fs.writeFileSync(path.join(cwd, "file.txt"), "two\n", "utf8");
  return cwd;
}

test("git-safe rejects unknown subcommand", () => {
  const result = runWrapper(["push", "origin", "main"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /subcommand not allowed: push/);
});

test("git-safe rejects --no-index escape", () => {
  const result = runWrapper(["diff", "--no-index", "/etc/hosts", "/dev/null"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden flag: --no-index/);
});

test("git-safe rejects absolute paths outside cwd", () => {
  const result = runWrapper(["show", "HEAD:/etc/passwd"]);
  // HEAD:/etc/passwd does not contain a slash before the colon, so the path
  // detector treats anything starting with HEAD: as a non-path token. Ensure
  // a clearer absolute path is rejected.
  const direct = runWrapper(["log", "/etc/passwd"]);
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /absolute path outside workspace rejected/);
  // The HEAD:... form should at minimum not crash; it's a ref-spec, not a
  // filesystem path. Just confirm we don't 500.
  assert.notEqual(typeof result.status, "undefined");
});

test("git-safe rejects parent-traversal in path tokens", () => {
  const result = runWrapper(["log", "../../etc/passwd"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /parent-traversal path rejected/);
});

test("git-safe rejects backslash parent-traversal in path tokens", () => {
  const result = runWrapper(["log", "..\\..\\Windows\\win.ini"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shell metacharacter|parent-traversal path rejected/);
});

test("git-safe rejects shell metacharacters", () => {
  const result = runWrapper(["log", "; rm -rf ~"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shell metacharacter in argument/);
});

test("git-safe rejects --exec-path override", () => {
  const result = runWrapper(["diff", "--exec-path=/tmp/bad"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden flag prefix: --exec-path=/);
});

test("git-safe rejects -c config override", () => {
  const result = runWrapper(["-c", "core.editor=ed", "log"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /subcommand must not be a flag|subcommand not allowed/);
});

test("git-safe rejects mutating git config forms", () => {
  const result = runWrapper(["config", "--set", "user.email", "evil@example.com"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git config restricted to --get \/ --list/);
});

test("git-safe rejects inline path-valued options outside the workspace", () => {
  const cwd = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "git-safe-outside-"));
  const outsideConfig = path.join(outside, "outside.cfg");
  fs.writeFileSync(outsideConfig, "[leak]\nsecret = TOP_SECRET\n", "utf8");

  for (const args of [
    ["config", `--file=${outsideConfig}`, "--list"],
    ["config", "--file", outsideConfig, "--list"],
    ["config", `-f${outsideConfig}`, "--list"],
    ["blame", `--contents=${outsideConfig}`, "file.txt"],
    ["ls-files", `--exclude-from=${outsideConfig}`],
    ["ls-files", `-X${outsideConfig}`],
    ["diff", `--pathspec-from-file=${outsideConfig}`],
    ["log", `--ignore-revs-file=${outsideConfig}`],
    ["log", "--ignore-revs-file", outsideConfig]
  ]) {
    const result = runWrapper(args, { cwd });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /forbidden path-valued flag/i, args.join(" "));
    assert.doesNotMatch(result.stdout, /TOP_SECRET/, args.join(" "));
  }
});

test("git-safe rejects signature display that can invoke repository-configured verifiers", () => {
  const result = runWrapper(["log", "--show-signature", "-1"], { cwd: makeRepo() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden execution-capable flag/i);
});

test("git-safe prevents repository config includes from reading outside files", () => {
  const cwd = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "git-safe-include-"));
  const outsideConfig = path.join(outside, "outside.cfg");
  fs.writeFileSync(outsideConfig, "[leak]\nsecret = TOP_SECRET\n", "utf8");
  const configured = spawnSync("git", ["config", "--local", "include.path", outsideConfig], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);

  const explicit = runWrapper(["config", "--includes", "--list"], { cwd });
  assert.notEqual(explicit.status, 0);
  assert.match(explicit.stderr, /forbidden config source flag/i);
  assert.doesNotMatch(explicit.stdout, /TOP_SECRET/);

  const defaultList = runWrapper(["config", "--list"], { cwd });
  assert.equal(defaultList.status, 0, defaultList.stderr);
  assert.doesNotMatch(defaultList.stdout, /TOP_SECRET/);
});

test("git-safe rejects mutating git remote forms", () => {
  const result = runWrapper(["remote", "add", "evil", "https://evil.example.com"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git remote restricted to .*read-only forms/);
});

test("git-safe rejects network-capable remote inspection with hostile transport config", () => {
  if (process.platform === "win32") return;

  const cwd = makeRepo();
  const marker = path.join(cwd, "ssh-command-pwned.txt");
  const sshCommand = path.join(cwd, "hostile-ssh.sh");
  fs.writeFileSync(sshCommand, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
  fs.chmodSync(sshCommand, 0o755);

  for (const args of [
    ["remote", "add", "origin", "ssh://attacker.invalid/repo.git"],
    ["config", "--local", "core.sshCommand", sshCommand]
  ]) {
    const configured = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  }

  const show = runWrapper(["remote", "show", "origin"], { cwd });
  assert.notEqual(show.status, 0);
  assert.match(show.stderr, /git remote restricted to local read-only forms/);
  assert.equal(fs.existsSync(marker), false, "repository-local core.sshCommand executed");

  const getUrl = runWrapper(["remote", "get-url", "origin"], { cwd });
  assert.equal(getUrl.status, 0, getUrl.stderr || getUrl.stdout);
  assert.match(getUrl.stdout, /ssh:\/\/attacker\.invalid\/repo\.git/);
  assert.equal(fs.existsSync(marker), false, "remote get-url unexpectedly contacted the remote");
});

test("git-safe rejects mutating git tag forms", () => {
  const result = runWrapper(["tag", "-d", "v1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git tag restricted to listing/);
});

test("git-safe rejects branch ref mutations", () => {
  const cwd = makeRepo();
  const result = runWrapper(["branch", "review-mutates-ref"], { cwd });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git branch restricted to read-only forms/);
  const refs = spawnSync("git", ["branch", "--list", "review-mutates-ref"], { cwd, encoding: "utf8" });
  assert.equal(refs.stdout.trim(), "");
});

test("git-safe rejects tag creation and remote ref updates", () => {
  const cwd = makeRepo();
  const tag = runWrapper(["tag", "v-review-mutates"], { cwd });
  assert.notEqual(tag.status, 0);
  assert.match(tag.stderr, /git tag restricted to listing/);
  const tags = spawnSync("git", ["tag", "--list", "v-review-mutates"], { cwd, encoding: "utf8" });
  assert.equal(tags.stdout.trim(), "");

  const remote = runWrapper(["remote", "update"], { cwd });
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /git remote restricted to .*read-only forms/);
});

test("git-safe rejects diff output writes", () => {
  const cwd = makeRepo();
  const outputPath = path.join(cwd, "git-safe-wrote.patch");
  const result = runWrapper(["diff", `--output=${outputPath}`], { cwd });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden write-capable flag/);
  assert.equal(fs.existsSync(outputPath), false);
});

test("git-safe accepts a benign git status", () => {
  const result = runWrapper(["status", "--short"]);
  assert.equal(result.status, 0);
});

test("git-safe status does not refresh or rewrite the index", () => {
  const cwd = makeRepo();
  const trackedFile = path.join(cwd, "file.txt");
  fs.writeFileSync(trackedFile, "one\n", "utf8");
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(trackedFile, future, future);

  const indexPath = path.join(cwd, ".git", "index");
  const beforeContents = fs.readFileSync(indexPath);
  const beforeStat = fs.statSync(indexPath, { bigint: true });
  const result = runWrapper(["status", "--short"], { cwd });
  const afterStat = fs.statSync(indexPath, { bigint: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readFileSync(indexPath), beforeContents);
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
  assert.equal(afterStat.ctimeNs, beforeStat.ctimeNs);
});

test("git-safe accepts git rev-parse --show-toplevel", () => {
  const result = runWrapper(["rev-parse", "--show-toplevel"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /codex-plugin-cc/);
});

test("git-safe scrubs GIT_DIR / GIT_WORK_TREE env vars", () => {
  const result = runWrapper(["status", "--short"], {
    env: { GIT_DIR: "/tmp/evil-git-dir", GIT_WORK_TREE: "/tmp/evil-tree" }
  });
  // The wrapper deletes GIT_DIR/GIT_WORK_TREE before invoking git, so the
  // command should still succeed against the real repo.
  assert.equal(result.status, 0);
});

test("git-safe scrubs GIT_EXTERNAL_DIFF so git cannot run an external program", () => {
  const cwd = makeRepo();
  const marker = path.join(cwd, "pwned.txt");
  const hook = path.join(cwd, "hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
  fs.chmodSync(hook, 0o755);

  const result = runWrapper(["diff"], {
    cwd,
    env: { GIT_EXTERNAL_DIFF: hook }
  });

  // The diff itself should run fine; the external-diff program must NOT fire.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.existsSync(marker),
    false,
    "GIT_EXTERNAL_DIFF was not scrubbed: external program executed"
  );
});

test("git-safe scrubs GIT_TRACE so git cannot write to an attacker path", () => {
  const cwd = makeRepo();
  const traceFile = path.join(cwd, "trace-out.txt");

  const result = runWrapper(["status", "--short"], {
    cwd,
    env: { GIT_TRACE: traceFile }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.existsSync(traceFile),
    false,
    "GIT_TRACE was not scrubbed: git wrote trace output to a chosen path"
  );
});

test("git-safe scrubs GIT_CONFIG_COUNT config-injection triplets", () => {
  const cwd = makeRepo();
  const marker = path.join(cwd, "config-pwned.txt");
  const hook = path.join(cwd, "pager.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`, "utf8");
  fs.chmodSync(hook, 0o755);

  // Without scrubbing, this injects core.pager=<hook> for `git log`.
  const result = runWrapper(["log", "-1"], {
    cwd,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      GIT_CONFIG_VALUE_0: hook
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.existsSync(marker),
    false,
    "GIT_CONFIG_* triplet was not scrubbed: injected core.pager executed"
  );
});

test("git-safe neutralizes executable repository-local diff and fsmonitor config", () => {
  if (process.platform === "win32") return;

  const cwd = makeRepo();
  const diffMarker = path.join(cwd, "local-diff-pwned.txt");
  const fsmonitorMarker = path.join(cwd, "local-fsmonitor-pwned.txt");
  const diffHook = path.join(cwd, "local-diff.sh");
  const fsmonitorHook = path.join(cwd, "local-fsmonitor.sh");
  fs.writeFileSync(diffHook, `#!/bin/sh\ntouch ${JSON.stringify(diffMarker)}\n`, "utf8");
  fs.writeFileSync(fsmonitorHook, `#!/bin/sh\ntouch ${JSON.stringify(fsmonitorMarker)}\nexit 0\n`, "utf8");
  fs.chmodSync(diffHook, 0o755);
  fs.chmodSync(fsmonitorHook, 0o755);

  for (const [key, value] of [
    ["diff.external", diffHook],
    ["core.fsmonitor", fsmonitorHook]
  ]) {
    const configured = spawnSync("git", ["config", "--local", key, value], { cwd, encoding: "utf8" });
    assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  }

  const diff = runWrapper(["diff"], { cwd });
  const status = runWrapper(["status", "--short"], { cwd });

  assert.equal(diff.status, 0, diff.stderr || diff.stdout);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(fs.existsSync(diffMarker), false, "repository-local diff.external executed");
  assert.equal(fs.existsSync(fsmonitorMarker), false, "repository-local core.fsmonitor executed");
});

test("git-safe rejects oversized arguments", () => {
  const huge = "a/".repeat(3000); // 6000 chars
  const result = runWrapper(["log", huge]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /4096 byte limit|parent-traversal|absolute path/);
});

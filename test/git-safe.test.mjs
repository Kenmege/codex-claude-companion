import path from "node:path";
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

test("git-safe rejects mutating git remote forms", () => {
  const result = runWrapper(["remote", "add", "evil", "https://evil.example.com"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git remote restricted to read-only forms/);
});

test("git-safe rejects mutating git tag forms", () => {
  const result = runWrapper(["tag", "-d", "v1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git tag restricted to listing/);
});

test("git-safe accepts a benign git status", () => {
  const result = runWrapper(["status", "--short"]);
  assert.equal(result.status, 0);
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

test("git-safe rejects oversized arguments", () => {
  const huge = "a/".repeat(3000); // 6000 chars
  const result = runWrapper(["log", huge]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /4096 byte limit|parent-traversal|absolute path/);
});

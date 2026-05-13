import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { chooseContextMode, collectReviewContext, resolveReviewTarget } from "../scripts/lib/git.mjs";

function run(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

test("git helpers collect working tree review context", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-git-"));
  run(cwd, "init");
  run(cwd, "config", "user.email", "test@example.com");
  run(cwd, "config", "user.name", "Test User");
  fs.writeFileSync(path.join(cwd, "file.txt"), "hello\n", "utf8");
  run(cwd, "add", "file.txt");
  run(cwd, "commit", "-m", "initial");
  fs.writeFileSync(path.join(cwd, "file.txt"), "hello\nworld\n", "utf8");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);
  const selected = chooseContextMode(context, { longContext: false, inlineLimit: 100_000 });

  assert.equal(target.mode, "working-tree");
  assert.match(context.fullContent, /Unstaged Diff/);
  assert.equal(selected.mode, "full");
});

test("git helpers ignore internal .claude-review artifacts", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-git-"));
  run(cwd, "init");
  run(cwd, "config", "user.email", "test@example.com");
  run(cwd, "config", "user.name", "Test User");
  fs.writeFileSync(path.join(cwd, "index.js"), "const x = 1;\n", "utf8");
  run(cwd, "add", "index.js");
  run(cwd, "commit", "-m", "initial");

  fs.writeFileSync(path.join(cwd, "index.js"), "const x = 2;\n", "utf8");
  fs.mkdirSync(path.join(cwd, ".claude-review", "jobs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude-review", "jobs", "review.job.json"), "{\"status\":\"completed\"}\n", "utf8");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.deepEqual(context.changedFiles, ["index.js"]);
  assert.doesNotMatch(context.fullContent, /\.claude-review\/jobs\/review\.job\.json/);
});

test("directory scope reviews a clean snapshot instead of falling back to branch diff", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-directory-"));
  run(cwd, "init");
  run(cwd, "config", "user.email", "test@example.com");
  run(cwd, "config", "user.name", "Test User");
  fs.writeFileSync(path.join(cwd, "index.js"), "export const answer = 42;\n", "utf8");
  run(cwd, "add", "index.js");
  run(cwd, "commit", "-m", "baseline");

  const target = resolveReviewTarget(cwd, { scope: "directory" });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "directory");
  assert.deepEqual(context.changedFiles, ["index.js"]);
  assert.match(context.summary, /directory snapshot/i);
  assert.match(context.fullContent, /export const answer = 42/);
});

test("directory scope includes real source files above the untracked preview cap", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-directory-large-"));
  run(cwd, "init");
  run(cwd, "config", "user.email", "test@example.com");
  run(cwd, "config", "user.name", "Test User");
  const largeSource = `export const payload = "${"x".repeat(30 * 1024)}";\n`;
  fs.writeFileSync(path.join(cwd, "large.js"), largeSource, "utf8");
  run(cwd, "add", "large.js");
  run(cwd, "commit", "-m", "baseline");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "directory" }));

  assert.deepEqual(context.changedFiles, ["large.js"]);
  assert.match(context.fullContent, /export const payload/);
  assert.doesNotMatch(context.fullContent, /exceeds 24576 byte/);
});

test("directory scope loudly reports oversized and binary skipped files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-directory-skips-"));
  run(cwd, "init");
  run(cwd, "config", "user.email", "test@example.com");
  run(cwd, "config", "user.name", "Test User");
  fs.writeFileSync(path.join(cwd, "huge.js"), "x".repeat(1024 * 1024 + 1), "utf8");
  fs.writeFileSync(path.join(cwd, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  run(cwd, "add", "huge.js", "binary.dat");
  run(cwd, "commit", "-m", "baseline");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "directory" }));

  assert.match(context.summary, /2 file\(s\) were skipped/);
  assert.match(context.fullContent, /Directory Snapshot Skipped Files/);
  assert.match(context.fullContent, /huge\.js \(size, 1048577 bytes\)/);
  assert.match(context.fullContent, /binary\.dat \(binary, 4 bytes\)/);
  assert.match(context.summaryContent, /Directory Snapshot Skipped Files/);
});

test("chooseContextMode honors inline and long-context boundaries", () => {
  const context = {
    fullContent: "x".repeat(10),
    summaryContent: "summary"
  };

  assert.equal(chooseContextMode(context, { inlineLimit: 10 }).mode, "full");
  assert.equal(chooseContextMode(context, { inlineLimit: 9 }).mode, "summarized");
  assert.equal(
    chooseContextMode(context, { inlineLimit: 9, longContext: true, longContextLimit: 10 }).mode,
    "full"
  );
  assert.equal(
    chooseContextMode(context, { inlineLimit: 9, longContext: true, longContextLimit: 9 }).mode,
    "summarized"
  );
});

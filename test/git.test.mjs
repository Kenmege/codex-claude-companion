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

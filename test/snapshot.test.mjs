import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createDirectorySnapshot,
  isGitRepository,
  DEFAULT_SNAPSHOT_EXCLUDES
} from "../scripts/lib/snapshot.mjs";

function makeTempDir(prefix = "snapshot-source-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

test("isGitRepository true when .git directory exists", () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, ".git"));
  assert.equal(isGitRepository(dir), true);
});

test("isGitRepository false for plain directory and for missing path", () => {
  const dir = makeTempDir();
  assert.equal(isGitRepository(dir), false);
  assert.equal(isGitRepository(path.join(dir, "does-not-exist")), false);
});

test("DEFAULT_SNAPSHOT_EXCLUDES contains the heavy directories the user listed", () => {
  for (const name of ["node_modules", ".git", ".claude-review", "dist", "build", "coverage", ".next", ".turbo", ".cache"]) {
    assert.ok(DEFAULT_SNAPSHOT_EXCLUDES.includes(name), `expected ${name} in defaults`);
  }
});

test("createDirectorySnapshot copies reviewable files and inits a git repo", () => {
  const source = makeTempDir();
  writeFile(source, "src/index.js", "console.log('hello');\n");
  writeFile(source, "src/util.js", "export const x = 1;\n");
  writeFile(source, "README.md", "# project\n");

  const snap = createDirectorySnapshot(source);
  try {
    assert.ok(snap.snapshotRoot, "snapshotRoot must be set");
    assert.equal(snap.sourceRoot, path.resolve(source));
    assert.equal(snap.copiedFiles, 3);

    // Files exist at expected relative paths
    assert.equal(
      fs.readFileSync(path.join(snap.snapshotRoot, "src/index.js"), "utf8"),
      "console.log('hello');\n"
    );
    assert.equal(
      fs.readFileSync(path.join(snap.snapshotRoot, "README.md"), "utf8"),
      "# project\n"
    );

    // Git repo was initialised inside the snapshot dir
    assert.ok(fs.existsSync(path.join(snap.snapshotRoot, ".git")), "snapshot must be git-init'd");

    // Defensive .gitignore was written
    const gi = fs.readFileSync(path.join(snap.snapshotRoot, ".gitignore"), "utf8");
    assert.match(gi, /\.claude-review\//);
  } finally {
    snap.cleanup();
  }
});

test("createDirectorySnapshot excludes node_modules by default", () => {
  const source = makeTempDir();
  writeFile(source, "src/index.js", "ok\n");
  writeFile(source, "node_modules/garbage/big.js", "x".repeat(1_000));
  writeFile(source, "dist/output.js", "compiled\n");

  const snap = createDirectorySnapshot(source);
  try {
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "dist")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "src/index.js")), true);
  } finally {
    snap.cleanup();
  }
});

test("createDirectorySnapshot honours caller-supplied --exclude entries", () => {
  const source = makeTempDir();
  writeFile(source, "src/index.js", "ok\n");
  writeFile(source, "tools/internal/debug.js", "internal\n");

  const snap = createDirectorySnapshot(source, { excludes: ["tools"] });
  try {
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "tools")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "src/index.js")), true);
  } finally {
    snap.cleanup();
  }
});

test("createDirectorySnapshot skips symlinks (no escape from source root)", () => {
  if (process.platform === "win32") {
    // Symlink creation on Windows requires elevated permissions; skip there.
    return;
  }
  const source = makeTempDir();
  writeFile(source, "real.txt", "ok\n");
  fs.symlinkSync(os.homedir(), path.join(source, "escape-link"), "dir");

  const snap = createDirectorySnapshot(source);
  try {
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "escape-link")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "real.txt")), true);
    assert.ok(snap.skipped.some((s) => s.path === "escape-link" && s.reason === "symlink"));
  } finally {
    snap.cleanup();
  }
});

test("createDirectorySnapshot mapPathBack rewrites absolute snapshot paths to source paths", () => {
  const source = makeTempDir();
  writeFile(source, "src/index.js", "ok\n");
  const snap = createDirectorySnapshot(source);
  try {
    const snapAbs = path.join(snap.snapshotRoot, "src/index.js");
    const back = snap.mapPathBack(snapAbs);
    assert.equal(back, path.join(snap.sourceRoot, "src/index.js"));
    // Relative paths are passed through unchanged
    assert.equal(snap.mapPathBack("src/index.js"), "src/index.js");
  } finally {
    snap.cleanup();
  }
});

test("createDirectorySnapshot refuses to run on a non-directory path", () => {
  const source = makeTempDir();
  writeFile(source, "file.txt", "ok\n");
  assert.throws(
    () => createDirectorySnapshot(path.join(source, "file.txt")),
    /not a directory/
  );
});

test("createDirectorySnapshot refuses to run on a missing path", () => {
  const ghost = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`);
  assert.throws(() => createDirectorySnapshot(ghost), /does not exist/);
});

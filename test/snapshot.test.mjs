import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createDirectorySnapshot,
  isGitRepository,
  DEFAULT_SNAPSHOT_EXCLUDES,
  reapStaleDirectorySnapshots,
  SNAPSHOT_NAMESPACE
} from "../scripts/lib/snapshot.mjs";
import { runCommandCapture, runCommandChecked } from "../scripts/lib/process.mjs";

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

test("createDirectorySnapshot defaults to a private home-owned namespace", {
  skip: process.platform === "win32"
}, () => {
  const source = makeTempDir("snapshot-private-default-source-");
  const privateHome = makeTempDir("snapshot-private-default-home-");
  const previousHome = process.env.HOME;
  writeFile(source, "index.js", "ok\n");

  process.env.HOME = privateHome;
  let snap;
  try {
    snap = createDirectorySnapshot(source);
    const expectedRoot = path.join(
      fs.realpathSync.native(privateHome),
      ".claude-review",
      "snapshots",
      SNAPSHOT_NAMESPACE
    );
    assert.equal(
      snap.snapshotRoot.startsWith(`${expectedRoot}${path.sep}`),
      true,
      `snapshot escaped private home namespace: ${snap.snapshotRoot}`
    );
    assert.equal(fs.statSync(expectedRoot).mode & 0o777, 0o700);
  } finally {
    snap?.cleanup();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(privateHome, { recursive: true, force: true });
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

test("createDirectorySnapshot excludes secret-bearing files by default", () => {
  const source = makeTempDir();
  writeFile(source, "src/index.js", "ok\n");
  writeFile(source, ".env", "TOKEN=should-not-leak\n");
  writeFile(source, ".npmrc", "//registry.npmjs.org/:_authToken=secret\n");
  writeFile(source, "certs/private.pem", "-----BEGIN PRIVATE KEY-----\nsecret\n");
  writeFile(source, "terraform/prod.tfvars", "password = \"secret\"\n");
  writeFile(source, "firebase-service-account.json", "{\"private_key\":\"secret\"}\n");
  writeFile(source, ".kube/config", "token: secret\n");
  writeFile(source, ".ENV.PRODUCTION", "TOKEN=secret\n");
  writeFile(source, "config/.NPMRC", "//registry.npmjs.org/:_authToken=secret\n");
  writeFile(source, ".SSH/config", "IdentityFile private-key\n");
  writeFile(source, "AZUREPROFILE.JSON", "{\"token\":\"secret\"}\n");
  writeFile(source, "SERVICEACCOUNTKEY.JSON", "{\"private_key\":\"secret\"}\n");

  const snap = createDirectorySnapshot(source);
  try {
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "src/index.js")), true);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, ".env")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, ".npmrc")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "certs", "private.pem")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "terraform", "prod.tfvars")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "firebase-service-account.json")), false);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, ".kube")), false);
    assert.ok(snap.skipped.some((s) => s.path === ".env" && s.reason === "sensitive-pattern"));
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, ".SSH")), false);
    assert.ok(
      snap.skipped.some(
        (item) => item.path === ".SSH" && item.reason === "sensitive-pattern"
      )
    );
    for (const secretPath of [
      ".ENV.PRODUCTION",
      "config/.NPMRC",
      "AZUREPROFILE.JSON",
      "SERVICEACCOUNTKEY.JSON"
    ]) {
      assert.equal(fs.existsSync(path.join(snap.snapshotRoot, secretPath)), false, secretPath);
      assert.ok(
        snap.skipped.some((item) => item.path === secretPath && item.reason === "sensitive-pattern"),
        secretPath
      );
    }
  } finally {
    snap.cleanup();
  }
});

test("reapStaleDirectorySnapshots removes only dead owned snapshots from the private namespace", () => {
  const tempRoot = makeTempDir("snapshot-reaper-");
  const source = makeTempDir("snapshot-reaper-source-");
  writeFile(source, "index.js", "ok\n");
  const oldSnapshot = createDirectorySnapshot(source, { tempRoot });
  const newSnapshot = createDirectorySnapshot(source, { tempRoot });
  const unrelated = fs.mkdtempSync(path.join(tempRoot, "snapshot-user-data-"));
  fs.writeFileSync(path.join(unrelated, "sentinel.txt"), "keep\n", "utf8");

  const oldMetadataPath = path.join(oldSnapshot.snapshotRoot, ".codex-snapshot.meta.json");
  const oldMetadata = JSON.parse(fs.readFileSync(oldMetadataPath, "utf8"));
  oldMetadata.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  oldMetadata.pid = 2_147_483_647;
  fs.writeFileSync(oldMetadataPath, `${JSON.stringify(oldMetadata, null, 2)}\n`, "utf8");

  const result = reapStaleDirectorySnapshots(tempRoot);

  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(oldSnapshot.snapshotRoot), false);
  assert.equal(fs.existsSync(newSnapshot.snapshotRoot), true);
  assert.equal(fs.readFileSync(path.join(unrelated, "sentinel.txt"), "utf8"), "keep\n");
  newSnapshot.cleanup();
});

test("createDirectorySnapshot rejects a forged namespace ownership marker", {
  skip: typeof process.getuid !== "function"
}, () => {
  const tempRoot = makeTempDir("snapshot-forged-owner-");
  const source = makeTempDir("snapshot-forged-source-");
  writeFile(source, "index.js", "ok\n");
  const namespaceRoot = path.join(tempRoot, SNAPSHOT_NAMESPACE);
  fs.mkdirSync(namespaceRoot, { mode: 0o700 });
  fs.writeFileSync(
    path.join(namespaceRoot, ".codex-snapshot-owner.json"),
    `${JSON.stringify({
      version: 2,
      namespace: SNAPSHOT_NAMESPACE,
      ownerId: "00000000-0000-4000-8000-000000000000",
      uid: process.getuid() + 1,
      createdAt: new Date().toISOString()
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  assert.throws(
    () => createDirectorySnapshot(source, { tempRoot }),
    /ownership marker is invalid/
  );
});

test("reapStaleDirectorySnapshots preserves an old snapshot owned by a live process", () => {
  const tempRoot = makeTempDir("snapshot-live-reaper-");
  const source = makeTempDir("snapshot-live-source-");
  writeFile(source, "index.js", "ok\n");
  const snapshot = createDirectorySnapshot(source, { tempRoot });
  const metadataPath = path.join(snapshot.snapshotRoot, ".codex-snapshot.meta.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  metadata.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  assert.equal(metadata.pid, process.pid);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const result = reapStaleDirectorySnapshots(tempRoot);

  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(snapshot.snapshotRoot), true);
  snapshot.cleanup();
});

test("createDirectorySnapshot honours source gitignore", () => {
  const source = makeTempDir();
  writeFile(source, ".gitignore", "private.txt\n");
  writeFile(source, "public.txt", "ok\n");
  writeFile(source, "private.txt", "ignored\n");
  runCommandChecked("git", ["init", "--quiet"], { cwd: source });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: source });
  runCommandChecked("git", ["config", "user.name", "Test User"], { cwd: source });

  const snap = createDirectorySnapshot(source);
  try {
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "public.txt")), true);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "private.txt")), false);
    assert.ok(snap.skipped.some((s) => s.path === "private.txt" && s.reason === "gitignore"));
  } finally {
    snap.cleanup();
  }
});

test("createDirectorySnapshot honours parent worktree ignore rules for a nested source", () => {
  const repository = makeTempDir();
  const source = path.join(repository, "packages", "app");
  fs.mkdirSync(source, { recursive: true });
  writeFile(repository, ".gitignore", "packages/app/private.txt\n");
  writeFile(source, "public.txt", "ok\n");
  writeFile(source, "private.txt", "must-not-copy\n");
  runCommandChecked("git", ["init", "--quiet"], { cwd: repository });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  runCommandChecked("git", ["config", "user.name", "Test User"], { cwd: repository });

  const snap = createDirectorySnapshot(source);
  try {
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "public.txt")), true);
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "private.txt")), false);
    assert.ok(snap.skipped.some((item) => item.path === "private.txt" && item.reason === "gitignore"));
  } finally {
    snap.cleanup();
  }
});

test("createDirectorySnapshot fails closed when Git ignore discovery fails", () => {
  const source = makeTempDir();
  const tempRoot = makeTempDir("snapshot-ignore-failure-");
  writeFile(source, ".gitignore", "private-review.txt\n");
  writeFile(source, "public.txt", "ok\n");
  writeFile(source, "private-review.txt", "must-not-copy\n");
  fs.writeFileSync(path.join(source, ".git"), "gitdir: /definitely/missing/git-dir\n", "utf8");

  assert.throws(
    () => createDirectorySnapshot(source, { tempRoot }),
    /Git ignore discovery failed/i
  );
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.startsWith("snapshot-")),
    [],
    "failed snapshot containing ignored data survived cleanup"
  );
});

test("createDirectorySnapshot fails closed for a nested source when ancestor Git discovery fails", () => {
  const repository = makeTempDir();
  const source = path.join(repository, "packages", "app");
  const tempRoot = makeTempDir("snapshot-nested-ignore-failure-");
  fs.mkdirSync(source, { recursive: true });
  writeFile(source, "public.txt", "ok\n");
  writeFile(source, "private-review.txt", "must-not-copy\n");
  fs.writeFileSync(path.join(repository, ".git"), "gitdir: /definitely/missing/git-dir\n", "utf8");

  assert.throws(
    () => createDirectorySnapshot(source, { tempRoot }),
    /Git ignore discovery failed/i
  );
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.startsWith("snapshot-")),
    [],
    "failed nested snapshot survived cleanup"
  );
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

test("createDirectorySnapshot rejects a file swapped to an outside symlink before open", () => {
  if (process.platform === "win32") return;

  const source = makeTempDir();
  const outside = makeTempDir();
  const victim = path.join(source, "victim.txt");
  const outsideSecret = path.join(outside, "outside-secret.txt");
  writeFile(source, "victim.txt", "safe\n");
  writeFile(outside, "outside-secret.txt", "must-not-copy\n");

  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = function patchedOpenSync(file, flags, ...rest) {
    if (!swapped && path.resolve(String(file)) === victim && (Number(flags) & fs.constants.O_RDONLY) === fs.constants.O_RDONLY) {
      swapped = true;
      fs.unlinkSync(victim);
      fs.symlinkSync(outsideSecret, victim, "file");
    }
    return originalOpenSync.call(this, file, flags, ...rest);
  };

  let snap;
  try {
    snap = createDirectorySnapshot(source);
    assert.equal(swapped, true, "test did not exercise the pre-open swap");
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "victim.txt")), false);
    assert.ok(snap.skipped.some((item) => item.path === "victim.txt" && /symlink|open|changed/i.test(item.reason)));
  } finally {
    fs.openSync = originalOpenSync;
    snap?.cleanup();
  }
});

test("createDirectorySnapshot rejects and removes a file truncated during copying", () => {
  const source = makeTempDir();
  const victim = path.join(source, "large.txt");
  fs.writeFileSync(victim, Buffer.alloc(192 * 1024, 0x61));

  const originalReadSync = fs.readSync;
  let truncated = false;
  fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
    const bytesRead = originalReadSync.call(this, fd, buffer, offset, length, position);
    if (!truncated && bytesRead > 0 && length === 64 * 1024) {
      truncated = true;
      fs.truncateSync(victim, 0);
    }
    return bytesRead;
  };

  let snap;
  try {
    snap = createDirectorySnapshot(source);
    assert.equal(truncated, true, "test did not exercise truncation during copying");
    assert.equal(fs.existsSync(path.join(snap.snapshotRoot, "large.txt")), false);
    assert.ok(snap.skipped.some((item) => item.path === "large.txt" && /changed|short read/i.test(item.reason)));
  } finally {
    fs.readSync = originalReadSync;
    snap?.cleanup();
  }
});

test("createDirectorySnapshot removes its private directory when setup fails", () => {
  const source = makeTempDir();
  const tempRoot = makeTempDir("snapshot-setup-failure-");
  writeFile(source, "src/index.js", "ok\n");

  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(file, ...rest) {
    if (path.basename(String(file)) === ".codex-snapshot.meta.json") {
      throw new Error("injected metadata failure");
    }
    return originalOpenSync.call(this, file, ...rest);
  };

  try {
    assert.throws(
      () => createDirectorySnapshot(source, { tempRoot }),
      /injected metadata failure/
    );
    const namespaceRoot = path.join(tempRoot, SNAPSHOT_NAMESPACE);
    assert.deepEqual(fs.readdirSync(namespaceRoot), [".codex-snapshot-owner.json"]);
  } finally {
    fs.openSync = originalOpenSync;
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
    const sibling = path.join(`${snap.snapshotRoot}-sibling`, "outside.js");
    assert.equal(snap.mapPathBack(sibling), sibling);
    assert.equal(snap.mapPathBack(snap.snapshotRoot), snap.sourceRoot);
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

test("runCommandCapture inputData pipes prompt bytes via stdin (no temp file)", async () => {
  // Cross-platform stdin echo: node prints stdin to stdout. This proves the
  // inputData transport actually delivers bytes to the child's stdin without
  // requiring a temp file on disk.
  const result = await runCommandCapture(
    process.execPath,
    ["-e", "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.stdout.write(b));"],
    { inputData: "hello-from-memory-stdin", timeout: 10_000 }
  );
  assert.equal(result.error, null, result.stderr);
  assert.equal(result.stdout, "hello-from-memory-stdin");
});

test("runCommandCapture inputData survives EPIPE when child closes stdin early", async () => {
  // Child exits immediately (status 7) without reading stdin. The parent must not
  // crash on EPIPE — we should still observe status 7 and the original exit reason.
  const result = await runCommandCapture(
    process.execPath,
    ["-e", "process.exit(7);"],
    { inputData: "x".repeat(64 * 1024), timeout: 5_000 }
  );
  assert.equal(result.status, 7);
});

test("runCommandCapture inputPath pipes a file via stdin (persisted prompt)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rcap-inputpath-"));
  const file = path.join(dir, "input.txt");
  fs.writeFileSync(file, "hello-from-file-stdin", "utf8");
  const result = await runCommandCapture(
    process.execPath,
    ["-e", "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.stdout.write(b));"],
    { inputPath: file, timeout: 10_000 }
  );
  assert.equal(result.error, null, result.stderr);
  assert.equal(result.stdout, "hello-from-file-stdin");
});

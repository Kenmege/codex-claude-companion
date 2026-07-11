import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { runCommand, runCommandChecked } from "./process.mjs";

// Default exclude directory names (matched as the basename of any directory along the path).
// These are the heaviest / least-useful-to-review directories in real-world JS/TS/Python projects.
export const DEFAULT_SNAPSHOT_EXCLUDES = Object.freeze([
  "node_modules",
  ".git",
  ".claude-review",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".nuxt",
  ".vercel",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",          // Rust
  ".gradle",         // Gradle
  ".idea",
  ".vscode"
]);

const DEFAULT_SECRET_BASENAMES = Object.freeze([
  ".env",
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".htpasswd",
  "credentials.json",
  "kubeconfig",
  "wp-config.php",
  "azureProfile.json",
  "serviceAccountKey.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);

const DEFAULT_SECRET_DIRS = Object.freeze([
  ".aws",
  ".ssh",
  ".gnupg",
  ".kube"
]);

const STALE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_NAMESPACE = "codex-claude-review-snapshots-v2";
const SNAPSHOT_NAMESPACE_VERSION = 2;
const SNAPSHOT_NAMESPACE_MARKER = ".codex-snapshot-owner.json";
const SNAPSHOT_METADATA = ".codex-snapshot.meta.json";

// Hard cap on snapshot size — defensive guard against runaway directories.
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_FILES = 50_000;

/**
 * True iff `dir` has a `.git` directory or file (worktrees use a `.git` file).
 * Pure filesystem check — does not invoke `git`.
 */
export function isGitRepository(dir) {
  if (!dir) return false;
  try {
    const gitPath = path.join(dir, ".git");
    return fs.existsSync(gitPath);
  } catch {
    return false;
  }
}

function findAncestorGitControlEntry(dir) {
  let current = path.resolve(dir);
  while (true) {
    const gitEntry = path.join(current, ".git");
    try {
      fs.lstatSync(gitEntry);
      return gitEntry;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the effective exclude set: defaults ∪ caller-supplied list.
 * Caller list is matched against basenames (case-sensitive).
 */
function resolveExcludes(extraExcludes = []) {
  const out = new Set(DEFAULT_SNAPSHOT_EXCLUDES);
  for (const item of extraExcludes) {
    const trimmed = String(item ?? "").trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function isSensitiveSnapshotPath(relativePath) {
  const normalised = String(relativePath ?? "").split(path.sep).join("/");
  const base = path.basename(normalised);
  const lowerBase = base.toLowerCase();
  const parts = normalised.split("/");
  const lowerParts = parts.map((part) => part.toLowerCase());

  if (DEFAULT_SECRET_BASENAMES.some((name) => name.toLowerCase() === lowerBase)) return true;
  if (lowerBase.startsWith(".env.")) return true;
  if (lowerBase.startsWith("id_rsa") || lowerBase.startsWith("id_ed25519")) return true;
  if (DEFAULT_SECRET_DIRS.some((dir) => lowerParts.includes(dir.toLowerCase()))) return true;
  if (/\.(pem|key|pfx|p12|kdbx)$/i.test(lowerBase)) return true;
  if (/\.(tfvars|tfvars\.json|tfstate|tfstate\.backup)$/i.test(lowerBase)) return true;
  return /(service[-_]?account|firebase-adminsdk).*\.json$/i.test(lowerBase) || /\.key\.json$/i.test(lowerBase);
}

function readJsonNoFollow(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`Refusing non-regular metadata file: ${filePath}`);
    }
    const contents = fs.readFileSync(fd, "utf8");
    const afterRead = fs.fstatSync(fd);
    const after = fs.lstatSync(filePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameFileIdentity(opened, afterRead) ||
      !sameFileIdentity(opened, after) ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs ||
      afterRead.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Metadata changed during secure read: ${filePath}`);
    }
    return JSON.parse(contents);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeExclusiveJson(filePath, value, mode = 0o600) {
  const fd = fs.openSync(filePath, "wx", mode);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function loadSnapshotNamespace(tempRoot) {
  const namespaceRoot = path.join(path.resolve(tempRoot), SNAPSHOT_NAMESPACE);
  const stat = fs.lstatSync(namespaceRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Snapshot namespace is not a private directory: ${namespaceRoot}`);
  }
  const canonicalTempRoot = fs.realpathSync.native(path.resolve(tempRoot));
  const canonicalNamespaceRoot = fs.realpathSync.native(namespaceRoot);
  if (!isWithinRoot(canonicalNamespaceRoot, canonicalTempRoot)) {
    throw new Error(`Snapshot namespace resolved outside temp root: ${namespaceRoot}`);
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const currentGid = typeof process.getgid === "function" ? process.getgid() : null;
  if (
    (currentUid !== null && stat.uid !== currentUid) ||
    (currentGid !== null && stat.gid !== currentGid) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(`Snapshot namespace ownership is unsafe: ${namespaceRoot}`);
  }
  const marker = readJsonNoFollow(path.join(namespaceRoot, SNAPSHOT_NAMESPACE_MARKER));
  if (
    marker?.version !== SNAPSHOT_NAMESPACE_VERSION ||
    marker?.namespace !== SNAPSHOT_NAMESPACE ||
    marker?.uid !== currentUid ||
    marker?.gid !== currentGid ||
    typeof marker?.ownerId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(marker.ownerId)
  ) {
    throw new Error(`Snapshot namespace ownership marker is invalid: ${namespaceRoot}`);
  }
  return { namespaceRoot: canonicalNamespaceRoot, ownerId: marker.ownerId };
}

function ensureSnapshotNamespace(tempRoot) {
  const resolvedTempRoot = path.resolve(tempRoot);
  fs.mkdirSync(resolvedTempRoot, { recursive: true, mode: 0o700 });
  const namespaceRoot = path.join(resolvedTempRoot, SNAPSHOT_NAMESPACE);
  try {
    fs.mkdirSync(namespaceRoot, { mode: 0o700 });
    fs.chmodSync(namespaceRoot, 0o700);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const markerPath = path.join(namespaceRoot, SNAPSHOT_NAMESPACE_MARKER);
  try {
    writeExclusiveJson(markerPath, {
      version: SNAPSHOT_NAMESPACE_VERSION,
      namespace: SNAPSHOT_NAMESPACE,
      ownerId: randomUUID(),
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return loadSnapshotNamespace(resolvedTempRoot);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function reapStaleDirectorySnapshots(tempRoot, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? STALE_SNAPSHOT_MAX_AGE_MS;
  let namespace;
  try {
    namespace = options.namespace ?? loadSnapshotNamespace(tempRoot);
  } catch {
    return { removed: 0, skipped: 0 };
  }
  let entries;
  try {
    entries = fs.readdirSync(namespace.namespaceRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, skipped: 0 };
  }

  let removed = 0;
  let skipped = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("snapshot-")) continue;
    const snapshotDir = path.join(namespace.namespaceRoot, entry.name);
    const metadataPath = path.join(snapshotDir, SNAPSHOT_METADATA);
    let metadata;
    try {
      metadata = readJsonNoFollow(metadataPath);
    } catch {
      skipped += 1;
      continue;
    }
    const createdMs = Date.parse(metadata?.createdAt);
    if (
      metadata?.version !== SNAPSHOT_NAMESPACE_VERSION ||
      metadata?.ownerId !== namespace.ownerId ||
      typeof metadata?.snapshotId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(metadata.snapshotId) ||
      !Number.isFinite(createdMs) ||
      now - createdMs < maxAgeMs ||
      isProcessAlive(metadata.pid)
    ) {
      skipped += 1;
      continue;
    }
    try {
      const before = fs.lstatSync(snapshotDir);
      const canonicalSnapshot = fs.realpathSync.native(snapshotDir);
      if (before.isSymbolicLink() || !before.isDirectory() || !isWithinRoot(canonicalSnapshot, namespace.namespaceRoot)) {
        throw new Error("snapshot candidate is outside the owned namespace");
      }
      const claimedPath = path.join(namespace.namespaceRoot, `reap-${randomUUID()}`);
      fs.renameSync(snapshotDir, claimedPath);
      const claimed = fs.lstatSync(claimedPath);
      if (!sameFileIdentity(before, claimed) || claimed.isSymbolicLink() || !claimed.isDirectory()) {
        throw new Error("snapshot candidate changed during reap claim");
      }
      fs.rmSync(claimedPath, { recursive: true, force: true });
      removed += 1;
    } catch {
      skipped += 1;
    }
  }
  return { removed, skipped };
}

function collectGitIgnoredPaths(sourceRoot) {
  const discovery = runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: sourceRoot,
    maxBuffer: 1024 * 1024
  });
  if (discovery.status !== 0) {
    if (!findAncestorGitControlEntry(sourceRoot)) return new Set();
    const detail = String(discovery.stderr || discovery.stdout || `git exited ${discovery.status}`).trim();
    throw new Error(`Git ignore discovery failed for ${sourceRoot}: ${detail}`);
  }

  const worktreeRoot = fs.realpathSync.native(String(discovery.stdout).trim());
  const canonicalSourceRoot = fs.realpathSync.native(sourceRoot);
  if (!isWithinRoot(canonicalSourceRoot, worktreeRoot)) {
    throw new Error(`Git ignore discovery failed for ${sourceRoot}: source resolved outside its worktree`);
  }
  const sourcePathspec = path.relative(worktreeRoot, canonicalSourceRoot).split(path.sep).join("/") || ".";
  const result = runCommand("git", ["ls-files", "--ignored", "--others", "--exclude-standard", "-z", "--", sourcePathspec], {
    cwd: worktreeRoot,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `git exited ${result.status}`).trim();
    throw new Error(`Git ignore discovery failed for ${sourceRoot}: ${detail}`);
  }
  const ignored = new Set();
  for (const gitPath of String(result.stdout ?? "").split("\0").filter(Boolean)) {
    const absolutePath = path.resolve(worktreeRoot, gitPath);
    if (isWithinRoot(absolutePath, canonicalSourceRoot)) {
      ignored.add(path.relative(canonicalSourceRoot, absolutePath).split(path.sep).join("/"));
    }
  }
  return ignored;
}

function isIgnoredPath(relativePath, ignoredPaths) {
  if (!ignoredPaths?.size) return false;
  const normalised = String(relativePath ?? "").split(path.sep).join("/");
  if (ignoredPaths.has(normalised)) return true;
  const parts = normalised.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    if (ignoredPaths.has(parts.slice(0, index).join("/"))) return true;
  }
  return false;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readStableDirectory(src, canonicalSourceRoot) {
  const before = fs.lstatSync(src);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw Object.assign(new Error("directory changed or became a symlink"), { code: "ERACE" });
  }
  const resolvedBefore = fs.realpathSync.native(src);
  if (!isWithinRoot(resolvedBefore, canonicalSourceRoot)) {
    throw Object.assign(new Error("directory resolved outside source root"), { code: "EOUTSIDE" });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  const after = fs.lstatSync(src);
  const resolvedAfter = fs.realpathSync.native(src);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameFileIdentity(before, after) ||
    !isWithinRoot(resolvedAfter, canonicalSourceRoot)
  ) {
    throw Object.assign(new Error("directory changed during enumeration"), { code: "ERACE" });
  }
  return entries;
}

function copyRegularFileNoFollow(srcPath, dstPath, canonicalSourceRoot, maxBytes) {
  let sourceFd;
  let destinationFd;
  let destinationCreated = false;
  let copyCompleted = false;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    sourceFd = fs.openSync(srcPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(sourceFd);
    const current = fs.lstatSync(srcPath);
    const resolvedAfter = fs.realpathSync.native(srcPath);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameFileIdentity(opened, current) ||
      !isWithinRoot(resolvedAfter, canonicalSourceRoot)
    ) {
      return { copied: false, reason: "file changed during secure open" };
    }
    if (opened.size > maxBytes) {
      return { copied: false, reason: "size cap" };
    }

    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    destinationFd = fs.openSync(
      dstPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      opened.mode & 0o777
    );
    destinationCreated = true;

    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, opened.size)));
    let remaining = opened.size;
    let copiedBytes = 0;
    while (remaining > 0) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) {
        throw Object.assign(new Error("file changed during copy (short read)"), { code: "ERACE" });
      }
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
      }
      copiedBytes += bytesRead;
      remaining -= bytesRead;
    }

    const afterCopy = fs.fstatSync(sourceFd);
    if (
      !sameFileIdentity(opened, afterCopy) ||
      afterCopy.size !== opened.size ||
      afterCopy.mtimeMs !== opened.mtimeMs ||
      afterCopy.ctimeMs !== opened.ctimeMs
    ) {
      throw Object.assign(new Error("file changed during copy"), { code: "ERACE" });
    }
    copyCompleted = true;
    return { copied: true, size: copiedBytes };
  } catch (error) {
    const detail = error.code ? `${error.code}: ${error.message}` : error.message;
    return { copied: false, reason: `secure open/copy failed: ${detail}` };
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
    if (destinationCreated && !copyCompleted) {
      fs.rmSync(dstPath, { force: true });
    }
  }
}

/**
 * Walk `sourceRoot` and copy reviewable files into `snapshotRoot`, honouring excludes
 * and size/file-count caps. Returns { copiedFiles, totalBytes, skipped }.
 *
 * Cross-platform: uses Node fs APIs only, no shell. Path separators normalised through
 * path.join so it works on macOS, Linux, and Windows identically.
 */
function copyTree(sourceRoot, snapshotRoot, excludes, limits, ignoredPaths) {
  const canonicalSourceRoot = fs.realpathSync.native(sourceRoot);
  const stack = [{ src: sourceRoot, rel: "" }];
  let copiedFiles = 0;
  let totalBytes = 0;
  const skipped = [];

  while (stack.length > 0) {
    const { src, rel } = stack.pop();
    let entries;
    try {
      entries = readStableDirectory(src, canonicalSourceRoot);
      if (rel) fs.mkdirSync(path.join(snapshotRoot, rel), { recursive: true });
    } catch (err) {
      skipped.push({ path: rel || ".", reason: `readdir failed: ${err.code ?? err.message}` });
      continue;
    }

    for (const entry of entries) {
      if (excludes.has(entry.name)) {
        skipped.push({ path: path.join(rel, entry.name), reason: "excluded" });
        continue;
      }
      const srcPath = path.join(src, entry.name);
      const relPath = path.join(rel, entry.name);
      const dstPath = path.join(snapshotRoot, relPath);

      if (isSensitiveSnapshotPath(relPath)) {
        skipped.push({ path: relPath, reason: "sensitive-pattern" });
        continue;
      }
      if (isIgnoredPath(relPath, ignoredPaths)) {
        skipped.push({ path: relPath, reason: "gitignore" });
        continue;
      }

      if (entry.isSymbolicLink()) {
        // Don't follow symlinks — too easy to escape the source dir or loop forever.
        skipped.push({ path: relPath, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push({ src: srcPath, rel: relPath });
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath, reason: `non-regular (${entry.isFIFO() ? "fifo" : entry.isSocket() ? "socket" : "other"})` });
        continue;
      }

      if (copiedFiles + 1 > limits.maxFiles) {
        skipped.push({ path: relPath, reason: `file-count cap (${limits.maxFiles}) reached` });
        continue;
      }

      const result = copyRegularFileNoFollow(
        srcPath,
        dstPath,
        canonicalSourceRoot,
        limits.maxBytes - totalBytes
      );
      if (!result.copied) {
        const reason = result.reason === "size cap"
          ? `size cap (${limits.maxBytes} bytes) reached`
          : result.reason;
        skipped.push({ path: relPath, reason });
        continue;
      }
      copiedFiles += 1;
      totalBytes += result.size;
    }
  }

  return { copiedFiles, totalBytes, skipped };
}

/**
 * Create an isolated git-initialised snapshot of `sourceRoot` for review.
 *
 * Returns:
 *   {
 *     snapshotRoot,     // path to the isolated directory containing the snapshot
 *     sourceRoot,       // absolute source path (echo of input, normalised)
 *     copiedFiles,
 *     totalBytes,
 *     skipped,          // [{path, reason}]
 *     mapPathBack(p),   // rewrite a snapshot-relative or snapshot-absolute path to its source equivalent
 *     cleanup()         // best-effort rm -rf the snapshot dir
 *   }
 *
 * The snapshot is committed as a single baseline commit so subsequent review tooling can
 * `git diff` against it. We also write a `.gitignore` that excludes `.claude-review/` and
 * the snapshot's own metadata so job artifacts never get accidentally committed.
 *
 * Cross-platform:
 *   - default root: <home>/.claude-review/snapshots
 *   - callers may provide an isolated root with options.tempRoot
 *   - All path joins via path.join() so separators are platform-correct
 *   - `git init` is invoked WITH explicit cwd so it cannot land in the user's home dir
 */
export function createDirectorySnapshot(sourceRoot, options = {}) {
  const absSourceRoot = path.resolve(sourceRoot);
  if (!fs.existsSync(absSourceRoot)) {
    throw new Error(`source path does not exist: ${absSourceRoot}`);
  }
  const srcStat = fs.statSync(absSourceRoot);
  if (!srcStat.isDirectory()) {
    throw new Error(`source path is not a directory: ${absSourceRoot}`);
  }

  const tempRoot = options.tempRoot
    ? path.resolve(options.tempRoot)
    : path.join(os.homedir(), ".claude-review", "snapshots");
  const namespace = ensureSnapshotNamespace(tempRoot);
  reapStaleDirectorySnapshots(tempRoot, { namespace });

  const snapshotRoot = fs.mkdtempSync(path.join(namespace.namespaceRoot, "snapshot-"));
  const snapshotId = randomUUID();
  const populateSnapshot = () => {
  const excludes = resolveExcludes(options.excludes);
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_SNAPSHOT_MAX_FILES,
    maxBytes: options.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES
  };
  const ignoredPaths = collectGitIgnoredPaths(absSourceRoot);

  const { copiedFiles, totalBytes, skipped } = copyTree(absSourceRoot, snapshotRoot, excludes, limits, ignoredPaths);

  // Write a defensive .gitignore so review job artifacts never get committed.
  // Use a single readFileSync with try/catch instead of existsSync-then-read to
  // avoid a TOCTOU race (js/file-system-race) — the snapshot dir is freshly
  // mkdtemp'd and exclusive to us, but the pattern is still safer.
  const gitignorePath = path.join(snapshotRoot, ".gitignore");
  let existingIgnore;
  try {
    existingIgnore = fs.readFileSync(gitignorePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    existingIgnore = "";
  }
  const requiredIgnoreLines = [".claude-review/", "*.codex-snapshot.meta.json"];
  let newIgnore = existingIgnore;
  for (const line of requiredIgnoreLines) {
    if (!new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(newIgnore)) {
      newIgnore += (newIgnore.endsWith("\n") || newIgnore === "" ? "" : "\n") + line + "\n";
    }
  }
  fs.writeFileSync(gitignorePath, newIgnore, "utf8");

  // Initialise git INSIDE the snapshot dir only. The explicit cwd is the critical guard
  // that prevents the previously-reported failure where `git init` landed in the user's
  // home directory because the wrapper ignored cwd. We additionally assert that the cwd
  // we pass is inside the owned namespace we just created.
  const expectedTemp = path.resolve(snapshotRoot);
  if (!isWithinRoot(expectedTemp, namespace.namespaceRoot)) {
    throw new Error(`snapshot root ${expectedTemp} is not inside the owned snapshot namespace — refusing git init`);
  }

  runCommandChecked("git", ["init", "--quiet"], { cwd: snapshotRoot });
  runCommandChecked("git", ["config", "user.email", "codex-claude-review@local"], { cwd: snapshotRoot });
  runCommandChecked("git", ["config", "user.name", "codex-claude-review"], { cwd: snapshotRoot });
  runCommandChecked("git", ["config", "commit.gpgsign", "false"], { cwd: snapshotRoot });
  runCommandChecked("git", ["add", "--all"], { cwd: snapshotRoot });
  // Allow empty commit so the baseline always exists, even if the user pointed us at an empty dir.
  const commitResult = runCommand(
    "git",
    ["commit", "--allow-empty", "-m", "codex-claude-review baseline snapshot", "--no-gpg-sign"],
    { cwd: snapshotRoot }
  );
  if (commitResult.status !== 0) {
    throw new Error(`snapshot baseline commit failed: ${commitResult.stderr || commitResult.stdout || "unknown"}`);
  }

  // Persist metadata for later reference / cleanup.
  const metadataPath = path.join(snapshotRoot, SNAPSHOT_METADATA);
  const metadata = {
    version: SNAPSHOT_NAMESPACE_VERSION,
    ownerId: namespace.ownerId,
    snapshotId,
    pid: process.pid,
    sourceRoot: absSourceRoot,
    snapshotRoot,
    createdAt: new Date().toISOString(),
    copiedFiles,
    totalBytes,
    skipped: skipped.slice(0, 200), // cap to avoid runaway metadata
    excludes: [...excludes]
  };
  writeExclusiveJson(metadataPath, metadata);

  return {
    snapshotRoot,
    sourceRoot: absSourceRoot,
    copiedFiles,
    totalBytes,
    skipped,
    mapPathBack(input) {
      if (!input) return input;
      const normalised = String(input);
      const absSnapshot = path.resolve(snapshotRoot);
      // Absolute path under snapshot → rewrite to absolute path under source.
      const absoluteInput = path.isAbsolute(normalised) ? path.resolve(normalised) : null;
      if (absoluteInput && isWithinRoot(absoluteInput, absSnapshot)) {
        const rel = path.relative(absSnapshot, absoluteInput);
        return path.join(absSourceRoot, rel);
      }
      // Relative paths are already source-relative for the reviewer's purposes.
      return normalised;
    },
    cleanup() {
      // Best-effort cleanup; stale owned snapshots are reaped on the next run.
      try { fs.rmSync(snapshotRoot, { recursive: true, force: true }); } catch (_err) { /* stale reaper will retry */ }
    }
  };
  };

  try {
    return populateSnapshot();
  } catch (error) {
    try { fs.rmSync(snapshotRoot, { recursive: true, force: true }); } catch (_cleanupError) { /* stale reaper is the fallback */ }
    throw error;
  }
}

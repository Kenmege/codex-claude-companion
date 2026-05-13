import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

  if (DEFAULT_SECRET_BASENAMES.includes(base)) return true;
  if (base.startsWith(".env.")) return true;
  if (base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return true;
  if (DEFAULT_SECRET_DIRS.some((dir) => parts.includes(dir))) return true;
  if (/\.(pem|key|pfx|p12|kdbx)$/i.test(lowerBase)) return true;
  if (/\.(tfvars|tfvars\.json|tfstate|tfstate\.backup)$/i.test(lowerBase)) return true;
  return /(service[-_]?account|firebase-adminsdk).*\.json$/i.test(lowerBase) || /\.key\.json$/i.test(lowerBase);
}

export function reapStaleDirectorySnapshots(tempRoot, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? STALE_SNAPSHOT_MAX_AGE_MS;
  let entries;
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, skipped: 0 };
  }

  let removed = 0;
  let skipped = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("snapshot-")) continue;
    const snapshotDir = path.join(tempRoot, entry.name);
    const metadataPath = path.join(snapshotDir, ".codex-snapshot.meta.json");
    let createdAt = null;
    try {
      createdAt = JSON.parse(fs.readFileSync(metadataPath, "utf8")).createdAt;
    } catch {
      skipped += 1;
      continue;
    }
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs) || now - createdMs < maxAgeMs) {
      skipped += 1;
      continue;
    }
    try {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      removed += 1;
    } catch {
      skipped += 1;
    }
  }
  return { removed, skipped };
}

function collectGitIgnoredPaths(sourceRoot) {
  if (!isGitRepository(sourceRoot)) return new Set();
  const result = runCommand("git", ["ls-files", "--ignored", "--others", "--exclude-standard", "-z"], {
    cwd: sourceRoot,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) return new Set();
  return new Set(
    String(result.stdout ?? "")
      .split("\0")
      .filter(Boolean)
  );
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

/**
 * Walk `sourceRoot` and copy reviewable files into `snapshotRoot`, honouring excludes
 * and size/file-count caps. Returns { copiedFiles, totalBytes, skipped }.
 *
 * Cross-platform: uses Node fs APIs only, no shell. Path separators normalised through
 * path.join so it works on macOS, Linux, and Windows identically.
 */
function copyTree(sourceRoot, snapshotRoot, excludes, limits, ignoredPaths) {
  const stack = [{ src: sourceRoot, rel: "" }];
  let copiedFiles = 0;
  let totalBytes = 0;
  const skipped = [];

  while (stack.length > 0) {
    const { src, rel } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
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
        fs.mkdirSync(dstPath, { recursive: true });
        stack.push({ src: srcPath, rel: relPath });
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath, reason: `non-regular (${entry.isFIFO() ? "fifo" : entry.isSocket() ? "socket" : "other"})` });
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(srcPath);
      } catch (err) {
        skipped.push({ path: relPath, reason: `stat failed: ${err.code ?? err.message}` });
        continue;
      }

      if (copiedFiles + 1 > limits.maxFiles) {
        skipped.push({ path: relPath, reason: `file-count cap (${limits.maxFiles}) reached` });
        continue;
      }
      if (totalBytes + stat.size > limits.maxBytes) {
        skipped.push({ path: relPath, reason: `size cap (${limits.maxBytes} bytes) reached` });
        continue;
      }

      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
      copiedFiles += 1;
      totalBytes += stat.size;
    }
  }

  return { copiedFiles, totalBytes, skipped };
}

/**
 * Create an isolated git-initialised snapshot of `sourceRoot` for review.
 *
 * Returns:
 *   {
 *     snapshotRoot,     // path to the temp directory containing the snapshot
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
 *   - macOS / Linux temp root: /tmp via os.tmpdir()
 *   - Windows temp root: %TEMP% via os.tmpdir()
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

  const tempRoot = options.tempRoot ? path.resolve(options.tempRoot) : path.join(os.tmpdir(), "codex-claude-review");
  fs.mkdirSync(tempRoot, { recursive: true });
  reapStaleDirectorySnapshots(tempRoot);

  const snapshotRoot = fs.mkdtempSync(path.join(tempRoot, "snapshot-"));
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
  // we pass is inside the temp root we just created.
  const expectedTemp = path.resolve(snapshotRoot);
  if (!expectedTemp.startsWith(path.resolve(tempRoot))) {
    throw new Error(`snapshot root ${expectedTemp} is not inside temp root ${tempRoot} — refusing git init`);
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
  const metadataPath = path.join(snapshotRoot, ".codex-snapshot.meta.json");
  const metadata = {
    sourceRoot: absSourceRoot,
    snapshotRoot,
    createdAt: new Date().toISOString(),
    copiedFiles,
    totalBytes,
    skipped: skipped.slice(0, 200), // cap to avoid runaway metadata
    excludes: [...excludes]
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

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
      if (path.isAbsolute(normalised) && normalised.startsWith(absSnapshot)) {
        const rel = path.relative(absSnapshot, normalised);
        return path.join(absSourceRoot, rel);
      }
      // Relative paths are already source-relative for the reviewer's purposes.
      return normalised;
    },
    cleanup() {
      // JUSTIFIED: best-effort cleanup; OS temp cleanup is the long-term safety net
      try { fs.rmSync(snapshotRoot, { recursive: true, force: true }); } catch (_err) { /* OS will reap */ }
    }
  };
}

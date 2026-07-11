import fs from "node:fs";
import path from "node:path";

import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const DEFAULT_OPUS_INLINE_BYTES = 250_000;
const DEFAULT_LONG_CONTEXT_BYTES = 800_000;
const DEFAULT_GIT_MAX_BUFFER = 128 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_DIRECTORY_REVIEW_FILE_BYTES = 1024 * 1024;
const REVIEW_PATHSPEC = ["--", ".", ":(exclude).claude-review/**"];

function git(cwd, args, options = {}) {
  return runCommand("git", args, { maxBuffer: DEFAULT_GIT_MAX_BUFFER, cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { maxBuffer: DEFAULT_GIT_MAX_BUFFER, cwd, ...options });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function parseNullDelimitedPaths(output) {
  return String(output ?? "").split("\0").filter(Boolean);
}

function formatPath(relativePath) {
  const value = String(relativePath);
  return /^[A-Za-z0-9._/@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatPathList(paths) {
  return paths.map(formatPath).join("\n");
}

function isInternalReviewArtifact(relativePath) {
  return relativePath === ".claude-review" || relativePath.startsWith(".claude-review/");
}

function isProbablyText(buffer) {
  return !buffer.includes(0);
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() || "(none)", ""].join("\n");
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedTextFile(cwd, relativePath, maxBytes) {
  const canonicalRoot = fs.realpathSync.native(cwd);
  const fullPath = path.resolve(cwd, relativePath);
  if (!isWithinRoot(fullPath, path.resolve(cwd))) {
    return { kind: "skipped", reason: "outside workspace" };
  }

  let fd;
  try {
    fd = fs.openSync(fullPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return { kind: "skipped", reason: error?.code === "ELOOP" ? "symlink" : `unreadable: ${error.code ?? error.message}` };
  }
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(fullPath);
    const resolvedAfter = fs.realpathSync.native(fullPath);
    if (current.isSymbolicLink()) {
      return { kind: "skipped", reason: "symlink" };
    }
    if (opened.isDirectory() || current.isDirectory()) {
      return { kind: "skipped", reason: "directory" };
    }
    if (!opened.isFile() || !current.isFile()) {
      return { kind: "skipped", reason: "non-regular file" };
    }
    if (
      !sameFileIdentity(opened, current) ||
      !isWithinRoot(resolvedAfter, canonicalRoot)
    ) {
      return { kind: "skipped", reason: "file changed during secure open" };
    }
    if (opened.size > maxBytes) {
      return { kind: "skipped", reason: "size", bytes: opened.size };
    }
    const buffer = fs.readFileSync(fd);
    if (!isProbablyText(buffer)) {
      return { kind: "skipped", reason: "binary", bytes: opened.size };
    }
    const afterRead = fs.fstatSync(fd);
    if (
      !sameFileIdentity(opened, afterRead) ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs ||
      afterRead.ctimeMs !== opened.ctimeMs
    ) {
      return { kind: "skipped", reason: "file changed during read" };
    }
    return { kind: "text", text: buffer.toString("utf8").trimEnd() };
  } catch (error) {
    return { kind: "skipped", reason: `secure read failed: ${error.code ?? error.message}` };
  } finally {
    fs.closeSync(fd);
  }
}

function readUntrackedFile(cwd, relativePath) {
  const result = readBoundedTextFile(cwd, relativePath, MAX_UNTRACKED_BYTES);
  const displayPath = formatPath(relativePath);
  if (result.reason === "directory") {
    return `### ${displayPath}\n(skipped: directory)`;
  }
  if (result.reason === "size") {
    return `### ${displayPath}\n(skipped: ${result.bytes} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }
  if (result.reason === "binary") {
    return `### ${displayPath}\n(skipped: binary file)`;
  }
  if (result.kind === "skipped") {
    return `### ${displayPath}\n(skipped: ${result.reason})`;
  }
  return `### ${displayPath}\n\`\`\`\n${result.text}\n\`\`\``;
}

function readReviewFile(cwd, relativePath) {
  const result = readBoundedTextFile(cwd, relativePath, MAX_DIRECTORY_REVIEW_FILE_BYTES);
  const displayPath = formatPath(relativePath);
  if (result.reason === "directory") {
    return {
      text: `### ${displayPath}\n(skipped: directory)`,
      skipped: { path: relativePath, bytes: null, reason: "directory" }
    };
  }
  if (result.reason === "size") {
    return {
      text: `### ${displayPath}\n(skipped: ${result.bytes} bytes exceeds ${MAX_DIRECTORY_REVIEW_FILE_BYTES} byte directory-review limit)`,
      skipped: { path: relativePath, bytes: result.bytes, reason: "size" }
    };
  }
  if (result.reason === "binary") {
    return {
      text: `### ${displayPath}\n(skipped: binary file)`,
      skipped: { path: relativePath, bytes: result.bytes, reason: "binary" }
    };
  }
  if (result.kind === "skipped") {
    return {
      text: `### ${displayPath}\n(skipped: ${result.reason})`,
      skipped: { path: relativePath, bytes: null, reason: result.reason }
    };
  }
  return {
    text: `### ${displayPath}\n\`\`\`\n${result.text}\n\`\`\``,
    skipped: null
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return String(result.stdout).trim();
}

export function detectDefaultBranch(cwd) {
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const result = git(cwd, ["rev-parse", "--verify", candidate]);
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error("Unable to detect the default branch. Pass --base <ref>.");
}

export function getWorkingTreeState(cwd) {
  return {
    staged: parseNullDelimitedPaths(gitChecked(cwd, ["diff", "--cached", "--name-only", "-z"]).stdout)
      .filter((file) => !isInternalReviewArtifact(file)),
    unstaged: parseNullDelimitedPaths(gitChecked(cwd, ["diff", "--name-only", "-z"]).stdout)
      .filter((file) => !isInternalReviewArtifact(file)),
    untracked: parseNullDelimitedPaths(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout)
      .filter((file) => !isInternalReviewArtifact(file))
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);
  if (options.base) {
    return {
      mode: "branch",
      baseRef: options.base,
      label: `branch diff against ${options.base}`
    };
  }

  const scope = options.scope ?? "auto";
  if (scope === "directory") {
    return { mode: "directory", label: "directory snapshot" };
  }

  if (scope === "branch") {
    const base = detectDefaultBranch(cwd);
    return { mode: "branch", baseRef: base, label: `branch diff against ${base}` };
  }

  const state = getWorkingTreeState(cwd);
  const dirty = state.staged.length || state.unstaged.length || state.untracked.length;
  if (scope === "working-tree" || dirty) {
    return { mode: "working-tree", label: "working tree diff" };
  }

  const base = detectDefaultBranch(cwd);
  return { mode: "branch", baseRef: base, label: `branch diff against ${base}` };
}

function collectWorkingTreeContext(cwd) {
  const state = getWorkingTreeState(cwd);
  if (!state.staged.length && !state.unstaged.length && !state.untracked.length) {
    throw new Error("Nothing to review in the working tree.");
  }

  const status = String(
    gitChecked(cwd, ["status", "--short", "--untracked-files=all", ...REVIEW_PATHSPEC]).stdout
  ).trim();
  const stagedDiff = String(
    gitChecked(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff", ...REVIEW_PATHSPEC]).stdout
  );
  const unstagedDiff = String(
    gitChecked(cwd, ["diff", "--no-ext-diff", "--submodule=diff", ...REVIEW_PATHSPEC]).stdout
  );
  const untrackedFiles = state.untracked.map((file) => readUntrackedFile(cwd, file)).join("\n\n");
  const changedFiles = unique([...state.staged, ...state.unstaged, ...state.untracked]);
  const stagedStat = String(gitChecked(cwd, ["diff", "--shortstat", "--cached", ...REVIEW_PATHSPEC]).stdout).trim();
  const unstagedStat = String(gitChecked(cwd, ["diff", "--shortstat", ...REVIEW_PATHSPEC]).stdout).trim();

  return {
    summary: `Reviewing ${changedFiles.length} changed file(s) from the working tree.`,
    changedFiles,
    fullContent: [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedFiles)
    ].join("\n"),
    summaryContent: [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", formatPathList(changedFiles))
    ].join("\n")
  };
}

function collectBranchContext(cwd, baseRef) {
  const stat = String(
    gitChecked(cwd, ["diff", "--shortstat", `${baseRef}...HEAD`, ...REVIEW_PATHSPEC]).stdout
  ).trim();
  const changedFiles = unique(parseNullDelimitedPaths(
    gitChecked(cwd, ["diff", "--name-only", "-z", `${baseRef}...HEAD`, ...REVIEW_PATHSPEC]).stdout
  ));
  if (!stat && changedFiles.length === 0) {
    throw new Error(`Nothing to review between ${baseRef} and HEAD.`);
  }

  const diff = String(
    gitChecked(cwd, [
      "diff", "--no-ext-diff", "--submodule=diff", `${baseRef}...HEAD`, ...REVIEW_PATHSPEC
    ]).stdout
  );
  const commits = String(gitChecked(cwd, ["log", "--oneline", `${baseRef}..HEAD`]).stdout).trim();

  return {
    summary: `Reviewing ${changedFiles.length} changed file(s) against ${baseRef}.`,
    changedFiles,
    fullContent: [
      formatSection("Commit Range", commits),
      formatSection("Diff", diff)
    ].join("\n"),
    summaryContent: [
      formatSection("Commit Range", commits),
      formatSection("Diff Stat", stat),
      formatSection("Changed Files", formatPathList(changedFiles))
    ].join("\n")
  };
}

function collectDirectoryContext(cwd) {
  const files = unique(
    parseNullDelimitedPaths(gitChecked(cwd, ["ls-files", "-z", ...REVIEW_PATHSPEC]).stdout)
      .filter((file) => !isInternalReviewArtifact(file))
  );
  if (files.length === 0) {
    throw new Error("Nothing to review in the directory snapshot.");
  }
  const renderedFiles = files.map((file) => readReviewFile(cwd, file));
  const skipped = renderedFiles.map((file) => file.skipped).filter(Boolean);
  const skippedSummary = skipped.length
    ? skipped.map((file) => {
      const detail = file.bytes == null ? file.reason : `${file.reason}, ${file.bytes} bytes`;
      return `${formatPath(file.path)} (${detail})`;
    }).join("\n")
    : "";
  const skippedNotice = skipped.length
    ? ` ${skipped.length} file(s) were skipped; see Directory Snapshot Skipped Files.`
    : "";

  return {
    summary: `Reviewing ${files.length} file(s) from a directory snapshot.${skippedNotice}`,
    changedFiles: files,
    fullContent: [
      formatSection("Directory Snapshot Files", formatPathList(files)),
      formatSection("Directory Snapshot Content", renderedFiles.map((file) => file.text).join("\n\n")),
      skipped.length ? formatSection("Directory Snapshot Skipped Files", skippedSummary) : ""
    ].join("\n"),
    summaryContent: [
      formatSection("Directory Snapshot Files", formatPathList(files)),
      skipped.length ? formatSection("Directory Snapshot Skipped Files", skippedSummary) : ""
    ].join("\n")
  };
}

export function collectReviewContext(cwd, target) {
  if (target.mode === "working-tree") {
    return collectWorkingTreeContext(cwd);
  }
  if (target.mode === "branch") {
    return collectBranchContext(cwd, target.baseRef);
  }
  if (target.mode === "directory") {
    return collectDirectoryContext(cwd);
  }
  throw new Error(`Unsupported target mode ${target.mode}`);
}

export function chooseContextMode(reviewContext, options = {}) {
  const fullBytes = Buffer.byteLength(reviewContext.fullContent, "utf8");
  const inlineLimit = options.inlineLimit ?? DEFAULT_OPUS_INLINE_BYTES;
  const longContextLimit = options.longContextLimit ?? DEFAULT_LONG_CONTEXT_BYTES;
  const wantsLongContext = Boolean(options.longContext);

  if (wantsLongContext && fullBytes <= longContextLimit) {
    return {
      bytes: fullBytes,
      mode: "full",
      content: reviewContext.fullContent
    };
  }

  if (fullBytes <= inlineLimit) {
    return {
      bytes: fullBytes,
      mode: "full",
      content: reviewContext.fullContent
    };
  }

  return {
    bytes: fullBytes,
    mode: "summarized",
    content: reviewContext.summaryContent
  };
}

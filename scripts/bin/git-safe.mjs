#!/usr/bin/env node
// git-safe.mjs — narrow git wrapper for Claude Review agentic mode.
//
// Threat model: the Claude review agent runs with read-only intent inside
// the calling Codex workspace. The Anthropic Bash matcher is a prefix check
// (e.g. `Bash(git diff:*)` matches anything starting with `git diff`),
// which makes it trivial to escape via `git diff --no-index /etc/shadow
// /dev/null` or `git show HEAD:../../../etc/passwd`. This wrapper restricts
// git to a small subcommand allowlist and rejects:
//   - the `--no-index` flag (escapes repo boundary)
//   - absolute paths outside the workspace
//   - parent-traversal (`..`) in path arguments
//   - shell metacharacters in any argument
//   - the `-c`, `-C`, and `--exec-path` switches (config / cwd override)
//   - the `--upload-pack` / `--receive-pack` / `--git-dir` overrides
//
// It also scrubs GIT_* environment variables that let git execute an
// arbitrary external program (GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND,
// GIT_PAGER, GIT_EDITOR, ...) or redirect config / object resolution
// (GIT_CONFIG_GLOBAL, GIT_TEMPLATE_DIR, GIT_OBJECT_DIRECTORY, ...).
//
// The CLI form is:
//   node scripts/bin/git-safe.mjs <subcommand> [args...]
// stdout is the git output; stderr carries failures; exit code 0 on success.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ALLOWED_SUBCOMMANDS = new Set([
  "diff",
  "log",
  "show",
  "blame",
  "status",
  "branch",
  "rev-parse",
  "diff-tree",
  "ls-files",
  "ls-tree",
  "shortlog",
  "describe",
  "config", // read-only `--get` form, validated below
  "remote", // read-only forms only
  "tag" // read-only listing only
]);

const FORBIDDEN_FLAGS = new Set([
  "--no-index",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--upload-pack",
  "--receive-pack",
  "-c",
  "-C"
]);

const FORBIDDEN_FLAG_PREFIXES = [
  "--exec-path=",
  "--git-dir=",
  "--work-tree=",
  "--upload-pack=",
  "--receive-pack="
];

const WRITE_CAPABLE_FLAGS = new Set([
  "--output",
  "--output-indicator-new",
  "--output-indicator-old",
  "--output-indicator-context"
]);

const WRITE_CAPABLE_FLAG_PREFIXES = [
  "--output=",
  "--output-indicator-new=",
  "--output-indicator-old=",
  "--output-indicator-context="
];

// Environment variables that let git (a) execute an arbitrary external
// program, or (b) redirect config / object-store resolution outside the
// workspace. These are stripped before invoking git so a poisoned parent
// environment cannot turn a read-only review into arbitrary code execution.
const SCRUBBED_ENV_VARS = [
  // cwd / object-store / index redirection
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_REPLACE_REF_BASE",
  // executable / binary path redirection
  "GIT_EXEC_PATH",
  // config injection
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_ATTR_SYSTEM",
  // arbitrary-program execution hooks
  "GIT_TEMPLATE_DIR",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_MERGE_AUTOEDIT"
];

const SHELL_METACHAR_RE = /[;&|`$<>(){}\\\n\r\t]|\$\(/;

function fail(message, code = 2) {
  process.stderr.write(`git-safe: ${message}\n`);
  process.exit(code);
}

function isAbsoluteOutsideCwd(arg, cwd) {
  if (!path.isAbsolute(arg)) return false;
  const normalized = path.normalize(arg);
  const normalizedCwd = path.normalize(cwd) + path.sep;
  return !(normalized === path.normalize(cwd) || normalized.startsWith(normalizedCwd));
}

function looksLikePathToken(arg) {
  if (arg.startsWith("-")) return false;
  if (arg.includes("/") || arg.includes("\\")) return true;
  return false;
}

function validateArg(arg, cwd) {
  if (typeof arg !== "string") {
    fail("non-string argument rejected");
  }
  if (arg.length > 4096) {
    fail("argument exceeds 4096 byte limit");
  }
  if (SHELL_METACHAR_RE.test(arg)) {
    fail(`shell metacharacter in argument: ${JSON.stringify(arg)}`);
  }
  if (FORBIDDEN_FLAGS.has(arg)) {
    fail(`forbidden flag: ${arg}`);
  }
  for (const prefix of FORBIDDEN_FLAG_PREFIXES) {
    if (arg.startsWith(prefix)) {
      fail(`forbidden flag prefix: ${prefix}`);
    }
  }
  if (WRITE_CAPABLE_FLAGS.has(arg) || WRITE_CAPABLE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
    fail(`forbidden write-capable flag: ${arg}`);
  }
  if (looksLikePathToken(arg)) {
    if (arg.includes("..")) {
      fail(`parent-traversal path rejected: ${arg}`);
    }
    if (isAbsoluteOutsideCwd(arg, cwd)) {
      fail(`absolute path outside workspace rejected: ${arg}`);
    }
  }
}

function validateSubcommandSpecific(subcommand, args) {
  const nonFlagArgs = args.filter((arg) => !arg.startsWith("-"));
  if (subcommand === "config") {
    const hasReadOnlyFlag = args.includes("--get") || args.includes("--list") || args.includes("-l");
    const hasMutator =
      args.includes("--set") ||
      args.includes("--unset") ||
      args.includes("--add") ||
      args.includes("--replace-all") ||
      args.includes("--rename-section") ||
      args.includes("--remove-section");
    if (hasMutator || !hasReadOnlyFlag) {
      fail("git config restricted to --get / --list");
    }
  }
  if (subcommand === "branch") {
    const allowedFlags = new Set([
      "-a",
      "-r",
      "-v",
      "-vv",
      "--all",
      "--remotes",
      "--verbose",
      "--show-current",
      "--list",
      "--contains",
      "--merged",
      "--no-merged",
      "--points-at",
      "--format",
      "--sort",
      "--color",
      "--no-color",
      "--column",
      "--no-column"
    ]);
    const mutatingFlags = new Set([
      "-d",
      "-D",
      "-m",
      "-M",
      "-c",
      "-C",
      "--delete",
      "--move",
      "--copy",
      "--set-upstream-to",
      "--unset-upstream",
      "--edit-description",
      "--track",
      "--no-track",
      "--create-reflog",
      "--force"
    ]);
    if (args.some((arg) => mutatingFlags.has(arg) || arg.startsWith("--set-upstream-to="))) {
      fail("git branch restricted to read-only forms");
    }
    if (args.some((arg) => arg.startsWith("-") && !allowedFlags.has(arg) && !arg.startsWith("--format=") && !arg.startsWith("--sort=") && !arg.startsWith("--color=") && !arg.startsWith("--column="))) {
      fail("git branch restricted to read-only forms");
    }
    if (nonFlagArgs.length > 0) {
      fail("git branch restricted to read-only forms");
    }
  }
  if (subcommand === "remote") {
    const allowedFirstArgs = new Set(["show", "get-url"]);
    const hasMutator = args.some((a) => ["add", "remove", "rm", "set-url", "rename", "prune", "update", "set-branches"].includes(a));
    if (hasMutator) {
      fail("git remote restricted to read-only forms");
    }
    if (nonFlagArgs.length > 0 && !allowedFirstArgs.has(nonFlagArgs[0])) {
      fail("git remote restricted to read-only forms");
    }
  }
  if (subcommand === "tag") {
    const hasListFlag = args.some((a) => ["-l", "--list"].includes(a) || a.startsWith("--list="));
    const hasMutator = args.some((a) => ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-f", "--force", "-m", "-F"].includes(a));
    if (hasMutator) {
      fail("git tag restricted to listing");
    }
    if (nonFlagArgs.length > 0 && !hasListFlag) {
      fail("git tag restricted to listing");
    }
  }
}

function main() {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand) {
    fail("usage: git-safe <subcommand> [args...]");
  }
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    fail(`subcommand not allowed: ${subcommand}`);
  }
  if (subcommand.startsWith("-")) {
    fail("subcommand must not be a flag");
  }

  const cwd = process.cwd();
  for (const arg of rest) {
    validateArg(arg, cwd);
  }
  validateSubcommandSpecific(subcommand, rest);

  const env = { ...process.env };
  for (const key of SCRUBBED_ENV_VARS) {
    delete env[key];
  }

  const result = spawnSync("git", [subcommand, ...rest], {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });

  if (result.error) {
    fail(`git failed: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

main();

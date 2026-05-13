---
description: Diagnose codex-claude-review installation, Claude auth, Codex registration, and runtime readiness.
---

# /claude-review:doctor

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Runs the first-run diagnostic. It checks Node, Git, Claude Code CLI, Claude
auth, Codex plugin registration, writable job storage, non-Git folder support,
and prompt transport. Use `--probe-runtime` when the user wants live Claude
non-interactive model access checked as well.

## Commands

Use the exact argument tail the user supplied after `/claude-review:doctor`.

- Preferred:
  `codex-claude-review doctor <user-arguments>`

Useful flags:

- `--probe-runtime` — run the live Claude model probe.
- `--json` — emit machine-parseable diagnostics.
- `--config <path>` — inspect a non-default Codex config path.
- `--job-dir <path>` — test a non-default job storage location.

## Verification

If the helper exits non-zero, report the listed problem codes and recovery
commands exactly.

## Summary

Return the helper stdout verbatim.

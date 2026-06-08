---
description: Run an agentic Claude review (Opus alias by default) against the current git workspace.
---

# /claude-review:review

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Runs an agentic Claude pass over the current diff. Claude has read-only access
to Read, Glob, Grep, Task (sub-agents), WebFetch, WebSearch, and Bash limited
to the git-safe wrapper plus node/npm verification commands. Edits, writes,
and shell mutations are blocked.

Default model is Claude Code's `opus` alias at `xhigh` effort. The helper auto-switches
to the Opus 1M alias (`opus[1m]`) when the diff
exceeds the inline envelope.

## Commands

Use the exact argument tail the user supplied after `/claude-review:review`.

- Preferred:
  `codex-claude-review review <user-arguments>`

Useful flags:

- `--preset quick|ship|security|research|deep` — choose a role workflow.
- `--legacy` — disable agentic mode (structured output only, no tool access).
- `--model <name>` / `--effort <level>` — override profile.
- `--mcp-config <file-or-json>` — attach MCP servers (repeatable).
- `--max-budget-usd <n>` — cap review spend.
- `--add-dir <path>` — grant tool access to extra directories.
- `--quiet` / `--debug` — adjust rendered detail and job-log diagnostics.

Do not make edits or apply fixes from this command. The agent is read-only.

## Verification

If the helper exits non-zero, report that failure exactly and stop.

## Summary

Return the helper stdout verbatim.

## Next Steps

If the user wants a harsher pass, suggest `/claude-review:adversarial-review`,
`/claude-review:elite-review`, `/claude-review:deep-review`, or
`/claude-review:security-review`.

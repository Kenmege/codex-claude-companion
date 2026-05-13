---
description: Run a harder Claude challenge review against the current git workspace.
---

# /claude-review:adversarial-review

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Runs an agentic adversarial review pass. Claude (Opus 4.7 default, high
effort) gets read-only Read/Glob/Grep/Bash/Task/WebFetch/WebSearch tools so it
can verify call sites, downstream consumers, and test gaps before challenging
the design. Returns the helper output without paraphrasing it.

## Commands

Use the exact argument tail the user supplied after
`/claude-review:adversarial-review`.

- Preferred:
  `codex-claude-review adversarial-review <user-arguments>`

Useful flags:

- `--legacy` to disable agentic mode (structured-output only).
- `--mcp-config`, `--max-budget-usd`, `--add-dir`, `--system-prompt-extra` for
  workspace-specific control.

Keep this command read-only. The agent is restricted to read-only tools.

## Verification

If the helper exits non-zero, report that failure exactly and stop.

## Summary

Return the helper stdout verbatim.

## Next Steps

If the user wants a persistent record, suggest `--background` plus
`/claude-review:status`. If they want the most exhaustive lane, suggest
`/claude-review:elite-review`.

---
description: Run an elite, high-scrutiny Claude review against the current git workspace.
---

# /claude-review:elite-review

## Preflight

1. Prefer the helper binary `codex-claude` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Runs the elite adversarial review pass. Agentic by default: Claude (Opus alias,
xhigh effort) explores the workspace with Read/Glob/Grep/Task/WebFetch/
WebSearch and Bash limited to the git-safe wrapper plus node/npm verification
commands. It emits an evidence-backed structured report (verdict, ship
recommendation, systemic risks, evidence-cited findings, verified claims,
blind spots, exploration log).

Returns the helper output without paraphrasing it.

## Commands

Use the exact argument tail the user supplied after
`/claude-review:elite-review`.

- Preferred:
  `codex-claude elite-review <user-arguments>`

Useful flags:

- `--legacy` for the older structured-output-only mode.
- `--mcp-config <file-or-json>` (repeatable) to attach MCP servers.
- `--max-budget-usd <n>` to cap spend.
- `--system-prompt-extra <text>` to inject workspace-specific reviewer
  guidance.
- `--quiet` / `--debug` to adjust rendered detail and job-log diagnostics.

Keep this command read-only. Tools are constrained to read-only operations.

## Verification

If the helper exits non-zero, report that failure exactly and stop.

## Summary

Return the helper stdout verbatim.

## Next Steps

If the user wants a persistent record, suggest `--background` plus
`/claude-review:status`. For the most exhaustive multi-agent pass, suggest
`/claude-review:deep-review`. For a security-focused pass, suggest
`/claude-review:security-review`.

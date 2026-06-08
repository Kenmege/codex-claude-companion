---
description: Run a deep, multi-agent Claude review (Opus alias max effort) against the current workspace.
---

# /claude-review:deep-review

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Runs the deepest review lane: agentic by default, Opus alias at `max` effort,
with the parent reviewer authorized to dispatch up to four parallel `Task`
sub-agents for fanned-out exploration. Sub-agents inherit the same read-only
tool allowlist and contribute back into the structured report under
`evidence[].source`.

Default budget cap is $25 USD (override with `--max-budget-usd <n>`).

## Commands

Use the exact argument tail the user supplied after
`/claude-review:deep-review`.

- Preferred:
  `codex-claude-review deep-review <user-arguments>`

Useful flags:

- `--background` strongly recommended for deep reviews on large diffs.
- `--max-budget-usd <n>` adjusts the spend cap.
- `--mcp-config <file-or-json>` to attach repo-specific MCPs (e.g. Linear,
  Sentry, GitHub).
- `--add-dir <path>` to grant tool access to sibling repos.
- `--system-prompt-extra <text>` to inject workspace-specific reviewer
  guidance (e.g., codified review checklists).

Keep this command read-only. The agent and any sub-agents are restricted to
read-only tools.

## Verification

If the helper exits non-zero, report that failure exactly and stop.

## Summary

Return the helper stdout verbatim. The structured output includes verdict,
ship recommendation, systemic risks, findings (with evidence and tool-call
citations), verified claims, blind spots, exploration log, and next steps.

## Next Steps

If the user wants only the security lens, suggest
`/claude-review:security-review`. For shorter, single-agent passes, suggest
`/claude-review:elite-review` or `/claude-review:adversarial-review`.

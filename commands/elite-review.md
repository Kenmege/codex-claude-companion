---
description: Run an elite, high-scrutiny Claude review against the current git workspace.
---

# /claude-review:elite-review

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, fall back to:
   `node /Users/kenmege/codex-plugin-cc/scripts/claude-review-companion.mjs`
3. If neither is available, tell the user to install the helper with:
   `npm install -g /Users/kenmege/codex-plugin-cc`

## Plan

Run one elite adversarial review pass through the helper and return the helper
output without paraphrasing it.

## Commands

Use the exact argument tail the user supplied after
`/claude-review:elite-review`.

- Preferred:
  `codex-claude-review elite-review <user-arguments>`
- Fallback:
  `node /Users/kenmege/codex-plugin-cc/scripts/claude-review-companion.mjs elite-review <user-arguments>`

Keep this command read-only.

## Verification

If the helper exits non-zero, report that failure exactly and stop.

## Summary

Return the helper stdout verbatim.

## Next Steps

If the user wants a persistent record, suggest `--background` plus
`/claude-review:status`.

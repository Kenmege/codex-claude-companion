---
description: Run a normal Claude review against the current git workspace.
---

# /claude-review:review

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, fall back to:
   `node /Users/kenmege/codex-plugin-cc/scripts/claude-review-companion.mjs`
3. If neither is available, tell the user to install the helper with:
   `npm install -g /Users/kenmege/codex-plugin-cc`

## Plan

Run the helper once, keep the review read-only, and return its stdout directly.

## Commands

Use the exact argument tail the user supplied after `/claude-review:review`.

- Preferred:
  `codex-claude-review review <user-arguments>`
- Fallback:
  `node /Users/kenmege/codex-plugin-cc/scripts/claude-review-companion.mjs review <user-arguments>`

Do not make edits or apply fixes from this command.

## Verification

If the helper exits non-zero, report that failure exactly and stop.

## Summary

Return the helper stdout verbatim.

## Next Steps

If the user wants a harsher pass, suggest `/claude-review:adversarial-review`
or `/claude-review:elite-review`.

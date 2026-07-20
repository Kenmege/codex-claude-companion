---
description: Show the stored final output for a finished Claude review job.
---

# /claude-review:result

## Preflight

1. Prefer the helper binary `codex-claude` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-claude-companion` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Run the helper in result mode and return the stored output.

## Commands

Use the exact argument tail the user supplied after `/claude-review:result`.

- Preferred:
  `codex-claude result <user-arguments>`

## Verification

Do not substitute your own review text for missing helper output.

## Summary

Return the helper stdout verbatim.

## Next Steps

If the user wants a new pass, suggest re-running review or adversarial review.

---
description: Cancel an active background Claude review job.
---

# /claude-review:cancel

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Run the helper in cancel mode once and return the result.

## Commands

Use the exact argument tail the user supplied after `/claude-review:cancel`.

- Preferred:
  `codex-claude-review cancel <user-arguments>`

## Verification

Trust the helper's before-and-after state, not assumptions about process exit.

## Summary

Return the helper stdout verbatim.

## Next Steps

If the user still wants a review, suggest starting a fresh background job.

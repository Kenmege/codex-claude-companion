---
description: Show a durable bridge job by ccb_ ID, or running and recent Claude review jobs.
---

# /claude-review:status

## Preflight

1. Prefer the helper binary `codex-claude` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-claude-companion` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Run the helper in status mode and return the result. A `ccb_...` ID selects the
durable bridge ledger; other arguments use the legacy review-job status route.

## Commands

Use the exact argument tail the user supplied after `/claude-review:status`.

- Preferred:
  `codex-claude status <user-arguments>`

## Verification

Treat the helper output as the source of truth for job state. For bridge jobs,
worker completion, delivery, acknowledgement, and verification are distinct.

## Summary

Return the helper stdout verbatim.

## Next Steps

For a finished legacy review, suggest `/claude-review:result`. For a bridge job,
report its receipt and verification state or use `/claude-review:wait`.

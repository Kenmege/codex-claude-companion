---
description: Request cancellation of a durable bridge job by ccb_ ID, or cancel a background Claude review job.
---

# /claude-review:cancel

## Preflight

1. Prefer the helper binary `codex-claude` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Run the helper in cancel mode once and return the result. A `ccb_...` ID selects
two-phase bridge cancellation; other IDs use the legacy review-job route.

## Commands

Use the exact argument tail the user supplied after `/claude-review:cancel`.

- Preferred:
  `codex-claude cancel <user-arguments>`

## Verification

Trust the helper's before-and-after state, not assumptions about process exit.
For bridge jobs, `cancel_requested` records intent and only a later `cancelled`
event confirms that the worker stopped and its lease was released.

## Summary

Return the helper stdout verbatim.

## Next Steps

If a bridge cancellation is still pending, use `status`, `wait`, or `recover`.
Do not launch a replacement while ownership is ambiguous.

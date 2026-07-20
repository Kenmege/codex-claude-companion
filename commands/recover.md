---
description: Reconcile an interrupted Codex-Claude Bridge job against durable state and tmux identity.
---

# /claude-review:recover

Run `codex-claude recover <ccb_job-id> <user-arguments>` once and return the
reconciliation result. Recovery compares the ledger, broker heartbeat, tmux
worker identity, repository identity, result, and delivery state. Never launch a
replacement worker when recovery reports ambiguous ownership or manual action.

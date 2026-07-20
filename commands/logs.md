---
description: Read bounded, redacted logs for a durable Codex-Claude Bridge job.
---

# /claude-review:logs

Run `codex-claude logs <ccb_job-id> <user-arguments>` and return stdout. Add
`--stderr` only when requested or needed for diagnosis. Logs are local evidence,
not proof of delivery or verification; use `status` or `wait` for authoritative
state.

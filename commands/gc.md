---
description: Preview or remove expired terminal Codex-Claude Bridge jobs within hard safety bounds.
---

# /claude-review:gc

Run `codex-claude gc <user-arguments>`. This command is a dry run unless the
user explicitly supplies `--apply`. The default age is 30 days; at most 256 job
records are scanned and at most 64 expired terminal jobs can be listed or
removed per invocation. Never add `--apply` on the user's behalf. Report the
exact candidate and removed job IDs from the CLI output.

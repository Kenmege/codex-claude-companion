---
description: Wait for a durable Codex-Claude Bridge job and return its terminal receipt.
---

# /claude-review:wait

Run `codex-claude wait <ccb_job-id> <user-arguments>` and return its output.
Waiting observes durable broker state; it does not attach to or take input
control of the tmux worker. A completed worker is not successful until the
receipt also reports the required delivery and verification outcome.

Exit codes are part of the command contract: `0` means completed, independently
verified, and origin-acknowledged; `3` means a terminal failure or an unmet
verification/delivery gate; `4` means Claude has a pending question. A timeout
is an operational error and exits nonzero with its diagnostic.

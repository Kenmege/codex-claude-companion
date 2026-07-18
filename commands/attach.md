---
description: Attach the user's terminal to the tmux session for a durable bridge job.
---

# /claude-review:attach

Confirm the `ccb_...` job ID and workspace, then run
`codex-claude attach <ccb_job-id>` to print the exact tmux attachment command.
Use `codex-claude attach <ccb_job-id> --exec` only when interactive terminal
control is intended. Interactive input may compete with agent input, so do not
send keystrokes automatically; detach using the user's normal tmux controls.

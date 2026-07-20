---
description: Delegate a durable Claude coding job owned by tmux while Codex remains responsive and verifies the result independently.
---

# /claude-review:delegate

## Preflight

1. Resolve the target workspace and preserve existing user changes.
2. Choose a repository-native verification command and encode it as a JSON argv
   array, for example `["npm","test"]`.
3. Use the current Codex thread ID from `CODEX_THREAD_ID`, or pass it explicitly
   with `--thread-id`.

## Dispatch

Pass the user's request after `--`:

`codex-claude delegate --verify-command '["npm","test"]' -- "<task>"`

Use `--profile standard` unless the user explicitly authorizes another profile.
`trusted-autonomous` bypasses Claude permission prompts on a cooperative same-UID
host and is not an OS sandbox. `sandbox-autonomous` is unavailable.

## Supervision

Record the returned `ccb_...` job ID. Use `wait`, `status`, `logs`, `send`, and
`recover` against that ID. Treat worker completion, delivery, acknowledgement,
and verification as separate states; do not declare success from process exit
alone.

## Result

Return the durable receipt, verification outcome, changed files, and remaining
risks. If delivery or verification failed, report that state explicitly.
With `--wait`, exit `0` requires completed, independently verified,
origin-acknowledged work; exit `3` reports terminal non-success or a failed
verification/delivery gate; exit `4` reports a pending Claude question.

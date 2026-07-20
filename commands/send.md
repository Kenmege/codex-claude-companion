---
description: Send a correlated collaboration message to a running Codex-Claude Bridge worker.
---

# /claude-review:send

Confirm the target job and send exactly the user's intended text:

`codex-claude send <ccb_job-id> --message "<text>"`

Use `--wait` only when the caller wants to wait for acknowledgement. Messages are
ordered and deduplicated in durable state, but they can change worker behavior;
do not send secrets, credentials, or a broader authorization than the user gave.

Live same-session steering exists only until the authoritative Claude result is
observed. At that boundary the managed input stream closes so verification and
delivery can start. Without `--wait`, success means only that the message was
durably queued. With `--wait`, success requires Claude to replay-acknowledge it;
a terminal-result race can therefore leave a queued message unacknowledged.
After the job is terminal, start or resume follow-up work instead of treating
`send` as a continuation channel.

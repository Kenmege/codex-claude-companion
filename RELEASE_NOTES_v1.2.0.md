# Codex-Claude Bridge v1.2.0

## Stable release: Codex to Claude, durably

This release brings Codex-Claude Bridge by Kenmege to the stable release
channel: a durable Codex-to-Claude control plane with tmux-owned Claude
workers, typed state and message contracts, recovery, same-session steering,
origin delivery, and an independent Codex verification gate.

The active Codex task remains the Codex-supervised Claude coding workspace's
control plane. The bridge never launches a nested Codex process; its independent
verification lane is a separate ephemeral, read-only Codex process.

The project is independent and is not affiliated with or endorsed by OpenAI or
Anthropic. OpenAI's similarly named plugin runs in the opposite direction.

## Highlights

- Since the last stable release, `1.1.1`, delegate write-capable Claude jobs
  while the originating Codex task remains responsive and in control.
- Observe, steer, wait for, recover, attach to, or garbage-collect durable jobs,
  with bounded origin-supplied verification and independent read-only Codex
  review before successful delivery.
- Diagnose readiness and recover state across the ledger, tmux, Claude sessions,
  repository identity, and delivery receipts.
- Install under the canonical `codex-claude-companion` package and repository
  name. Both CLI names and the `claude-review` plugin identity remain supported.
- Since rc.1, steering messages and acknowledgements validate content and
  identity and recover interrupted writes. Verifier subprocesses use an
  environment allowlist, redact captured output, and reject unsupported passes.
- Concurrent job updates no longer overwrite each other; cancellation and
  completion publish only the first terminal outcome. Job records are replaced
  atomically, malformed records are isolated, and exact job IDs take precedence
  over prefix matches.
- Subcommand help exits before side effects. Worker heartbeats start
  immediately, and Codex thread buffering preserves subagent labels without
  adopting unrelated threads.
- Inline option values preserve embedded `=` characters, and Markdown status
  rows safely render multiline and non-string summaries.
- The test runner isolates and removes its temporary files; Windows job-record
  replacement and shell-free Git invocation improve portability.

## Install the stable release

After separately approved publication:

```bash
npm install -g codex-claude-companion@1.2.0
codex-claude enable
codex-claude doctor
codex-claude bridge-doctor --json
```

Stable publication selects npm dist-tag `latest`; prereleases select `next`.
Preparing this release does not publish it or change either registry dist-tag.

### Upgrade from rc.1

Job-state migration is automatic and one-time. The old job index is migrated
to per-job records, and jobs from older versions keep their summaries. Existing
state paths and both `codex-claude` and `codex-claude-review` commands remain
compatible. No manual job-state reset is needed.

The former `codex-plugin-cc@1.1.1` package contains review and workspace lanes
without the durable bridge. Its compatibility shim remains an inert scaffold
pending coordinated publication. The earlier scoped
`@kenmege/codex-claude-bridge` proposal is superseded; use the canonical unscoped
`codex-claude-companion` name.

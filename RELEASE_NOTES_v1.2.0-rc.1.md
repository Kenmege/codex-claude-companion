# Codex-Claude Bridge v1.2.0-rc.1

## Public release candidate: Codex to Claude, durably

This release candidate introduces Codex-Claude Bridge by Kenmege: a durable
Codex-to-Claude control plane with tmux-owned Claude workers, typed state and
message contracts, recovery, same-session steering, origin delivery, and an
independent Codex verification gate.

The active Codex task remains the Codex-supervised Claude coding workspace's
control plane. The bridge never launches a nested Codex process; its independent
verification lane is a separate ephemeral, read-only Codex process.

The project is independent and is not affiliated with or endorsed by OpenAI or
Anthropic. OpenAI's similarly named plugin runs in the opposite direction.

## Highlights

- Delegate write-capable Claude jobs while the originating Codex task remains
  responsive and in control.
- Observe, steer, wait for, recover, attach to, or garbage-collect durable jobs.
- Require bounded origin-supplied verification and independent read-only Codex
  review before successful delivery.
- Diagnose runtime readiness and recover state across the ledger, tmux, Claude
  sessions, repository identity, and delivery receipts.
- Preserve legacy review/workspace commands and compatibility identifiers during
  the staged product-name migration.
- Publish prereleases on npm dist-tag `next`, leaving stable `latest` on `1.1.1`.

## Install the release candidate

```bash
npm install -g codex-plugin-cc@next
codex-claude enable
codex-claude doctor
codex-claude bridge-doctor --json
```

The proposed `@kenmege/codex-claude-bridge` package is not part of this release.
That scoped cutover remains blocked until npm scope control and its own trusted
publisher are verified.

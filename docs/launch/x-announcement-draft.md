# X Announcement Draft

Do not post this without Kennedy approval and a verified public v1.1.0 release.

## Short Version

Codex Plugin CC v1.1.0 turns a Codex task into a split-terminal coding control
plane.

Codex stays active as planner, orchestrator, verifier, and reviewer. Claude Code
runs the coding job in the background with full native tools and approvals, and
its live agent panel opens in another terminal.

No nested Codex. No hardcoded GPT model. Read-only review lanes stay isolated.

Repo: https://github.com/Kenmege/codex-plugin-cc

## After npmjs Publish

Use this only after `npm view codex-plugin-cc version` returns `1.1.0`.

```text
npm install -g codex-plugin-cc
codex-claude enable
codex-claude doctor --probe-runtime
codex-claude workspace --path . -- "implement the feature and run the full test suite"
```

## Thread Option

1. Codex Plugin CC v1.1.0 adds the workflow I wanted: Codex orchestrating a
   full Claude Code coding session in another terminal—not just asking Claude
   for a read-only review.

2. The originating Codex task remains the control plane. It plans the work,
   launches Claude's background worker, monitors the native session, inspects
   the diff, runs the real project checks, and performs the final review.

3. Claude gets full coding capability through its native permission system.
   Its `agents` panel opens separately, so I can watch, answer prompts, attach,
   or leave it running while Codex stays responsive.

4. Model routing stays current by design: Claude defaults to its rolling
   `opus` selector and accepts `--model`; GPT-side supervision inherits the
   model selected for the active Codex task. The plugin never starts a second
   Codex process or pins a GPT model ID.

5. The original review product is still here and still fenced: ship/no-ship,
   security, deep, adversarial, and folder reviews remain isolated read-only
   lanes with evidence-cited findings.

6. The release adds lifecycle JSON events, native status/log/stop controls,
   fail-closed session receipts, private one-shot terminal launchers, bounded
   MCP snapshots, packed-install tests, and minimum-Node Windows CI.

   https://github.com/Kenmege/codex-plugin-cc

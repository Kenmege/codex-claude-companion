# Codex Plugin CC v1.1.0

## Codex-supervised Claude coding workspace

v1.1.0 adds a writable split-terminal workspace while preserving the plugin's
existing read-only review boundary.

Run:

```bash
codex-claude workspace --path . -- "implement the requested change and run tests"
```

The current Codex task remains active as planner, orchestrator, verifier, and
reviewer. Claude Code receives the coding request as a native background
session, can edit files and run tools under its permission controls, and opens
its `agents` panel in a separate terminal. The plugin never launches a nested
Codex process and never hardcodes a GPT model; GPT-side supervision inherits
the active Codex task's selected model.

Claude defaults to the rolling `opus` selector and supports `--model` overrides.
Use `--plan` for analysis-only work, `--no-panel` for focused follow-ups, and
`--panel-only` to reopen the control panel without dispatching a worker.

## Native supervision

The workspace command parses Claude Code's authoritative short session ID and
fails closed when the receipt is missing. A 30-second startup guard terminates
the dispatch process tree if Claude's native background handoff stalls. Codex
can supervise the native worker without blocking its own terminal:

```bash
codex-claude workspace-status --path . --all --json
codex-claude workspace-logs <session-id>
codex-claude workspace-stop <session-id>
```

Lifecycle events are versioned, timestamped, and privacy-safe. They report
operational state without logging prompts or MCP configuration contents.

## Release hardening

- Explicit `--` separation keeps option-looking coding and review text as data.
- MCP files are bounded, validated from their opened descriptor, and staged in
  private exclusive files before Claude starts.
- Terminal launchers use private one-shot directories and self-delete before
  opening the panel.
- Secret-path filtering is case-insensitive, Git paths are handled as
  NUL-delimited data, and repository validation supports spaces and Unicode.
- Snapshot creation fails closed if Git ignore discovery cannot complete.
- Safe reviews expose no Bash tool and load no persistent user/project/local
  Claude settings, closing repository-controlled permission and hook paths.
- Snapshot cleanup is limited to a private owned namespace and preserves
  snapshots belonging to live worker processes.
- Read-only Git calls reject external config, include, contents, exclude, and
  pathspec-file inputs; job-state locks use immutable per-contender tickets and
  safe abandoned-contender recovery under multi-process contention.
- Release version updates use atomic fsynced replacements plus a durable crash
  journal, so canonical manifests remain present and interrupted bumps recover
  on the next invocation without overwriting concurrent edits.
- Child output retention is bounded during termination, job identifiers are
  path-safe, and `--job-dir` remains authoritative through foreground,
  background, status, result, and cancel flows.
- Packed-install tests verify both `codex-claude` and the supported
  `codex-claude-review` compatibility alias.
- CI now exercises the minimum Node 18.18 runtime on Windows in addition to the
  existing supported macOS/Linux development lanes.

## Compatibility

All existing review commands remain available and read-only by default.
`codex-claude-review` remains a supported alias, so existing scripts do not need
to change immediately.

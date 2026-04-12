# Elite Claude Review Design

## Goal

Add a new explicit `elite-review` lane to the Codex-side Claude review plugin.
This lane should preserve the current `review` and `adversarial-review`
behavior while providing a much more thorough, high-level, adversarial review
mode for Codex-generated changes.

## Why A Separate Lane

The current `review` command is a practical default and `adversarial-review`
already increases skepticism, but neither should become noisier or slower by
default. A separate lane keeps the existing command contracts stable and gives
users an intentionally heavy-weight option when they want maximal scrutiny.

## Command Surface

- Add CLI command: `codex-claude-review elite-review`
- Add slash command doc: `/claude-review:elite-review`
- Keep parity with existing review flags:
  - `--background`
  - `--base`
  - `--scope`
  - `--model`
  - `--effort`
  - `--profile`
  - `--long-context`
  - free-form focus text

## Review Contract

`elite-review` should use a dedicated structured output schema instead of the
current lightweight `review-output.schema.json`.

The richer shape should include:

- `verdict`
- `ship_recommendation`
- `executive_summary`
- `systemic_risks`
- `findings`
- `blind_spots`
- `next_steps`

Each finding should include:

- `severity`
- `confidence`
- `risk_category`
- `title`
- `body`
- `failure_scenario`
- `why_vulnerable`
- `impact`
- `file`
- `line_start`
- `line_end`
- `recommendation`
- `test_gap`

## Prompting Strategy

`elite-review` should be more adversarial than the current adversarial lane and
explicitly operate at two levels:

- high-level software design and architecture scrutiny
- low-level code and failure-mode scrutiny

The prompt should force the model to:

- assume the change should not ship until proven safe
- challenge architecture, invariants, rollback safety, recovery, telemetry,
  concurrency, compatibility, and trust boundaries
- prefer a few highly defensible findings over broad but shallow commentary
- stay grounded in the provided repo context

## Rendering

The current renderer assumes the simple schema. `elite-review` should use a
separate renderer path that surfaces:

- executive ship/no-ship framing
- systemic risks
- richer per-finding fields
- blind spots and verification gaps

Status and cancel rendering can stay shared. Result rendering should branch by
job kind.

## Job And State Handling

The existing background job model is already generic enough to support a new
kind. `elite-review` should be stored as another job kind and rendered
correctly in:

- foreground output
- background `status`
- persisted `result`

## Context Collection Fix

The live verification showed a real bug: background reviews include
`.claude-review/jobs/*` in the next working-tree review. The git context
collector should exclude `.claude-review/` so the plugin never reviews its own
artifacts.

## Testing

Add or update tests for:

- elite command dispatch and usage text
- elite schema parsing
- elite result rendering
- elite background job/result persistence
- `.claude-review/` exclusion in working-tree review context

## Non-Goals

- Do not change the existing `review` schema
- Do not silently make `adversarial-review` equivalent to `elite-review`
- Do not add external dependencies

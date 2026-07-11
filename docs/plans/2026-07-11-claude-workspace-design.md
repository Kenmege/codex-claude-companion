# Claude Workspace Design

**Status:** Approved on 2026-07-11

## Goal

Extend the plugin beyond read-only reviews by adding a split-terminal Claude coding workspace supervised by Codex. The originating Codex session remains active while Claude runs as a background coding worker under Claude's native supervisor. A separate terminal opens Claude's `agents` control panel for live inspection, replies, attachment, model controls, and permission prompts. The active Codex model plans, dispatches, monitors, verifies, and reviews the resulting work.

## Product boundary

The existing review commands remain read-only and retain their current tool fences. Coding is a separate command and policy boundary:

- `workspace`: dispatch a Claude background worker and open its control panel in another terminal.
- `workspace --plan`: dispatch analysis-only work with the same split-terminal control plane.
- `/claude-review:workspace`: keep the active Codex session in control while it dispatches, polls, verifies, reviews, and requests repairs.
- Existing `review`, `elite-review`, `deep-review`, and `security-review`: unchanged.

The plugin does not claim access to every published model. It accepts a rolling alias or explicit model selector and lets the installed Claude CLI and the user's provider/account determine availability.

## User experience

```text
codex-claude workspace -- "initial coding request"
codex-claude workspace --model sonnet -- "initial coding request"
codex-claude workspace --plan -- "analysis request"
codex-claude workspace --path <directory> -- "initial coding request"
codex-claude workspace --panel-only
codex-claude workspace --no-panel -- "follow-up coding request"
codex-claude workspace-status --path <directory> --json
codex-claude workspace-logs <session-id>
codex-claude workspace-stop <session-id>
```

The default invocation dispatches the supplied task with Claude's background-agent mode and opens `claude agents --cwd <directory>` in another terminal. The helper returns Claude's authoritative session identifier immediately, leaving the originating Codex session free to orchestrate. `--panel-only` opens the control panel without dispatching a worker, and `--no-panel` supports repair dispatches without opening duplicate windows.

## Architecture

Add a small `scripts/lib/workspace.mjs` module rather than placing subprocess construction in the existing command dispatcher. It owns:

1. strict option parsing and validation;
2. resolution of the target directory inside the requested workspace;
3. construction of Claude background-worker and agent-panel argument arrays;
4. generation of a minimal, permission-restricted terminal launcher;
5. macOS Terminal, existing-tmux, and Linux terminal adapters;
6. injected process and terminal functions for deterministic tests;
7. bounded dispatch, panel, status, logs, and stop receipts.

The main CLI only parses `workspace` arguments, calls the module, and renders actionable errors. The primary `codex-claude` binary and the fully supported `codex-claude-review` compatibility alias point to the same entry point.

The Codex slash command is the preferred orchestration surface. It runs inside the user's active Codex session, so the already-selected Codex model remains the supervisor. It records the pre-work tree state, dispatches a Claude background worker, receives its session identifier, polls the machine-readable agent roster, inspects worker logs only when needed, and keeps the Codex conversation responsive. When Claude is ready, Codex inspects the diff, runs the repository's verification entry point, reviews the changes, and can dispatch focused repair workers with `--no-panel`.

The workspace lane never launches a nested Codex process. In a plugin command, orchestration inherently uses the active Codex session model. Standalone users can open Claude's control panel, but GPT-side orchestration requires starting the command from Codex.

## Model policy

- Claude default: rolling `opus` alias.
- Claude override: `--model <selector>` passed as one argument to the native CLI.
- Claude in-session switching: native `/model` picker.
- Codex supervisor in a plugin command: inherit the active Codex session model.
- Nested Codex model invocation: none; the workspace deliberately stays in the active Codex task.
- No pinned dated model identifier in source or configuration.
- The plugin reports an unavailable selector as a Claude CLI error instead of silently falling back.

This keeps provider routing and user selection authoritative. OpenAI's model catalog can evolve independently of the plugin; the workspace inherits the active Codex task's selection and does not encode a model ranking or identifier.

## Permission policy

| Mode | Claude permission mode | Intended use |
|---|---|---|
| `workspace` | `default` | Coding with native approval prompts |
| `workspace --plan` | `plan` | Read/analysis without edits |

The plugin manifest advertises write capability because the workspace is a genuine coding surface. The plugin will not expose or synthesize a bypass-permissions option. Review commands keep their existing read-only fences. The workspace launcher does not add allowed-tool overrides because native permission prompts are the control surface.

## Data flow

1. Codex invokes the plugin command and records the worktree baseline.
2. The plugin validates flags and resolves the target directory.
3. With a task, it dispatches `claude --bg` with the selected model and native permission mode.
4. It parses the authoritative session identifier from Claude's background-dispatch receipt and fails closed if that receipt is absent.
5. It opens `claude agents --cwd <directory>` in a separate terminal unless `--no-panel` was supplied.
6. It emits the session identifier and returns control to Codex immediately.
7. Codex polls `workspace-status`, optionally checks bounded logs, and remains available to the user.
8. The user can use the separate control panel to inspect, reply, attach, switch models, and approve tools.
9. When the worker is ready, Codex reviews the worktree and runs project verification.
10. Codex fixes directly or dispatches a focused follow-up worker, then repeats the review gate.

No prompt text, file contents, credentials, or session transcript is copied into plugin event records or terminal launcher files. Claude retains its own native session data as documented by its CLI.

## Observability

The first release emits privacy-safe dispatch, panel-open, and error receipts to stderr. Stable fields are command, phase, mode, Claude model selector, Codex routing policy (`active-session`), directory, session identifier, terminal backend, duration, and exit code. Prompts and tool arguments are excluded. `--json-events` emits the same bounded objects as JSON Lines for local collection, while `workspace-status --json` exposes Claude's native machine-readable status. A future OTLP adapter can consume the lifecycle schema, but remote exporting is outside this initial change.

## Error handling

- Missing Claude executable: fail before launch with setup guidance.
- Invalid or missing option value: exit with usage status.
- Invalid directory: fail before launch.
- Missing prompt with `--no-panel`: fail because neither worker nor control surface would be created.
- `--panel-only` combined with a prompt: fail as ambiguous.
- Background dispatch failure: do not open the panel; propagate the failure.
- Unsupported terminal environment: keep the worker running, return its session identifier, and print the manual `claude agents --cwd` recovery command.

## Tests

Unit tests cover argument construction, authoritative session-receipt parsing, default model selection, explicit selectors, plan mode, panel-only/no-panel validation, directory validation, prompt preservation as one argument, terminal backend selection, nonblocking dispatch, and privacy-safe receipts. CLI tests cover help text and usage failures. Injected process adapters verify orchestration without provider spend or opening a real terminal. The full repository check and package dry-run remain release gates.

## Non-goals

- Replacing Claude's terminal UI.
- Discovering or ranking provider-specific model inventories.
- Automatically bypassing permissions.
- Recursively launching a second interactive Codex TUI from an active Codex session.
- Changing the safety behavior of review commands.

## Current-source basis

Anthropic's current CLI reference documents background dispatch, agent view, session attachment, model selection, and permission controls: <https://code.claude.com/docs/en/cli-usage>.

Anthropic's agent-view guide documents the separate supervisor process, machine-readable roster, control panel, replies, attachment, logs, and stop operations used by this design: <https://code.claude.com/docs/en/agent-view>.

OpenAI's current model catalog is provider-owned and can change independently of this plugin: <https://developers.openai.com/api/docs/models/all>. The plugin therefore inherits the active Codex task's model selection instead of pinning an identifier.

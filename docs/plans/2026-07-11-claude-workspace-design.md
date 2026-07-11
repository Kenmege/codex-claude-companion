# Claude Workspace Design

**Status:** Approved on 2026-07-11

## Goal

Extend the plugin beyond read-only reviews by adding a terminal-native Claude coding workspace supervised by Codex. The workspace launches the installed Claude CLI in the selected project, defaults to the rolling `opus` model alias, and lets the user use Claude's native model picker during the session. Claude can edit files, run commands, execute tests, and iterate on failures under its normal permission prompts. The active Codex model plans, supervises, verifies, and reviews the resulting work.

## Product boundary

The existing review commands remain read-only and retain their current tool fences. Coding is a separate command and policy boundary:

- `workspace`: interactive coding in the current terminal.
- `workspace --plan`: analysis-only interactive work.
- `/claude-review:workspace`: Codex-supervised coding followed by verification and review in the same Codex session.
- Existing `review`, `elite-review`, `deep-review`, and `security-review`: unchanged.

The plugin does not claim access to every published model. It accepts a rolling alias or explicit model selector and lets the installed Claude CLI and the user's provider/account determine availability.

## User experience

```text
codex-claude-review workspace
codex-claude-review workspace --model sonnet
codex-claude-review workspace --plan
codex-claude-review workspace --continue
codex-claude-review workspace --resume <session-id>
codex-claude-review workspace --path <directory> "initial coding request"
codex-claude workspace --codex-review
```

The default invocation is equivalent in intent to launching Claude interactively with the current rolling `opus` alias and standard permission prompts. The terminal is inherited directly so colors, keyboard input, permission prompts, slash commands, and the native `/model` control panel continue to work.

## Architecture

Add a small `scripts/lib/workspace.mjs` module rather than placing subprocess construction in the existing command dispatcher. It owns:

1. strict option parsing and validation;
2. resolution of the target directory inside the requested workspace;
3. construction of a safe argument array without a shell;
4. an injected spawn function for deterministic tests;
5. propagation of signals and the child exit status.

The main CLI only parses `workspace` arguments, calls the module, and renders actionable errors. A second binary alias, `codex-claude`, points to the same entry point without removing `codex-claude-review`.

The Codex slash command is the preferred orchestration surface. It runs inside the user's active Codex session, so the already-selected Codex model remains the supervisor. It records the pre-work tree state, launches the Claude workspace, inspects the post-work diff, runs the repository's verification entry point, reviews the changes, and can request or apply follow-up corrections when authorized.

For standalone terminal use, `workspace --codex-review` invokes `codex review --uncommitted` after Claude exits successfully. By default it supplies no `--model` or model config override, allowing Codex to inherit the user's configured best/default model. `--codex-model <selector>` is an explicit opt-in override.

## Model policy

- Claude default: rolling `opus` alias.
- Claude override: `--model <selector>` passed as one argument to the native CLI.
- Claude in-session switching: native `/model` picker.
- Codex supervisor in a plugin command: inherit the active Codex session model.
- Codex supervisor in standalone mode: omit a model override and inherit Codex configuration/provider routing.
- Codex override: `--codex-model <selector>` passed only when explicitly supplied.
- No pinned dated model identifier in source or configuration.
- The plugin reports an unavailable selector as a Claude CLI error instead of silently falling back.

This makes both defaults follow their provider's current routing while keeping the user in control. As of the design date, OpenAI documents GPT-5.6 Sol as its frontier model and the `gpt-5.6` alias as routing to Sol, but the plugin does not hardcode that fact into the default execution path.

## Permission policy

| Mode | Claude permission mode | Intended use |
|---|---|---|
| `workspace` | `default` | Coding with native approval prompts |
| `workspace --plan` | `plan` | Read/analysis without edits |

The plugin manifest advertises write capability because the workspace is a genuine coding surface. The plugin will not expose or synthesize a bypass-permissions option. Review commands keep their existing read-only fences. The workspace launcher does not add allowed-tool overrides because native permission prompts are the control surface.

## Data flow

1. Codex invokes the plugin command.
2. The plugin validates mutually exclusive flags and resolves the working directory.
3. It checks that the Claude executable is available.
4. It prints a short launch receipt containing mode, model selector, and directory.
5. It spawns the Claude CLI with an argument array and inherited stdio.
6. Claude owns the interactive session and permission prompts.
7. Claude returns control to the plugin or active Codex session.
8. When supervision is enabled, Codex reviews the uncommitted changes using the inherited model and repository verification evidence.
9. The plugin returns the final relevant exit status.

No prompt text, file contents, terminal stream, credentials, or session transcript is persisted by the launcher.

## Observability

The first release emits privacy-safe launch, exit, and optional Codex-review receipts to stderr. Stable fields are command, phase, mode, model routing policy (`inherited` or `explicit`), Claude model selector, directory, start time, duration, signal, and exit code. Prompts and tool arguments are excluded. `--json-events` emits the same bounded event objects as JSON Lines to stderr for local collection. A future OTLP adapter can consume this schema, but remote exporting is outside this initial change.

## Error handling

- Missing Claude executable: fail before launch with setup guidance.
- Invalid or missing option value: exit with usage status.
- Invalid directory: fail before launch.
- Conflicting `--continue` and `--resume`: fail before launch.
- Child signal or non-zero exit: propagate the resulting status.
- Interactive terminal unavailable: fail with a message explaining that `workspace` requires a TTY.

## Tests

Unit tests cover argument construction, default model selection, explicit selectors, plan mode, resume/continue exclusivity, directory validation, and prompt preservation as one argument. CLI tests cover help text and usage failures. A fake Claude executable verifies inherited launch behavior without provider spend. The full repository check and package dry-run remain release gates.

## Non-goals

- Replacing Claude's terminal UI.
- Discovering or ranking provider-specific model inventories.
- Automatically bypassing permissions.
- Background autonomous coding jobs in this first increment.
- Recursively launching a second interactive Codex TUI from an active Codex session.
- Changing the safety behavior of review commands.

## Current-source basis

Anthropic's current CLI reference documents interactive launch, the rolling `opus` and `sonnet` model aliases, the native model selector, plan permission mode, and continue/resume controls: <https://docs.anthropic.com/en/docs/claude-code/cli-usage>.

OpenAI's current model reference documents GPT-5.6 Sol as the frontier GPT-5.6 model and says the `gpt-5.6` alias routes to Sol: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>. OpenAI's release notes document GPT-5.6 availability in Codex and current `max`/`ultra` orchestration options: <https://openai.com/index/gpt-5-6/>.

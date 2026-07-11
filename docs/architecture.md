# Architecture

## Split-Terminal Coding Workspace

```text
active Codex task (planner/orchestrator/reviewer)
  -> codex-claude workspace -- "coding request"
  -> claude --model <selector> --permission-mode <mode> --bg "coding request"
  -> Claude background supervisor
  -> separate terminal: claude agents --cwd <workspace>

active Codex task
  -> workspace-status / workspace-logs / workspace-stop
  -> inspect diff -> run project checks -> review -> focused repair
```

The dispatch returns immediately, and the helper parses the authoritative short
session ID printed by Claude Code. It fails closed instead of inventing an ID
when that receipt is absent. The current Codex task stays responsive and is the
only GPT-side process; model routing therefore inherits the active Codex
selection without a hardcoded ID or nested `codex` invocation. Claude's normal
workspace lane uses native coding permissions and approval prompts. The
separate review pipeline below retains its read-only tool fences.

## Data Flow

```text
Codex slash command
  -> codex-claude
  -> prepareSnapshot
  -> buildReviewInvocation
  -> claude -p --output-format stream-json
  -> parseClaudeStructuredOutput
  -> validateStructuredReviewOutput
  -> renderReviewResult
  -> .claude-review/jobs/*.job.json
```

## Trust Boundary

```text
trusted helper code
  |
  | builds prompts and tool fences
  v
Claude Code process
  |
  | receives untrusted review material only inside tags
  v
<untrusted_diff>...</untrusted_diff>
<untrusted_focus>...</untrusted_focus>
<workspace_guidance>...</workspace_guidance>
```

The helper treats diff text, user focus text, and workspace guidance as untrusted data. Claude is instructed to treat prompt-injection attempts inside those blocks as review material, not operating instructions.

## Core Modules

- `scripts/claude-review-companion.mjs`: CLI router, setup checks, snapshot creation, background job lifecycle, input validation.
- `scripts/lib/git.mjs`: git status/diff collection and context-size selection.
- `scripts/lib/claude.mjs`: Claude command construction, tool fences, prompts, stream parsing, structured-output validation.
- `scripts/lib/process.mjs`: child-process capture with timeout and interrupt handling.
- `scripts/lib/state.mjs`: versioned job records, atomic writes, exclusive job creation, logs.
- `scripts/lib/render.mjs`: setup/status/review output rendering.
- `scripts/lib/workspace.mjs`: Claude background dispatch, terminal adapter
  selection, privacy-safe lifecycle events, and native agent controls.
- `scripts/lib/mcp-config.mjs`: bounded descriptor reads, JSON validation, and
  private immutable-by-path staging for caller-supplied MCP configuration.
- `scripts/bin/git-safe.mjs`: read-only git wrapper used by the Claude Bash allowlist.

## Claude Invocation

`buildReviewInvocation` constructs one `claude -p` call per review. Safe-mode agentic lanes pass:

- `--tools Read Glob Grep Bash Task WebFetch WebSearch`
- `--allowedTools` with native tools, the git-safe wrapper, node/npm verification commands, and WebFetch domain rules
- `--disallowedTools Edit Write NotebookEdit`
- `--permission-mode default` unless the user explicitly selects `plan`
- `--strict-mcp-config` unless `--inherit-mcp` is explicit

Claude Code 2.1.183 improved auto-mode safety for destructive git and infra commands, but this plugin still does not opt into auto mode: reviews are read-only by product design, so `--permission-mode auto` remains rejected rather than delegated to Claude Code's classifier. Source: Anthropic Claude Code changelog, accessed 2026-06-19: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

Legacy mode passes `--tools ""` and `--disable-slash-commands`.

## Background Jobs

Workspace lifecycle events have `schemaVersion: 1`, an ISO-8601 timestamp,
phase, mode, model selector, active-session Codex routing, workspace path, and
only the operational fields relevant to that phase. Prompts and MCP contents
are never emitted. JSON events are available with `--json-events` for local
observability without creating a telemetry or data-exfiltration surface.

Claude Code owns workspace session persistence through its per-user background
supervisor. The plugin uses the native `claude agents`, `claude logs`, and
`claude stop` controls rather than maintaining a second session database.

## Review Jobs

Background jobs write:

- `<job>.job.json`: versioned job state and final result metadata
- `<job>.input.json`: the immutable review snapshot
- `<job>.log`: timestamped progress lines with job id and level

Job records use `schemaVersion: 1`. New jobs are created with exclusive file creation, and updates use atomic rename writes to avoid partial JSON files. `status` marks stale `running` jobs as `stalled` once their timeout window has elapsed.

## MCP And Subagents

The default MCP stance is strict: project/local MCPs are not inherited unless
the user passes `--inherit-mcp`. Custom `--mcp-config` values are read through
one opened descriptor with a one-MiB hard limit, parsed and validated, then
copied into private `0700` temporary directories as exclusive `0600` files.
Claude receives only those staged paths. The staged roots are removed after a
foreground review or by the detached job after a background review, so later
source-path replacement cannot change the configuration Claude consumes.

When `--inherit-mcp` is enabled, the Task subagents launched by Claude can also see project/local MCP-derived tools through the parent tool surface unless the subagent declares a narrower tool list. That is a second-order trust expansion: the main Claude process may stay read-only, but delegated Task investigations inherit more workspace-connected capabilities than strict mode would expose. This is why the helper keeps strict MCP inheritance off by default and treats `--inherit-mcp` as an explicit trust-boundary expansion. Source: Anthropic Claude Code subagents documentation, accessed 2026-05-07: https://docs.anthropic.com/en/docs/claude-code/sub-agents

Additional directories become readable under Claude Code permission rules, so `--add-dir` is validated before launch. Source: Anthropic Claude Code identity and access management documentation, accessed 2026-05-07: https://docs.anthropic.com/en/docs/claude-code/team

## Supported Platforms

Supported and tested development platforms are macOS and Linux with Node.js 18.18 or newer. Windows is not a supported v1 platform because process-tree termination and shell/tool semantics have not been verified there.

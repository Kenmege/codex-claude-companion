# Architecture

## Data Flow

```text
Codex slash command
  -> codex-claude-review
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
- `scripts/bin/git-safe.mjs`: read-only git wrapper used by the Claude Bash allowlist.

## Claude Invocation

`buildReviewInvocation` constructs one `claude -p` call per review. Safe-mode agentic lanes pass:

- `--tools Read Glob Grep Bash Task WebFetch WebSearch`
- `--allowedTools` with native tools, the git-safe wrapper, node/npm verification commands, and WebFetch domain rules
- `--disallowedTools Edit Write NotebookEdit`
- `--permission-mode default` unless the user explicitly selects `plan`
- `--strict-mcp-config` unless `--inherit-mcp` is explicit

Legacy mode passes `--tools ""` and `--disable-slash-commands`.

## Background Jobs

Background jobs write:

- `<job>.job.json`: versioned job state and final result metadata
- `<job>.input.json`: the immutable review snapshot
- `<job>.log`: timestamped progress lines with job id and level

Job records use `schemaVersion: 1`. New jobs are created with exclusive file creation, and updates use atomic rename writes to avoid partial JSON files. `status` marks stale `running` jobs as `stalled` once their timeout window has elapsed.

## MCP And Subagents

The default MCP stance is strict: project/local MCPs are not inherited unless the user passes `--inherit-mcp`. Custom `--mcp-config` values are parsed and validated before Claude starts.

When `--inherit-mcp` is enabled, the Task subagents launched by Claude can also see project/local MCP-derived tools through the parent tool surface unless the subagent declares a narrower tool list. That is a second-order trust expansion: the main Claude process may stay read-only, but delegated Task investigations inherit more workspace-connected capabilities than strict mode would expose. This is why the helper keeps strict MCP inheritance off by default and treats `--inherit-mcp` as an explicit trust-boundary expansion. Source: Anthropic Claude Code subagents documentation, accessed 2026-05-07: https://docs.anthropic.com/en/docs/claude-code/sub-agents

Additional directories become readable under Claude Code permission rules, so `--add-dir` is validated before launch. Source: Anthropic Claude Code identity and access management documentation, accessed 2026-05-07: https://docs.anthropic.com/en/docs/claude-code/team

## Supported Platforms

Supported and tested development platforms are macOS and Linux with Node.js 18.18 or newer. Windows is not a supported v1 platform because process-tree termination and shell/tool semantics have not been verified there.

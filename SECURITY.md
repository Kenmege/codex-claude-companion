# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| >= 1.0.3 < 2.0.0 | Yes |
| < 1.0.3 | No |

## Threat Model

Claude Workspace & Review has two deliberately different trust surfaces. The
workspace command dispatches Claude Code as a writable coding worker supervised
by the active Codex task. The review commands inspect untrusted diffs through
separate read-only fences. The primary risks are unintended workspace mutation,
command execution escape, path traversal, prompt injection from review material,
accidental MCP/tool expansion, secret leakage through prompts or process
observability, and long-running background workers leaving stale state.

### Writable workspace lane

`codex-claude workspace` is a full coding lane, not a sandbox or read-only
review. It starts Claude with its native `default` permission mode so Claude can
request approval to edit files and run tools. `--plan` selects Claude's
analysis-only plan mode. The plugin does not pass `--dangerously-skip-permissions`
or start a nested Codex process.

- Run it only in a workspace you trust Claude to inspect and potentially modify.
- The coding request is passed to the local Claude CLI and may be visible to
  same-user process inspection while the dispatch command is starting. Do not
  place secrets, credentials, patient data, or proprietary payloads in it.
- Lifecycle events contain model selector, mode, directory, session ID, terminal
  backend, duration, and exit status; they intentionally omit prompt and tool
  contents.
- The separate terminal is a view over Claude's native background-agent
  supervisor. Closing the panel does not prove the worker stopped. Use
  `workspace-status`, `workspace-logs`, and `workspace-stop` to inspect or stop
  the recorded session.
- The panel launcher is stored in the user's temporary directory with mode 0700
  and contains the workspace path and control-panel command, but not the coding
  request.
- Persistent review jobs use the workspace or per-user `.claude-review/jobs/`
  directory and never silently fall back to a shared OS temporary path.
- Directory snapshots default to the private per-user
  `~/.claude-review/snapshots/` ownership namespace; custom roots are accepted
  only through the explicit `--snapshot-temp-root` option.

The active Codex task remains the GPT-side orchestrator and reviewer. The plugin
does not select or persist a second GPT model; model identity and authorization
come from the active Codex task.

### Read-only review lanes

The default review lanes are read-only:

- `Edit`, `Write`, and `NotebookEdit` are denied.
- Bash is absent from the safe review tool catalog and permission rules.
- Persistent user, project, and local Claude settings are excluded in safe
  mode, so repository-controlled settings cannot restore shell permissions or
  hooks.
- Review text is wrapped as untrusted data.
- Project/local MCPs are not inherited unless `--inherit-mcp` is explicit.
- Extra directories and MCP config files are validated before Claude starts.

`--inherit-mcp` also expands trust indirectly through Task subagents: Anthropic documents that subagents can inherit the parent tool surface when they do not define their own tools, so project/local MCP-derived tools can become available to delegated investigations as well as the parent Claude process. Treat `--inherit-mcp` as a workspace-trust opt-in, not just a convenience flag. Source: Anthropic Claude Code subagents documentation, accessed 2026-05-07: https://docs.anthropic.com/en/docs/claude-code/sub-agents

`--add-dir` resolves symlinks before grant and defaults to the parent of the workspace root as its allowed boundary. Set `CODEX_CLAUDE_ADD_DIR_BOUNDARY` to a narrower absolute path when you want to prevent sibling-project access, or to a broader trusted monorepo root when symlinked workspaces need it.

`--unrestricted` disables the safe-mode fence and should only be used on trusted local diffs.

## Reporting

Report vulnerabilities through GitHub Security Advisories:
https://github.com/Kenmege/codex-plugin-cc/security/advisories/new

Do not open a public issue containing exploit details, tokens, patient data, or workspace paths.

Please include:

- A minimal reproduction.
- The command used.
- The affected version.
- Whether `--unrestricted`, `--inherit-mcp`, `--add-dir`, or custom MCP config was involved.

## Secrets And Logs

Do not paste API keys, OAuth tokens, private MCP credentials, patient data, or proprietary customer data into prompts, review focus text, MCP JSON, issue reports, or job logs. Job records under `.claude-review/jobs/` are local workspace artifacts and should not be committed.

Review job identifiers are restricted to 1–128 ASCII letters, digits,
underscores, and hyphens before any artifact path is resolved. Use
`--job-dir <path>` or `CODEX_CLAUDE_REVIEW_JOB_DIR` when job artifacts must be
kept outside the workspace; the selected directory applies to foreground and
detached execution as well as status, result, and cancel commands.

`codex-claude-review setup --json` redacts local auth identity before printing
machine-readable readiness output. Still review setup output before sharing it
outside a trusted private channel because it can include local runtime state
such as auth method, API provider, subscription type, model defaults, and
failure details.

GitHub Packages npm installs from a developer machine require a personal access
token (classic); fine-grained tokens are not supported for this registry path
as of 2026-05-07. Prefer a single-purpose token with the minimum package scope
needed, such as `read:packages` for installation, and store it only in the
consumer's user-level npm configuration. Never commit token-bearing npm config.

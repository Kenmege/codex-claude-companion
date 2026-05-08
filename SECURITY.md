# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| >= 1.0.3 < 2.0.0 | Yes |
| < 1.0.3 | No |

## Threat Model

Claude Review runs Claude Code from a Codex session to inspect untrusted diffs. The primary risks are command execution escape, path traversal, prompt injection from review material, accidental MCP/tool expansion, secret leakage in logs, and long-running background jobs leaving stale state.

The default review lanes are read-only:

- `Edit`, `Write`, and `NotebookEdit` are denied.
- Bash is limited to `scripts/bin/git-safe.mjs` plus node/npm verification commands.
- Review text is wrapped as untrusted data.
- Project/local MCPs are not inherited unless `--inherit-mcp` is explicit.
- Extra directories and MCP config files are validated before Claude starts.

`--inherit-mcp` also expands trust indirectly through Task subagents: Anthropic documents that subagents can inherit the parent tool surface when they do not define their own tools, so project/local MCP-derived tools can become available to delegated investigations as well as the parent Claude process. Treat `--inherit-mcp` as a workspace-trust opt-in, not just a convenience flag. Source: Anthropic Claude Code subagents documentation, accessed 2026-05-07: https://docs.anthropic.com/en/docs/claude-code/sub-agents

`--add-dir` resolves symlinks before grant and defaults to the parent of the workspace root as its allowed boundary. Set `CODEX_CLAUDE_ADD_DIR_BOUNDARY` to a narrower absolute path when you want to prevent sibling-project access, or to a broader trusted monorepo root when symlinked workspaces need it.

`--unrestricted` disables the safe-mode fence and should only be used on trusted local diffs.

## Reporting

Report vulnerabilities privately to Kennedy Umege through the private repository owner channel. Do not open a public issue containing exploit details, tokens, patient data, or workspace paths.

Please include:

- A minimal reproduction.
- The command used.
- The affected version.
- Whether `--unrestricted`, `--inherit-mcp`, `--add-dir`, or custom MCP config was involved.

## Secrets And Logs

Do not paste API keys, OAuth tokens, private MCP credentials, patient data, or proprietary customer data into prompts, review focus text, MCP JSON, issue reports, or job logs. Job records under `.claude-review/jobs/` are local workspace artifacts and should not be committed.

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

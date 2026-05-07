# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| < 1.0.0 | No |

## Threat Model

Claude Review runs Claude Code from a Codex session to inspect untrusted diffs. The primary risks are command execution escape, path traversal, prompt injection from review material, accidental MCP/tool expansion, secret leakage in logs, and long-running background jobs leaving stale state.

The default review lanes are read-only:

- `Edit`, `Write`, and `NotebookEdit` are denied.
- Bash is limited to `scripts/bin/git-safe.mjs` plus node/npm verification commands.
- Review text is wrapped as untrusted data.
- Project/local MCPs are not inherited unless `--inherit-mcp` is explicit.
- Extra directories and MCP config files are validated before Claude starts.

`--inherit-mcp` also expands trust indirectly through Task subagents: Anthropic documents that subagents can inherit the parent tool surface when they do not define their own tools, so project/local MCP-derived tools can become available to delegated investigations as well as the parent Claude process. Treat `--inherit-mcp` as a workspace-trust opt-in, not just a convenience flag. Source: Anthropic Claude Code subagents documentation, accessed 2026-05-07: https://docs.anthropic.com/en/docs/claude-code/sub-agents

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

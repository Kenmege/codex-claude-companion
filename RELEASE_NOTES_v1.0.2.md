# v1.0.2 Release Notes

`codex-plugin-cc` v1.0.2 turns Claude into a read-only adversarial reviewer for
Codex CLI workspaces. It gives Codex users five Claude review lanes, fenced
workspace investigation tools, schema-enforced evidence, and release controls
intended for high-scrutiny code review rather than casual lint commentary.

## Highlights

- **Agentic review without edit authority.** Claude can inspect files with
  `Read`, `Glob`, `Grep`, Task sub-agents, a domain-fenced `WebFetch`, and a
  narrow git wrapper, but safe mode denies `Edit`, `Write`, raw shell, and raw
  git.
- **Evidence-cited ship/no-ship output.** The `elite-review` and
  `security-review` lanes validate rich structured findings before rendering,
  so malformed or incomplete Claude output fails closed.
- **Release and workflow hardening.** The repo now has a Node 18/20/22 CI
  matrix, package-content checks, SHA-pinned GitHub Actions, GitHub Packages
  release gating, tag/package version matching, and reviewer dogfooding via
  Copilot plus Claude Code Action wiring.

## What Shipped

- Five review lanes: `review`, `adversarial-review`, `elite-review`,
  `deep-review`, and `security-review`.
- Background job support with atomic state writes, stale-lock recovery,
  persisted input snapshots, job logs, `status`, `result`, and `cancel`.
- Strict parsing and validation for basic, elite, and rich agentic schemas.
- Safe `--add-dir` handling with realpath and boundary checks.
- Strict MCP defaulting, with `--inherit-mcp` documented as a trust expansion.
- GitHub Packages metadata under `@kenmege/codex-plugin-cc`, with publishing
  gated by `GH_PACKAGES_PUBLISH_ENABLED=true`.

## Migration

This is the first public v1 release. There is no migration step for new users:

```bash
git clone https://github.com/Kenmege/codex-claude-companion.git
cd codex-plugin-cc
npm install -g .
codex-claude-review setup
codex-claude-review review
```

Existing private-lane users should reinstall from the repo root and reload the
local Codex marketplace so the command surface and helper binary match v1.0.2.

## Security Hardening

The v0.2.x to v1.0.2 hardening pass focused on control-plane correctness:

- Replaced broad shell access with native Claude tools plus `git-safe.mjs`.
- Added prompt-injection delimiters around diff and focus text.
- Required evidence arrays and non-empty rich finding fields in runtime
  validation.
- Added timeout escalation, job state locking, stale-lock recovery, persisted
  result validation, and NO_SHIP exit-code propagation for background results.
- Removed internal prompt artifacts from tracked public docs and excluded them
  from the package tarball.

## Known Limits

- Claude Code Action review on GitHub requires either `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` as a repository Actions secret.
- Claude auto-review skips untrusted fork PRs when GitHub withholds repository
  Actions secrets. This avoids red checks on outside contributions while
  preserving fail-closed behavior for misconfigured maintainer branches.
- GitHub Packages install from developer machines still requires npm auth for
  `npm.pkg.github.com`.
- Windows is not a first-class tested platform for v1.0.2.

## Acknowledgments

The release was hardened through adversarial review by OpenAI Codex and
Claude Opus. Their independent NO_SHIP findings converged on the same control
plane risks: unsafe shell surface, prompt-injection boundaries, schema/runtime
drift, background-result exit codes, and release workflow safety.

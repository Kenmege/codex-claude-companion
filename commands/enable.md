---
description: Register the claude-review plugin in the local Codex CLI config.
---

# /claude-review:enable

Register the claude-review plugin in Codex. On current Codex CLI versions, the helper uses the native `codex plugin marketplace add` and `codex plugin add` path through a local wrapper marketplace under `$CODEX_HOME`/`~/.codex`. On older Codex runtimes or explicit `--config` overrides, it falls back to writing the legacy `[marketplaces.claude-review-private]` source entry and `[plugins."claude-review@claude-review-private"]` enable stanza.

Safe to re-run: native installs are refreshed idempotently, and legacy config writes preserve existing content while repairing stale `source =` paths, normalising `source_type` to `"local"`, and flipping `enabled = false` back to `true`.

## Preflight

- Plugin installed via `npm install -g codex-claude-companion` after npmjs publish, or `npm install -g .` from a cloned checkout.
- Codex CLI installed and `~/.codex/` directory exists (created automatically if absent).

## Commands

```bash
# Register the plugin (run once after install)
codex-claude enable

# Preview what would be written without touching the config
codex-claude enable --dry-run

# Machine-parseable output
codex-claude enable --json

# Override config path (useful in CI or non-standard installs)
codex-claude enable --config /path/to/config.toml
```

## Flags

- `--json` — emit machine-parseable registration status
- `--dry-run` — show what would be installed or appended without modifying Codex config
- `--config <path>` — override Codex config path and force the legacy TOML registration path (default: `$CODEX_HOME/config.toml` or `~/.codex/config.toml`)

## After Running

Restart Codex CLI to load the plugin. Slash commands then available:
`/claude-review:delegate`, `/claude-review:wait`, `/claude-review:logs`,
`/claude-review:send`, `/claude-review:recover`,
`/claude-review:bridge-doctor`, `/claude-review:workspace`,
`/claude-review:review`, `/claude-review:elite-review`,
`/claude-review:deep-review`, `/claude-review:security-review`, and
`/claude-review:setup`.

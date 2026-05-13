---
description: Register the claude-review plugin in the local Codex CLI config.
---

# /claude-review:enable

Register the claude-review plugin in the local Codex CLI config (`~/.codex/config.toml` on macOS/Linux, `%USERPROFILE%\.codex\config.toml` on Windows).

Writes the `[marketplaces.claude-review-private]` source entry and `[plugins."claude-review@claude-review-private"]` enable stanza. Safe to re-run: existing config content is preserved; the command also self-heals by refreshing a stale `source =` path, normalising `source_type` to `"local"`, and flipping `enabled = false` back to `true` so a moved checkout or previously disabled install is repaired in place. Idempotent — running again with everything already correct reports "already registered".

## Preflight

- Plugin installed via `npm install -g codex-plugin-cc` after npmjs publish, or `npm install -g .` from a cloned checkout.
- Codex CLI installed and `~/.codex/` directory exists (created automatically if absent).

## Commands

```bash
# Register the plugin (run once after install)
codex-claude-review enable

# Preview what would be written without touching the config
codex-claude-review enable --dry-run

# Machine-parseable output
codex-claude-review enable --json

# Override config path (useful in CI or non-standard installs)
codex-claude-review enable --config /path/to/config.toml
```

## Flags

- `--json` — emit machine-parseable registration status
- `--dry-run` — show what would be appended without modifying the config file
- `--config <path>` — override Codex config path (default: `~/.codex/config.toml`)

## After Running

Restart Codex CLI to load the plugin. Slash commands then available:
`/claude-review:review`, `/claude-review:elite-review`, `/claude-review:deep-review`,
`/claude-review:security-review`, `/claude-review:setup`.

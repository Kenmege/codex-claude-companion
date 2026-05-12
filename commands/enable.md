---
description: Register the claude-review plugin in the local Codex CLI config.
---

# /claude-review:enable

Register the claude-review plugin in the local Codex CLI config (`~/.codex/config.toml` on macOS/Linux, `%USERPROFILE%\.codex\config.toml` on Windows).

Appends the `[marketplaces.claude-review-private]` source entry and `[plugins."claude-review@claude-review-private"]` enable stanza if they are not already present. Safe to run on an existing config — only missing entries are added; all existing content is left intact. Idempotent.

## Preflight

- Plugin installed via `npm install -g .` from the cloned repo (or `npm install -g @kenmege/codex-plugin-cc`).
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

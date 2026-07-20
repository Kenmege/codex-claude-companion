# 2-Minute Demo Script

Use this script for a terminal recording after npmjs publish is live.

## Scene 1: Install And Diagnose

```bash
npm install -g codex-claude-companion
codex-claude enable
codex-claude doctor --probe-runtime
```

Show that `doctor` reports Node, Git, Claude CLI, Claude auth, Codex
registration, writable job storage, non-Git folder support, and runtime probe
status with exact next steps if anything is missing.

## Scene 2: Catch A Real Bug

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
git init
git config user.email demo@example.com
git config user.name Demo
cat > index.js <<'JS'
export function divide(a, b) {
  return a / b;
}
JS
git add index.js
git commit -m initial
cat > index.js <<'JS'
export function divide(a, b) {
  return a / b;
}

export function payout(total, users) {
  return divide(total, users.length);
}
JS
codex-claude review --preset ship --base HEAD
```

Expected story: Claude flags the unguarded empty-user divide path, cites the
file, and recommends a concrete fix.

## Scene 3: Research Folder

```bash
codex-claude folder ./notes --preset research --long-context --background
codex-claude status
codex-claude result <job-id>
```

Expected story: the same tool works outside git, scales to evidence-heavy
folders, and keeps long work in background jobs.

## Recording Notes

- Keep the terminal font large.
- Show the command, output, and one finding.
- Do not claim npm install is live until `npm view codex-claude-companion version`
  returns the published version.
- Do not paste tokens, local auth details, or private repo names.

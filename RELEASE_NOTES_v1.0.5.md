# codex-plugin-cc v1.0.5 — frictionless npmjs launch

This release makes the public install path straightforward:

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Highlights

- Publishes under the public npmjs package name `codex-plugin-cc`.
- Adds `codex-claude-review doctor` as the first-run diagnostic for Node, Git,
  Claude Code CLI, Claude auth, Codex registration, writable job storage,
  non-Git folder support, and optional live runtime validation with
  `--probe-runtime`.
- Adds `--preset quick|ship|security|research|deep` so developers and
  researchers can choose workflows without memorizing every lane.
- Adds npmjs publishing documentation, a two-minute terminal demo script, and an
  X.com announcement draft while keeping external posting behind human approval.
- Keeps the historical GitHub Packages path documented as an advanced lane, not
  the main public install path.

## Verification

- `npm run check` passed with 190 tests.
- `npm run pack:check` passed for `codex-plugin-cc@1.0.5`.
- Throwaway tarball install smoke verified `--version`, `--help`, and
  `doctor --json`.
- `codex-claude-review doctor --probe-runtime` verified live Claude
  non-interactive runtime access locally.
- `npm audit --audit-level=moderate` reported 0 vulnerabilities.

## Notes

- Claude Code must be installed and authenticated locally for live review runs.
- Review lanes remain read-only by default. `--unrestricted` is still an
  explicit trust-boundary escape hatch.
- If `npm install -g codex-plugin-cc` returns `404`, the npmjs publish has not
  completed yet.

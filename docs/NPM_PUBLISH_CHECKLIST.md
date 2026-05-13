# npmjs Publish Checklist

This checklist is the approval-gated path for making the public install command
real:

```bash
npm install -g codex-plugin-cc
```

Do not publish until Kennedy explicitly approves the npmjs publish action.

## Current Registry Facts

Checked on 2026-05-13:

- `npm view codex-plugin-cc --registry=https://registry.npmjs.org` returned
  `E404`, so the unscoped name was available at check time.
- `npm whoami --registry=https://registry.npmjs.org` returned `ENEEDAUTH`, so
  this machine was not logged in to npmjs.
- The repo is configured for npmjs publishing through `publishConfig.registry`
  and `.github/workflows/release.yml`.

Registry state can change. Re-run the checks immediately before publishing.

## Maintainer Setup

1. Log in to npmjs on a trusted machine:

   ```bash
   npm login --registry=https://registry.npmjs.org
   npm whoami --registry=https://registry.npmjs.org
   ```

2. Create an npm automation token with publish rights for `codex-plugin-cc`.

3. Add repository secret:

   ```bash
   gh secret set NPM_TOKEN --repo Kenmege/codex-plugin-cc
   ```

4. Enable the publish gate only when the next tag should publish:

   ```bash
   gh variable set NPMJS_PUBLISH_ENABLED --body true --repo Kenmege/codex-plugin-cc
   ```

## Pre-Publish Verification

Run locally:

```bash
npm run check
npm run pack:check
npm view codex-plugin-cc --registry=https://registry.npmjs.org
```

Expected before first npmjs publish:

- `npm run check` passes.
- `npm run pack:check` shows only intended package files.
- `npm view codex-plugin-cc` returns `E404`.

## Publish

1. Confirm `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json`
   versions match.
2. Push a semver tag matching the package version exactly:

   ```bash
   git tag v1.0.10
   git push origin v1.0.10
   ```

3. Watch the release workflow:

   ```bash
   gh run list --workflow release.yml --limit 1
   gh run watch <run-id>
   ```

## Post-Publish Smoke

Use a throwaway workspace:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm install codex-plugin-cc@<version> --registry=https://registry.npmjs.org
./node_modules/.bin/codex-claude-review --version
./node_modules/.bin/codex-claude-review --help
./node_modules/.bin/codex-claude-review doctor --json
```

Then verify the global install path:

```bash
npm install -g codex-plugin-cc@<version> --registry=https://registry.npmjs.org
codex-claude-review --version
codex-claude-review doctor
```

## Rollback

npm package versions cannot be overwritten. If a bad version is published:

1. Deprecate the version with a clear message:

   ```bash
   npm deprecate codex-plugin-cc@<bad-version> "Use <fixed-version>; this version has a release issue."
   ```

2. Publish a fixed patch version.
3. Edit the GitHub Release notes to point users to the fixed version.

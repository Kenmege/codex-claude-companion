# npmjs Publish Checklist

This checklist is the approval-gated path for making the public install command
real:

```bash
npm install -g codex-plugin-cc
```

Do not publish until Kennedy explicitly approves the npmjs publish action.

## Current Registry Facts

Checked on 2026-07-11:

- `npm view codex-plugin-cc --registry=https://registry.npmjs.org` returned
  `1.0.13` as the current version at check time.
- The repo is configured for npmjs publishing through `publishConfig.registry`
  and `.github/workflows/release.yml`.

Registry state can change. Re-run the checks immediately before publishing.

## Maintainer Setup

1. Log in to npmjs on a trusted machine:

   ```bash
   npm login --registry=https://registry.npmjs.org
   npm whoami --registry=https://registry.npmjs.org
   ```

2. In the npm package settings, add an npm trusted publisher for GitHub Actions
   with owner `Kenmege`, repository `codex-plugin-cc`, workflow filename
   `release.yml`, and allowed action `npm publish`. Leave the environment blank
   unless the workflow is updated to use that exact GitHub environment.

3. Confirm `.github/workflows/release.yml` grants `id-token: write` and publishes
   with provenance. GitHub OIDC exchanges the workflow identity for short-lived
   npm publishing access; do not configure a long-lived npm publishing secret.

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
npm view codex-plugin-cc@<version> version --registry=https://registry.npmjs.org
```

Expected before publishing a new version:

- `npm run check` passes.
- `npm run pack:check` shows only intended package files.
- `npm view codex-plugin-cc` returns the currently published version.
- `npm view codex-plugin-cc@<version>` returns `E404`, proving the immutable
  target version has not already been published.

## Publish

1. Confirm `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json`
   versions match.
2. Push a semver tag matching the package version exactly:

   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   git tag "v${VERSION}"
   git push origin "v${VERSION}"
   ```

3. Watch the release workflow:

   ```bash
   gh run list --workflow release.yml --limit 1
   gh run watch <run-id>
   ```

If the tag-triggered run must be recovered manually, dispatch the workflow from
the tag itself and pass the same tag as the input:

```bash
gh workflow run release.yml --ref "v${VERSION}" -f release_tag="v${VERSION}"
```

Do not dispatch a release recovery from `main`. GitHub's OIDC identity records
the ref that triggered the workflow; checking out a different ref later does not
change that identity. The workflow rejects any dispatch whose triggering ref is
not the requested release tag.

## Post-Publish Smoke

Use a throwaway workspace:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm install codex-plugin-cc@<version> --registry=https://registry.npmjs.org
./node_modules/.bin/codex-claude --version
./node_modules/.bin/codex-claude --help
./node_modules/.bin/codex-claude doctor --json
```

Then verify the global install path:

```bash
npm install -g codex-plugin-cc@<version> --registry=https://registry.npmjs.org
codex-claude --version
codex-claude doctor
```

## Rollback

npm package versions cannot be overwritten. If a bad version is published:

1. Deprecate the version with a clear message:

   ```bash
   npm deprecate codex-plugin-cc@<bad-version> "Use <fixed-version>; this version has a release issue."
   ```

2. Publish a fixed patch version.
3. Edit the GitHub Release notes to point users to the fixed version.

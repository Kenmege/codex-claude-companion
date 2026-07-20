# npmjs Publish Checklist

This checklist is the controlled path for making the public install command
real:

```bash
npm install -g codex-claude-companion
```

Kennedy approved the `1.2.0-rc.1` npmjs prerelease on 2026-07-19. Future stable
or scoped-package releases require their own recorded release decision.

## Current Registry Facts

Checked on 2026-07-19:

- `npm view codex-claude-companion --registry=https://registry.npmjs.org` returned
  `1.1.1` as the current stable version at check time.
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
   with owner `Kenmege`, repository `codex-claude-companion`, workflow filename
   `release.yml`, and allowed action `npm publish`. Leave the environment blank
   unless the workflow is updated to use that exact GitHub environment.

3. Confirm `.github/workflows/release.yml` grants `id-token: write` and publishes
   with provenance. GitHub OIDC exchanges the workflow identity for short-lived
   npm publishing access; do not configure a long-lived npm publishing secret.

4. Enable the publish gate only when the next tag should publish:

   ```bash
   gh variable set NPMJS_PUBLISH_ENABLED --body true --repo Kenmege/codex-claude-companion
   ```

## Pre-Publish Verification

Run locally:

```bash
npm run check
npm run pack:check
npm view codex-claude-companion --registry=https://registry.npmjs.org
npm view codex-claude-companion@<version> version --registry=https://registry.npmjs.org
```

Expected before publishing a new version:

- `npm run check` passes.
- `npm run pack:check` shows only intended package files.
- `npm view codex-claude-companion` returns the currently published version.
- `npm view codex-claude-companion@<version>` returns `E404`, proving the immutable
  target version has not already been published.

In addition to the dry run, create and inspect a real tarball in a throwaway
directory. Install that tarball, then prove both binaries, the bridge broker,
and the packaged Codex delivery adapter are present and executable/importable.
Run `codex-claude bridge-doctor --json` from the packed install and confirm no
broker, Claude worker, or `ccb-*` tmux session remains after the smoke test.

## Publish

1. Confirm `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json`
   versions match.
2. For a prerelease version such as `1.2.0-rc.1`, confirm the workflow selects
   npm dist-tag `next`; stable versions select `latest`. This preserves the
   current stable install while release-candidate smoke tests run.
3. Push a semver tag matching the package version exactly:

   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   git tag "v${VERSION}"
   git push origin "v${VERSION}"
   ```

4. Watch the release workflow:

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
npm install codex-claude-companion@<version> --registry=https://registry.npmjs.org
./node_modules/.bin/codex-claude --version
./node_modules/.bin/codex-claude --help
./node_modules/.bin/codex-claude doctor --json
./node_modules/.bin/codex-claude bridge-doctor --json
node --check node_modules/codex-claude-companion/scripts/bridge-broker.mjs
node --check node_modules/codex-claude-companion/plugins/codex/scripts/app-server-broker.mjs
```

For `1.2.0-rc.1`, also verify the dist-tags explicitly:

```bash
npm view codex-claude-companion version --registry=https://registry.npmjs.org
npm view codex-claude-companion@next version --registry=https://registry.npmjs.org
```

The expected values are `1.1.1` and `1.2.0-rc.1`, respectively.

Then verify the global install path:

```bash
npm install -g codex-claude-companion@<version> --registry=https://registry.npmjs.org
codex-claude --version
codex-claude doctor
```

## Rollback

npm package versions cannot be overwritten. If a bad version is published:

1. Deprecate the version with a clear message:

   ```bash
   npm deprecate codex-claude-companion@<bad-version> "Use <fixed-version>; this version has a release issue."
   ```

2. Publish a fixed patch version.
3. Edit the GitHub Release notes to point users to the fixed version.

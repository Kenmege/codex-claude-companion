# Frictionless Public Launch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `codex-plugin-cc` easy for public developers and researchers to install, diagnose, and use without hiding any remaining publish gates.

**Architecture:** Keep the existing read-only Claude review runtime intact. Add a public npmjs install lane, role presets that map simple commands to the right review mode, a richer first-run doctor, and launch assets that explain real usage without overclaiming.

**Tech Stack:** Node.js ESM CLI, npm package metadata, Codex plugin command markdown, GitHub Actions, markdown docs.

---

### Task 1: Public npm install lane

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/validate-repo.mjs`
- Modify: `test/release-docs.test.mjs`
- Modify: `README.md`

**Steps:**
1. Change the package identity to the unscoped public npm name `codex-plugin-cc`.
2. Set the default publish registry to `https://registry.npmjs.org`.
3. Keep GitHub Packages documented as the historical/advanced lane, not the main adoption path.
4. Update validation tests so they enforce the public npm name.
5. Update release workflow docs/guards so npmjs publishing requires explicit `NPMJS_PUBLISH_ENABLED=true` and `NPM_TOKEN`.

### Task 2: First-run doctor

**Files:**
- Modify: `scripts/claude-review-companion.mjs`
- Modify: `scripts/lib/render.mjs`
- Modify: `test/commands.test.mjs`
- Modify: `README.md`

**Steps:**
1. Add Node engine, git, Claude CLI, auth, Codex registration, job-dir, folder-readiness, and optional runtime probe fields.
2. Keep default doctor fast; add `--probe-runtime` for model/runtime access validation.
3. Emit exact recovery commands for each failure.
4. Preserve `--json` for automation.

### Task 3: Role presets

**Files:**
- Modify: `scripts/claude-review-companion.mjs`
- Modify: `test/commands.test.mjs`
- Modify: `README.md`
- Modify: `commands/*.md` where relevant.

**Steps:**
1. Add `--preset quick|ship|security|research|deep`.
2. Route `ship` to the rich elite lane, `security` to the security lane, and `deep` to the deep lane.
3. Add researcher guidance that emphasizes source-backed claims, methodology, and uncertainty.
4. Ensure explicit command names still work exactly as before.

### Task 4: Launch assets and examples

**Files:**
- Modify: `README.md`
- Create: `docs/demo/2-minute-demo.md`
- Create: `docs/launch/x-announcement-draft.md`
- Create: `docs/NPM_PUBLISH_CHECKLIST.md`

**Steps:**
1. Add copy-paste workflows for uncommitted diffs, non-git folders, big repos, security, and research.
2. Add a concise demo script that proves install, doctor, and a real finding.
3. Add an X.com draft without posting it.
4. Add an approval-gated publish checklist.

### Task 5: Verification

**Commands:**
- `npm run check`
- `npm run pack:check`
- tarball install smoke in `/tmp`
- `codex-claude-review --help`
- `codex-claude-review doctor --json`
- preset parsing smoke with a fake Claude binary

**Acceptance:**
- Public install docs lead with `npm install -g codex-plugin-cc`.
- No README claim says npm is live until publish is actually verified.
- Doctor is useful without reading source.
- Presets are discoverable and tested.
- External publish and X posting remain human-approval gated.

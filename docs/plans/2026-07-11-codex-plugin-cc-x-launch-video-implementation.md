# Codex Plugin CC X Launch Video Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce and quality-gate a 55–60 second founder-led X launch film that proves Codex orchestrating a full Claude coding job in a separate terminal, then deliver three render formats, captions, poster art, and held-for-approval launch copy.

**Architecture:** Keep public, reproducible scripts and editorial records in the repository while all private references, provider outputs, recordings, and large renders stay in an ignored `.production/x-launch-v1.1.1/` workspace. Generate a disposable failing fixture for the real coding demonstration. Capture the live Codex-to-Claude workflow, add deterministic HyperFrames/Remotion overlays, and derive every format from one evidence-locked timeline. Do not publish to X or any other public surface during execution.

**Tech Stack:** Node.js ESM, Node test runner, Codex Plugin CC, Claude CLI agent view, macOS screen capture, GPT Image, HeyGen, ElevenLabs, Runway, HyperFrames, React, Remotion, FFmpeg, SRT captions.

---

### Task 1: Establish the tracked production contract and private workspace

**Files:**
- Modify: `.gitignore`
- Create: `docs/launch/video-v1.1.1/README.md`
- Create: `docs/launch/video-v1.1.1/asset-ledger.example.json`
- Create locally only: `.production/x-launch-v1.1.1/assets.local.json`
- Create locally only: `.production/x-launch-v1.1.1/{reference,generated,capture,audio,edit,renders,qa}/`

**Steps:**
1. Add `/.production/` to `.gitignore` so private references and provider outputs cannot be committed.
2. Create the directory tree with `mkdir -p .production/x-launch-v1.1.1/{reference,generated,capture,audio,edit,renders,qa}`.
3. Create a public asset-ledger example containing only logical names, roles, expected aspect ratios, provenance type, and approval state.
4. Create the private ledger with local paths and provider job identifiers. Never put API keys, balances, email addresses, prompts containing private paths, or account identifiers in either ledger.
5. Copy the approved casual T-shirt image into `.production/x-launch-v1.1.1/reference/kennedy-casual.jpg` through a local environment variable rather than recording its source path in repository history.
6. Run `git check-ignore -v .production/x-launch-v1.1.1/reference/kennedy-casual.jpg`; expect a `/.production/` match.
7. Run `git status --short`; expect only `.gitignore` and the two tracked launch files.
8. Commit with `git commit -m "docs: establish launch video production contract"`.

### Task 2: Build a deterministic, disposable coding fixture

**Files:**
- Create: `scripts/create-launch-video-fixture.mjs`
- Create: `test/launch-video-fixture.test.mjs`
- Modify: `docs/launch/video-v1.1.1/README.md`

**Steps:**
1. Write a generator that creates a temporary Git repository containing `src/usage-ledger.mjs`, `test/usage-ledger.test.mjs`, and `package.json`.
2. Make the initial implementation intentionally incomplete while the tests specify a credible feature: aggregate valid token-usage events by model, reject negative or non-numeric counts, and return deterministic totals.
3. Make the generated repository use invented event values and no network, account, or provider data.
4. Add a test that runs the generator in a temporary directory, verifies the expected files and clean initial commit, then confirms `node --test` fails only because `summarizeUsage()` is not implemented.
5. Add the exact demo request to the README: `Implement summarizeUsage(events), preserve the public API, add any missing edge-case tests, and run the complete test suite.`
6. Run `node --test test/launch-video-fixture.test.mjs`; expect one passing generator test whose inner fixture assertion records the intentional baseline failure.
7. Run `npm run check`; expect the repository suite to pass.
8. Commit with `git commit -m "feat: add reproducible launch demo fixture"`.

### Task 3: Generate and approve the Kennedy hero frame

**Files:**
- Create locally only: `.production/x-launch-v1.1.1/generated/kennedy-hero-4x5.png`
- Create locally only: `.production/x-launch-v1.1.1/generated/kennedy-hero-16x9.png`
- Modify locally only: `.production/x-launch-v1.1.1/assets.local.json`
- Create: `docs/launch/video-v1.1.1/visual-review.md`

**Steps:**
1. Confirm provider spend is permitted with `test ! -e "$HOME/ai/state/spend-halt"`; stop provider calls if it exists.
2. Use the approved private casual T-shirt reference in image-edit mode. Preserve Kennedy’s identity, shirt, natural skin texture, age, hands, and eye line. Place him in a plausible dark graphite code studio with a warm key light, restrained ion-blue rim light, and clear negative space for the launch line. Generate no text, logos, terminal UI, or model branding in the image.
3. Generate the 4:5 master first. Derive or regenerate the 16:9 frame from the same reference and direction; do not stretch the portrait master.
4. Inspect both at original resolution for face drift, extra fingers, clothing changes, waxy skin, background leaks, and unsafe crops.
5. Record only the pass/fail findings and chosen logical asset names in `visual-review.md`; keep private paths and provider identifiers in the ignored ledger.
6. Accept no frame until identity fidelity, hand anatomy, and practical lighting all pass.
7. Commit the review record with `git commit -m "docs: record launch hero art review"`.

### Task 4: Capture the real Codex-to-Claude coding workflow

**Files:**
- Create locally only: `.production/x-launch-v1.1.1/capture/codex-claude-master.mov`
- Create locally only: `.production/x-launch-v1.1.1/capture/capture-notes.md`
- Create: `docs/launch/video-v1.1.1/proof-log.md`

**Steps:**
1. Generate a fresh fixture and save its printed directory in a shell variable: `DEMO_DIR="$(node scripts/create-launch-video-fixture.mjs)"`.
2. Set both terminals to a large font, hide unrelated tabs, clear scrollback, disable shell history for the capture shell, and confirm the prompt contains no username or private parent path.
3. Verify the controlled starting state with `git -C "$DEMO_DIR" status --short` and `node --test "$DEMO_DIR/test/usage-ledger.test.mjs"`; record the expected single feature failure.
4. Start a macOS screen recording at native display resolution. Record one continuous evidence take so the handoff cannot be mistaken for an edit.
5. From the active Codex task, invoke the workspace command against the fixture with the approved request. Keep Codex visible while the plugin opens Claude’s native control panel in the second terminal.
6. Capture Claude reading the task, editing the fixture, running the failing tests, repairing the implementation, and reaching green.
7. Return visibly to Codex. Capture Codex checking workspace status, inspecting `git diff`, running `node --test`, and giving its final verification verdict. If a real defect remains, capture one focused repair dispatch and a second verification loop.
8. Stop recording only after the green receipt and clean session status are visible.
9. Review the entire take at 100% scale. Reject it for any hidden cut across the decisive handoff, unreadable command, notification, credential, username, private path, unrelated history, or claim not evidenced on screen.
10. In `proof-log.md`, record sanitized commands, visible receipts, test counts, the live model labels actually shown, and timecode ranges. Do not copy session IDs or local paths.
11. Commit with `git commit -m "docs: record launch film proof take"`.

### Task 5: Produce the founder opening, close, and voice

**Files:**
- Create locally only: `.production/x-launch-v1.1.1/generated/heygen-open.mp4`
- Create locally only: `.production/x-launch-v1.1.1/generated/heygen-close.mp4`
- Create locally only: `.production/x-launch-v1.1.1/audio/founder-voice.wav`
- Create: `docs/launch/video-v1.1.1/voice-script.md`

**Steps:**
1. Freeze the voice script only after the proof take so every word matches the evidence.
2. Generate separate opening and closing presenter clips with the approved private casual T-shirt look. Use restrained gestures, direct eye contact, natural blink cadence, and enough handle frames for transitions.
3. If the avatar-native voice is not natural enough, use the approved ElevenLabs founder voice for the entire spoken track rather than mixing voices between scenes.
4. Use the line order from the design document, but shorten any sentence that competes with terminal readability. Keep the delivery confident, conversational, and under the evidence-locked duration.
5. Inspect every spoken frame for mouth artifacts, teeth flicker, eye drift, frozen hands, background leaks, face crops, and identity changes. Regenerate failed segments; do not hide them under captions.
6. Normalize the selected voice track consistently and check it on laptop and phone speakers.
7. Commit the final public script with `git commit -m "docs: lock launch film voice script"`.

### Task 6: Build the HyperFrames motion package

**Files:**
- Create locally only: `.production/x-launch-v1.1.1/edit/hyperframes/DESIGN.md`
- Create locally only: `.production/x-launch-v1.1.1/edit/hyperframes/title.html`
- Create locally only: `.production/x-launch-v1.1.1/edit/hyperframes/handoff.html`
- Create locally only: `.production/x-launch-v1.1.1/edit/hyperframes/end-card.html`
- Create: `docs/launch/video-v1.1.1/motion-spec.md`

**Steps:**
1. Encode the approved palette, Bricolage Grotesque/IBM Plex Mono registers, edge anchoring, video-scale type, and banned visual patterns in `DESIGN.md`.
2. Build three deterministic compositions: the opening title, the ion-blue Codex-to-Claude handoff, and the end card.
3. Use entrance animations for every scene. Keep outgoing content visible and let transitions perform the exit; only the final end card may fade out.
4. Use a directional push as the primary transition, one short zoom-through at the verification climax, and a gentle focus pull into the founder close. Do not mix CSS and shader transition systems in one composition.
5. Vary entrance directions, easing, duration, and scene rhythm. Give every scene build, breathe, and resolve phases, with no animation beginning at frame zero.
6. Run the HyperFrames validation and timeline-inspection commands available in the installed CLI. Resolve every collision, offscreen, invisible, contrast, and pacing flag or justify it in `motion-spec.md`.
7. Export transparent or keyed overlays at the master timeline’s frame rate.
8. Commit with `git commit -m "docs: define launch film motion system"`.

### Task 7: Assemble the evidence-locked Remotion master

**Files:**
- Create locally only: `.production/x-launch-v1.1.1/edit/remotion/package.json`
- Create locally only: `.production/x-launch-v1.1.1/edit/remotion/src/Root.tsx`
- Create locally only: `.production/x-launch-v1.1.1/edit/remotion/src/LaunchFilm.tsx`
- Create locally only: `.production/x-launch-v1.1.1/edit/remotion/src/CaptionPage.tsx`
- Create locally only: `.production/x-launch-v1.1.1/edit/remotion/src/timeline.ts`
- Create locally only: `.production/x-launch-v1.1.1/edit/remotion/public/`
- Create: `docs/launch/video-v1.1.1/edit-decision-list.md`

**Steps:**
1. Scaffold the local Remotion project and install matching Remotion packages through `npx remotion add`, including captions and transitions.
2. Copy only approved assets into the local `public/` folder. Record their checksums in the private ledger.
3. Define one 30 fps evidence-locked timeline in `timeline.ts`. Derive 4:5, 16:9, and 9:16 compositions from shared scene timing and format-specific safe-area layouts.
4. Drive all animation from `useCurrentFrame()`, `interpolate()`, or Remotion transitions. Do not use CSS transitions, CSS animations, `Date.now()`, or unseeded randomness.
5. Keep terminal footage at readable scale. Use crop changes to direct attention, never generated replacement text.
6. Parse the approved SRT with `@remotion/captions`, keep caption rendering in `CaptionPage.tsx`, preserve whitespace, and display only one conversational caption group at a time.
7. Ensure captions never cover Kennedy’s face, the active command, the changed code, or the green test receipt.
8. Render contact-sheet stills at every scene boundary with `npx remotion still`; inspect them before a full render.
9. Render a low-resolution review master, compare every claim against `proof-log.md`, and update `edit-decision-list.md` with exact source and destination timecodes.
10. Commit the public edit-decision list with `git commit -m "docs: lock launch film edit decisions"`.

### Task 8: Create captions, poster, and launch copy

**Files:**
- Create: `docs/launch/video-v1.1.1/captions.srt`
- Create: `docs/launch/video-v1.1.1/x-post-draft.md`
- Create locally only: `.production/x-launch-v1.1.1/renders/poster-4x5.png`
- Modify: `docs/launch/x-announcement-draft.md`

**Steps:**
1. Export the final timed captions to `captions.srt`, then compare every cue against the locked audio waveform and Remotion caption data.
2. Build the poster from the approved Kennedy hero, one real split-terminal proof frame, and the line `ONE PROMPT. TWO ELITE CODING MINDS.` Keep the version and repository callout subordinate.
3. Update the existing X announcement from v1.1.0 to v1.1.1 and replace speculative language with claims proven in `proof-log.md`.
4. Provide a concise single-post version and an optional six-post technical thread. Include alt text for the poster/video.
5. Retain the explicit “do not post without Kennedy approval” gate.
6. Run `git diff --check` and `npm run check`.
7. Commit with `git commit -m "docs: prepare v1.1.1 video launch package"`.

### Task 9: Render all formats and run release-grade QA

**Files:**
- Create locally only: `.production/x-launch-v1.1.1/renders/codex-plugin-cc-v1.1.1-x-4x5.mp4`
- Create locally only: `.production/x-launch-v1.1.1/renders/codex-plugin-cc-v1.1.1-landscape-16x9.mp4`
- Create locally only: `.production/x-launch-v1.1.1/renders/codex-plugin-cc-v1.1.1-teaser-9x16.mp4`
- Create locally only: `.production/x-launch-v1.1.1/qa/render-report.json`
- Create: `docs/launch/video-v1.1.1/qa-signoff.md`

**Steps:**
1. Render the 4:5 master first, then the 16:9 and 9:16 variants from the same approved timeline.
2. Use `ffprobe` to record codec, dimensions, frame rate, duration, audio channels, and file size for each deliverable in `render-report.json`.
3. Extract one frame per second plus every scene boundary. Review for face artifacts, terminal legibility, caption collisions, black frames, discontinuities, duplicated frames, and private information.
4. Watch each render once with sound, once muted, once at normal phone size, and once at 100% desktop scale.
5. Verify the audio begins and ends cleanly, narration stays intelligible, and no generated sound implies an action absent from the proof.
6. Cross-check every product statement against the tagged v1.1.1 package, `proof-log.md`, and the real capture.
7. Run `npm run check`, `npm run pack:check`, and `git diff --check`; all must pass.
8. Complete `qa-signoff.md` with a verdict for identity, proof integrity, privacy, accessibility, audio, each aspect ratio, repository checks, and the remaining public-post approval gate.
9. Commit with `git commit -m "docs: sign off v1.1.1 launch video QA"`.

### Task 10: Hold for Kennedy’s final publication approval

**Files:**
- Verify: `.production/x-launch-v1.1.1/renders/`
- Verify: `docs/launch/video-v1.1.1/qa-signoff.md`
- Verify: `docs/launch/video-v1.1.1/x-post-draft.md`

**Steps:**
1. Present the 4:5 master, poster frame, final post copy, and QA signoff to Kennedy together.
2. State plainly that provider generation is complete but no public post has been made.
3. Apply only evidence-preserving revisions. Any edit that changes a product claim must repeat proof and privacy review.
4. Publish only after Kennedy explicitly approves the final render and exact X copy.

## Execution mode

Execute this plan solo in the current task. Provider generation and local rendering are authorized, subject to the spend-halt check. Public posting remains a separate approval-gated action.


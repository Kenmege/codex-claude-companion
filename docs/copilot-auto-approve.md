# Copilot review auto-approve

**Status:** configured via `.github/workflows/copilot-auto-approve.yml` (2026-09-23).

## What it does

When `copilot-pull-request-reviewer[bot]` submits a pull-request review with
state **`approved`**, the workflow posts an **APPROVE** review on the same
head SHA using `GITHUB_TOKEN` (`github-actions[bot]`), or — if present — the
optional repository secret `CODEOWNER_APPROVE_TOKEN`.

## What it does **not** do

- It does **not** merge the pull request.
- It does **not** bypass required status checks (Node 18.18/20/22, CodeQL,
  Dependency Review, etc.).
- It does **not** dismiss CODEOWNER review requirements. Branch protection on
  `main` still requires `@Kenmege` (see `.github/CODEOWNERS`) plus green CI
  before merge. Approvals from `github-actions[bot]` alone do not satisfy
  `require_code_owner_reviews`.

## Copilot automatic review (separate)

Repository ruleset **Automatic Copilot code review** (`id` 16094832) remains
active on `refs/heads/main` with `review_on_push: true` and
`review_draft_pull_requests: true`.

## Optional CODEOWNER token

To make the auto-approval also count as a CODEOWNER review, a human may add a
fine-scoped personal access token owned by `@Kenmege` as repository secret
`CODEOWNER_APPROVE_TOKEN` (`pull_requests: write` only). Do not invent or
commit tokens.

## CodeRabbit

`.coderabbit.yaml` enables chill auto-review (including drafts). The
`coderabbitai[bot]` GitHub App was already reviewing this repository before
this maintenance pass.

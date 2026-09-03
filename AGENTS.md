# Repository agent instructions

This file is the canonical project instruction for coding agents.
These instructions apply to every agent and automation path operating on this repository.
These requirements apply to every pull request, including dependency-only, documentation-only, and automation-authored changes.

## Pull request integrity

- Never merge or recommend merging while any required status check or required review is absent, pending, failing, stale, or bypassed.
- The approval that satisfies final-head protection must be submitted by someone other than the actor whose push most recently updated the pull request's HEAD commit.
- Administrative merge bypass, direct push to a protected branch, temporary branch-protection changes, force-push, dismissal of reviews to unblock a merge, and fabricated approvals are prohibited.
- A pull request may merge only after all required checks pass and the final head commit has the repository's required approving review through the normal review mechanism.
- Security dependency updates must remain minimal and must preserve or strengthen existing test and cross-platform CI coverage.
- If author/reviewer identity creates a sole-code-owner deadlock, use a bot/agent-authored branch and obtain the real code-owner review; do not bypass.

- Required local verification for repository changes:

  ```bash
  npm ci
  npm run check
  npm run pack:check
  npm audit --omit=dev
  ```

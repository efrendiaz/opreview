# Review Load: exclude the PR author's own review events; include bots

**Date:** 2026-07-31
**Status:** Approved

## Problem

1. GitHub creates a `COMMENTED` review when a PR author replies to review
   comments on their own PR. opreview counts those as review events, so the
   Review Load table/chart credits authors with "review effort" that is
   really them responding to feedback on their own work. Example from the
   July 2026 Pineapples report: a reviewer with 188 events but only 5
   approvals — most events were replies on their own PRs.
2. Bot reviewers (Copilot, bugbot, …) are blanket-excluded by the `[bot]`
   login filter, so the review work they absorb is invisible in the report.

## Decision

1. Nobody is a reviewer of their own PR. Events whose login matches the PR
   author are dropped at the source, so the exclusion applies everywhere
   downstream: the Review Load table and chart (`reviewerStats`), the
   "PRs reviewed" counts (`reviewerLoad`), and the per-PR `reviewers` list
   in the JSON output.
2. All bots that emit review events are included as regular reviewer rows
   (e.g. `@copilot[bot]`). No allowlist; a noisy bot can be silenced via
   the existing `excludeLogins` in `teams.json`. Dependabot PRs remain
   excluded from the PR set, so this only affects bots acting as reviewers.

## Design

- `reviewEventsFromReviews(reviews, authorLogin)` in `src/sources/github.js`
  gains an optional second parameter. Events whose login equals
  `authorLogin` (case-insensitive, matching the existing `excludeLogins`
  convention) are filtered out.
- When `authorLogin` is empty/undefined the function behaves exactly as
  today.
- The PR enrichment step in `fetchTeamPRMetrics()` passes `pr.user?.login`.
  `reviewers`, `reviewerLoad`, `reviewerStats` and all report outputs derive
  from those events, so no other code changes are needed for the
  self-review exclusion.
- The `login.endsWith('[bot]')` skip is removed from both
  `computeReviewerStats()` and the `reviewerLoad` loop in
  `computePRMetrics()`. `excludeLogins` keeps working for bots and humans
  alike.

## Tests (TDD)

In `test/github.test.js`:

1. `reviewEventsFromReviews` drops events from the author, case-insensitive.
2. Without `authorLogin` behaviour is unchanged.
3. `fetchTeamPRMetrics` integration test: an author commenting on their own
   PR appears in neither `reviewerStats` nor `reviewers`.
4. `computeReviewerStats` and `computePRMetrics` count `[bot]` logins as
   regular reviewers, and `excludeLogins` still removes them when listed.

## Out of scope

- Other Review Load list items the team may raise later (this is item 1 of
  a list).
- Republishing already-published reports; regenerating July for Pineapples
  will change the Review Load numbers and can be republished on demand.

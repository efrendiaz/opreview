# Review Load section — design

**Date:** 2026-07-16
**Goal:** In Pineapples (and any team), review load is concentrated on a few
engineers (up to ~4h/day reviewing PRs). Surface *who* carries the review load
so the EM can rebalance it. Add a dedicated "Review Load" section to the
operational review, separate from the existing metrics table.

## Metrics (per human reviewer, current period only)

Derived from the review events already fetched in `fetchTeamPRMetrics` (no extra
API calls). Bots (`[bot]` suffix) and `team.excludeMembers` are omitted.

- `prs` — distinct PRs the engineer reviewed (same value as today's `reviewerLoad`).
- `approvals` — count of real `APPROVED` review events (each approval counts,
  including re-approvals after changes).
- `events` — count of all non-PENDING review events with a user (approval,
  changes-requested, commented). Best proxy for time spent.

Sorted by `events` descending.

## Components

### 1. Data — `src/sources/github.js`
- Enrichment retains per-PR review events `[{ login, state }]` (non-PENDING,
  has user), not just deduped reviewer logins.
- New pure helper `computeReviewerStats(enriched, excludeLogins)` → array of
  `{ login, prs, approvals, events }`, filtered + sorted by `events` desc.
- `teamPRs` gains `reviewerStats`. `reviewerLoad` is unchanged (the existing
  "Reviews by engineer" cell keeps working).

### 2. Chart — `src/output/charts.js`
- New `hBarChart({ rows, title, valueLabel })` — horizontal bars, one per row
  (`{ label, value }`), label at left, value at bar end. Matches existing chart
  dimensions/palette.
- New `renderReviewLoadChart(reviewerStats, team)` → `{ name: 'review-load',
  svg }`, bars sized by `events`, top ~15 reviewers.

### 3. Wiring — `src/index.js`
- Build the review-load chart **always** (independent of `--history`) from
  `data.github.current.teamPRs.reviewerStats`, and push it into the `charts`
  array so it is rasterised, written, and attached to Confluence like the rest.

### 4. Rendering — new "Review Load" section after "Trends"
- `storage.js` (Confluence): `<h2>Review Load</h2>` + chart image + table
  `Engineer | PRs reviewed | Approvals | Review events | % of events`.
- `html.js`: same section, inline `<svg>` + HTML table.
- `markdown.js`: `## Review Load` + table.
- Reflects the current period only.

## Edge cases
- No reviewers → section renders a "No review activity" note, no empty table.
- A PR approved multiple times by the same person → each approval event counts.

## Testing (TDD)
- `computeReviewerStats`: aggregation, bot/exclude filtering, sort order,
  approvals-vs-events distinction.
- `hBarChart`: renders a bar per row; empty-rows case.
- Section rendering in each of the three outputs (table content).

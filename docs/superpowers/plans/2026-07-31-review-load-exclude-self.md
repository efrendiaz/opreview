# Review Load: exclude self-reviews, include bots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review Load stops crediting PR authors for activity on their own PRs and starts counting bot reviewers (Copilot, bugbot, …) as regular reviewers.

**Architecture:** Both changes live in `src/sources/github.js`. Self-review exclusion happens at the source — `reviewEventsFromReviews()` gains an optional `authorLogin` parameter and the enrichment in `fetchTeamPRMetrics()` passes the PR author — so `reviewers`, `reviewerLoad`, `reviewerStats` and every report output inherit it. Bot inclusion is the removal of the two `endsWith('[bot]')` skips in `computeReviewerStats()` and `computePRMetrics()`.

**Tech Stack:** Node 18+ ESM, `node:test` + `node:assert/strict` (run via `npm test`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-review-load-exclude-self-design.md`
- Login comparisons are case-insensitive (same convention as `excludeLogins`).
- With no `authorLogin` argument, `reviewEventsFromReviews` behaves exactly as today.
- `excludeLogins` from `teams.json` must keep working for bots and humans alike.
- Branch: `review-load-exclude-self`. TDD: every behavior change lands with its test in the same commit.

---

### Task 1: Exclude the PR author's own review events

**Files:**
- Modify: `src/sources/github.js:153-167` (`reviewEventsFromReviews`, `reviewersFromReviews`)
- Modify: `src/sources/github.js:294` (enrichment call site in `fetchTeamPRMetrics`)
- Test: `test/github.test.js`

**Interfaces:**
- Consumes: existing `reviewEventsFromReviews(reviews)` returning `[{login, state}]`.
- Produces: `reviewEventsFromReviews(reviews, authorLogin = '')` and `reviewersFromReviews(reviews, authorLogin = '')` — same return shapes; events whose `login` matches `authorLogin` case-insensitively are dropped. Task 2 does not depend on this signature.

- [ ] **Step 1: Write the failing unit tests**

Add to `test/github.test.js` (also add `reviewEventsFromReviews` to the import list from `../src/sources/github.js`):

```js
// --- reviewEventsFromReviews: the author is not a reviewer of their own PR ---
test('reviewEventsFromReviews drops the PR author\'s own events (case-insensitive)', () => {
  const reviews = [
    { state: 'COMMENTED', user: { login: 'Alice' } },
    { state: 'COMMENTED', user: { login: 'alice' } },
    { state: 'APPROVED', user: { login: 'bob' } }
  ];
  assert.deepEqual(reviewEventsFromReviews(reviews, 'alice'), [
    { login: 'bob', state: 'APPROVED' }
  ]);
});

test('reviewEventsFromReviews keeps every event when no author is given', () => {
  const reviews = [
    { state: 'COMMENTED', user: { login: 'alice' } },
    { state: 'APPROVED', user: { login: 'bob' } }
  ];
  assert.deepEqual(reviewEventsFromReviews(reviews), [
    { login: 'alice', state: 'COMMENTED' },
    { login: 'bob', state: 'APPROVED' }
  ]);
});

test('reviewersFromReviews excludes the PR author', () => {
  const reviews = [
    { state: 'COMMENTED', user: { login: 'alice' } },
    { state: 'APPROVED', user: { login: 'bob' } }
  ];
  assert.deepEqual(reviewersFromReviews(reviews, 'alice').sort(), ['bob']);
});
```

- [ ] **Step 2: Extend the integration test so it fails on self-reviews**

In the existing test `fetchTeamPRMetrics filters to the window and computes reviewer load end-to-end`, PR #1's author is `alice`. Change the `/pulls/1/reviews` stub to include a self-comment by the author:

```js
    if (url.includes('/pulls/1/reviews')) return jsonRes(200, [
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'COMMENTED', user: { login: 'alice' } } // author replying on own PR
    ]);
```

The existing assertions (`m.reviewerLoad` is exactly `{ reviewer1: 1 }`, `m.reviewerStats` is exactly the one `reviewer1` row) now fail until the exclusion is implemented — do not change them.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npm test`
Expected: the three new tests FAIL (extra `alice`/`Alice` events in the output) and the integration test FAILS (`alice` appears in `reviewerLoad`/`reviewerStats`). All other tests PASS.

- [ ] **Step 4: Implement the exclusion**

In `src/sources/github.js` replace lines 153-167 with:

```js
// Real review events from a PR's reviews: one entry per submitted review
// (PENDING reviews and events without a user are ignored). Keeps every event —
// e.g. a reviewer who requests changes twice then approves yields 3 entries —
// so downstream can count approvals and total review activity, not just people.
// Events by authorLogin (the PR author, compared case-insensitively) are
// dropped: replying to feedback on your own PR is not reviewing it.
export function reviewEventsFromReviews(reviews, authorLogin = '') {
  const author = (authorLogin || '').toLowerCase();
  return reviews
    .filter(r => r.state !== 'PENDING' && r.user?.login)
    .filter(r => !author || r.user.login.toLowerCase() !== author)
    .map(r => ({ login: r.user.login, state: r.state }));
}

// Distinct human reviewer logins from a PR's review events (PENDING reviews and
// events without a user are ignored). authorLogin is excluded like above.
export function reviewersFromReviews(reviews, authorLogin = '') {
  return [...new Set(reviewEventsFromReviews(reviews, authorLogin).map(e => e.login))];
}
```

And change the enrichment call site (line 294) from:

```js
    const reviewEvents = reviewEventsFromReviews(reviews);
```

to:

```js
    const reviewEvents = reviewEventsFromReviews(reviews, pr.user?.login);
```

- [ ] **Step 5: Run tests to verify everything passes**

Run: `npm test`
Expected: PASS (all files, including charts/output tests).

- [ ] **Step 6: Commit**

```bash
git add src/sources/github.js test/github.test.js
git commit -m "Exclude PR author's own review events from Review Load"
```

---

### Task 2: Count bot reviewers as regular reviewers

**Files:**
- Modify: `src/sources/github.js:169-193` (`computeReviewerStats`)
- Modify: `src/sources/github.js:221-235` (`computePRMetrics` reviewer-load loop)
- Test: `test/github.test.js`

**Interfaces:**
- Consumes: `computeReviewerStats(enriched, excludeLogins)` and `computePRMetrics(enriched, excludeLogins)` as they exist today.
- Produces: same signatures and return shapes; `[bot]` logins are no longer skipped, `excludeLogins` still removes any login (bot or human) case-insensitively.

- [ ] **Step 1: Rewrite the two bot tests to expect inclusion, add exclude-still-works coverage**

In `test/github.test.js` replace the test `computePRMetrics omits bots and excluded logins from reviewer load` with:

```js
test('computePRMetrics counts bot reviewers and still honors excludeLogins', () => {
  const enriched = [
    { timeToMergeMs: 1000, comments: 0, reviewers: ['alice', 'copilot[bot]', 'Manager'] }
  ];
  const m = computePRMetrics(enriched, ['manager']);
  assert.deepEqual(m.reviewerLoad, { alice: 1, 'copilot[bot]': 1 });
});

test('computePRMetrics excludeLogins also removes bots', () => {
  const enriched = [
    { timeToMergeMs: 1000, comments: 0, reviewers: ['alice', 'copilot[bot]'] }
  ];
  const m = computePRMetrics(enriched, ['copilot[bot]']);
  assert.deepEqual(m.reviewerLoad, { alice: 1 });
});
```

And replace the test `computeReviewerStats omits bots and excluded logins` with:

```js
test('computeReviewerStats counts bot reviewers and still honors excludeLogins', () => {
  const enriched = [
    { reviewEvents: [
      { login: 'alice', state: 'APPROVED' },
      { login: 'copilot[bot]', state: 'COMMENTED' },
      { login: 'Manager', state: 'COMMENTED' }
    ] }
  ];
  const stats = computeReviewerStats(enriched, ['manager']);
  assert.deepEqual(stats.map(s => s.login).sort(), ['alice', 'copilot[bot]']);
});

test('computeReviewerStats excludeLogins also removes bots', () => {
  const enriched = [
    { reviewEvents: [
      { login: 'alice', state: 'APPROVED' },
      { login: 'copilot[bot]', state: 'COMMENTED' }
    ] }
  ];
  const stats = computeReviewerStats(enriched, ['copilot[bot]']);
  assert.deepEqual(stats.map(s => s.login), ['alice']);
});
```

- [ ] **Step 2: Run tests to verify the rewritten ones fail**

Run: `npm test`
Expected: the two "counts bot reviewers" tests FAIL (bot rows missing). The two "excludeLogins also removes bots" tests PASS already (bots are skipped today for a different reason) — that's fine; they lock the behavior in for after the change. Everything else PASSES.

- [ ] **Step 3: Remove the `[bot]` skips**

In `computeReviewerStats` (line 176-178 area) change:

```js
  const exclude = new Set((excludeLogins || []).map(l => l.toLowerCase()));
  const skip = login => login.endsWith('[bot]') || exclude.has(login.toLowerCase());
```

to:

```js
  const exclude = new Set((excludeLogins || []).map(l => l.toLowerCase()));
  const skip = login => exclude.has(login.toLowerCase());
```

In `computePRMetrics` (line 232) change:

```js
      if (login.endsWith('[bot]') || excludeSet.has(login.toLowerCase())) continue;
```

to:

```js
      if (excludeSet.has(login.toLowerCase())) continue;
```

Update the two doc comments that promise bot exclusion — `// Per-reviewer stats across the given PRs. Bots ([bot] suffix) and excludeLogins are omitted.` (line 169-170) becomes:

```js
// Per-reviewer stats across the given PRs. excludeLogins are omitted; bots
// that review (Copilot, bugbot, …) count like any reviewer. For each reviewer:
```

and `// counts distinct reviewers per PR; bots ([bot] suffix) and excludeLogins are omitted.` (lines 221-223) becomes:

```js
// Aggregate enriched PRs into the metrics shown in the report. Reviewer load
// counts distinct reviewers per PR (bots included); excludeLogins are omitted.
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/github.js test/github.test.js
git commit -m "Count bot reviewers (Copilot, bugbot, ...) in Review Load"
```

---

### Task 3: Verify against real data (manual smoke)

**Files:**
- None modified; reads `out/op-review-pineapples-2026-07.json` freshly regenerated.

**Interfaces:**
- Consumes: the full CLI (`node src/index.js`).
- Produces: evidence the numbers changed as intended, for the report re-publish decision.

- [ ] **Step 1: Regenerate July for Pineapples locally (no publish)**

Run: `node src/index.js --team pineapples --month 2026-07 --history 0`
Expected: completes without errors; Review Load table shows lower event counts for engineers who reply on their own PRs, and bot rows (if any bots reviewed in July) appear.

- [ ] **Step 2: Compare against the published numbers**

Baseline (published 2026-07-31): serenematt-babbel 193 events / 34%, Jhojan28 188 / 33%, mangs 159 / 28%, kreaves-babbel 30 / 5%. Confirm authors' self-comment events dropped and totals are consistent (no engineer gained events; any new rows are `[bot]` logins). Report the before/after table to the user and ask whether to republish the Confluence page.

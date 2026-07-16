import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repoFromUrl,
  median,
  retryDelayMs,
  mapLimit,
  prMergedInWindow,
  reviewersFromReviews,
  computePRMetrics,
  computeReviewerStats,
  fetchTeamPRMetrics
} from '../src/sources/github.js';

// --- repoFromUrl ---
test('repoFromUrl extracts org/repo from a PR html_url', () => {
  assert.equal(repoFromUrl('https://github.com/lessonnine/oranges-web/pull/123'), 'lessonnine/oranges-web');
});

test('repoFromUrl returns empty string when url has no repo path', () => {
  assert.equal(repoFromUrl('https://github.com/'), '');
});

// --- median ---
test('median of odd-length array is the middle value', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median of even-length array averages the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('median of empty array is null', () => {
  assert.equal(median([]), null);
});

// --- Bug #1: retryDelayMs only retries genuine rate limits ---
test('retryDelayMs returns null for a plain 403 (permission denied, no rate-limit headers)', () => {
  const headers = new Headers({});
  assert.equal(retryDelayMs(403, headers, 'Resource not accessible by integration', 0), null);
});

test('retryDelayMs retries a 429 with Retry-After', () => {
  const headers = new Headers({ 'retry-after': '5' });
  assert.equal(retryDelayMs(429, headers, '', 0), 5000);
});

test('retryDelayMs retries a 403 whose body is a secondary rate limit', () => {
  const headers = new Headers({});
  const delay = retryDelayMs(403, headers, 'You have exceeded a secondary rate limit', 0);
  assert.ok(delay > 0, `expected a positive backoff, got ${delay}`);
});

test('retryDelayMs retries a 403 with x-ratelimit-remaining: 0', () => {
  const reset = Math.floor(Date.now() / 1000) + 60;
  const headers = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
  const delay = retryDelayMs(403, headers, '', 0);
  assert.ok(delay > 0, `expected a positive wait, got ${delay}`);
});

test('retryDelayMs returns null for a 404', () => {
  assert.equal(retryDelayMs(404, new Headers({}), 'Not Found', 0), null);
});

// --- Bug #2: exclusive end window ---
test('prMergedInWindow includes a PR merged exactly at the start', () => {
  const start = Date.parse('2026-07-01T00:00:00Z');
  const end = Date.parse('2026-08-01T00:00:00Z');
  assert.equal(prMergedInWindow('2026-07-01T00:00:00Z', start, end), true);
});

test('prMergedInWindow excludes a PR merged exactly at the end (exclusive)', () => {
  const start = Date.parse('2026-07-01T00:00:00Z');
  const end = Date.parse('2026-08-01T00:00:00Z');
  assert.equal(prMergedInWindow('2026-08-01T00:00:00Z', start, end), false);
});

test('prMergedInWindow excludes a PR merged before the window', () => {
  const start = Date.parse('2026-07-01T00:00:00Z');
  const end = Date.parse('2026-08-01T00:00:00Z');
  assert.equal(prMergedInWindow('2026-06-30T23:59:59Z', start, end), false);
});

test('prMergedInWindow returns false when mergedAt is missing', () => {
  assert.equal(prMergedInWindow(null, 0, 1), false);
});

// --- reviewersFromReviews ---
test('reviewersFromReviews dedupes and drops pending / userless reviews', () => {
  const reviews = [
    { state: 'APPROVED', user: { login: 'alice' } },
    { state: 'COMMENTED', user: { login: 'alice' } },
    { state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
    { state: 'PENDING', user: { login: 'carol' } },
    { state: 'APPROVED', user: null }
  ];
  assert.deepEqual(reviewersFromReviews(reviews).sort(), ['alice', 'bob']);
});

// --- computePRMetrics ---
test('computePRMetrics aggregates totals, median, avg comments and reviewer load', () => {
  const enriched = [
    { timeToMergeMs: 1000, comments: 2, reviewers: ['alice', 'bob'] },
    { timeToMergeMs: 3000, comments: 4, reviewers: ['alice'] }
  ];
  const m = computePRMetrics(enriched, []);
  assert.equal(m.total, 2);
  assert.equal(m.medianTimeToMergeMs, 2000);
  assert.equal(m.totalComments, 6);
  assert.equal(m.avgComments, 3);
  assert.deepEqual(m.reviewerLoad, { alice: 2, bob: 1 });
});

test('computePRMetrics omits bots and excluded logins from reviewer load', () => {
  const enriched = [
    { timeToMergeMs: 1000, comments: 0, reviewers: ['alice', 'dependabot[bot]', 'Manager'] }
  ];
  const m = computePRMetrics(enriched, ['manager']);
  assert.deepEqual(m.reviewerLoad, { alice: 1 });
});

test('computePRMetrics on empty set yields null median and null avg', () => {
  const m = computePRMetrics([], []);
  assert.equal(m.total, 0);
  assert.equal(m.medianTimeToMergeMs, null);
  assert.equal(m.avgComments, null);
  assert.deepEqual(m.reviewerLoad, {});
});

// --- computeReviewerStats ---
test('computeReviewerStats counts distinct PRs, real approvals and total events per reviewer', () => {
  const enriched = [
    { reviewEvents: [
      { login: 'alice', state: 'APPROVED' },
      { login: 'alice', state: 'COMMENTED' },
      { login: 'bob', state: 'CHANGES_REQUESTED' }
    ] },
    { reviewEvents: [
      { login: 'alice', state: 'CHANGES_REQUESTED' },
      { login: 'alice', state: 'APPROVED' }
    ] }
  ];
  const stats = computeReviewerStats(enriched, []);
  // alice: 2 PRs, 2 approvals, 4 events; bob: 1 PR, 0 approvals, 1 event
  assert.deepEqual(stats, [
    { login: 'alice', prs: 2, approvals: 2, events: 4 },
    { login: 'bob', prs: 1, approvals: 0, events: 1 }
  ]);
});

test('computeReviewerStats sorts by events desc', () => {
  const enriched = [
    { reviewEvents: [
      { login: 'low', state: 'COMMENTED' },
      { login: 'high', state: 'APPROVED' },
      { login: 'high', state: 'COMMENTED' },
      { login: 'high', state: 'CHANGES_REQUESTED' }
    ] }
  ];
  const stats = computeReviewerStats(enriched, []);
  assert.deepEqual(stats.map(s => s.login), ['high', 'low']);
});

test('computeReviewerStats omits bots and excluded logins', () => {
  const enriched = [
    { reviewEvents: [
      { login: 'alice', state: 'APPROVED' },
      { login: 'dependabot[bot]', state: 'APPROVED' },
      { login: 'Manager', state: 'COMMENTED' }
    ] }
  ];
  const stats = computeReviewerStats(enriched, ['manager']);
  assert.deepEqual(stats.map(s => s.login), ['alice']);
});

test('computeReviewerStats counts a PR once even with multiple events by the same reviewer', () => {
  const enriched = [
    { reviewEvents: [
      { login: 'alice', state: 'COMMENTED' },
      { login: 'alice', state: 'COMMENTED' },
      { login: 'alice', state: 'APPROVED' }
    ] }
  ];
  const stats = computeReviewerStats(enriched, []);
  assert.deepEqual(stats, [{ login: 'alice', prs: 1, approvals: 1, events: 3 }]);
});

test('computeReviewerStats on empty input is an empty array', () => {
  assert.deepEqual(computeReviewerStats([], []), []);
});

// --- Bug #3: mapLimit bounds concurrency ---
test('mapLimit never exceeds the concurrency limit and preserves order', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = await mapLimit(items, 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(maxActive <= 3, `concurrency exceeded: ${maxActive}`);
});

// --- Integration: fetchTeamPRMetrics with a stubbed fetch ---
function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test('fetchTeamPRMetrics filters to the window and computes reviewer load end-to-end', async () => {
  const origFetch = globalThis.fetch;
  const origToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'x';

  const start = Date.parse('2026-07-01T00:00:00Z');
  const end = Date.parse('2026-08-01T00:00:00Z');

  const searchItems = [
    { number: 1, title: 'in window', html_url: 'https://github.com/org/repo/pull/1',
      user: { login: 'alice' }, created_at: '2026-07-10T00:00:00Z',
      pull_request: { merged_at: '2026-07-15T00:00:00Z' }, comments: 1, review_comments: 1 },
    { number: 2, title: 'at end boundary (excluded)', html_url: 'https://github.com/org/repo/pull/2',
      user: { login: 'bob' }, created_at: '2026-07-20T00:00:00Z',
      pull_request: { merged_at: '2026-08-01T00:00:00Z' }, comments: 0, review_comments: 0 }
  ];

  globalThis.fetch = async (url) => {
    if (url.includes('/search/issues')) return jsonRes(200, { items: searchItems });
    if (url.includes('/pulls/1/reviews')) return jsonRes(200, [{ state: 'APPROVED', user: { login: 'reviewer1' } }]);
    if (url.includes('/reviews')) return jsonRes(200, []);
    return jsonRes(404, { message: 'not found' });
  };

  try {
    const m = await fetchTeamPRMetrics(['org/repo'], start, end, []);
    assert.equal(m.total, 1, 'PR merged at the exclusive end boundary must be excluded');
    assert.deepEqual(m.reviewerLoad, { reviewer1: 1 });
    assert.deepEqual(m.reviewerStats, [{ login: 'reviewer1', prs: 1, approvals: 1, events: 1 }]);
    assert.equal(m.medianTimeToMergeMs, Date.parse('2026-07-15T00:00:00Z') - Date.parse('2026-07-10T00:00:00Z'));
  } finally {
    globalThis.fetch = origFetch;
    process.env.GITHUB_TOKEN = origToken;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHtml } from '../src/output/html.js';
import { renderMarkdown } from '../src/output/markdown.js';
import { renderStorage } from '../src/output/storage.js';

const RANGE = {
  label: '2026-06',
  current: { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' },
  previous: { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' }
};
const TEAM = { name: 'x', displayName: 'X' };
const DATA_WITH_STATS = {
  github: {
    current: { teamPRs: { reviewerStats: [
      { login: 'alice', prs: 5, approvals: 3, events: 12 },
      { login: 'bob', prs: 2, approvals: 1, events: 3 }
    ] } },
    previous: {}
  }
};

// --- PR rows removed from Team Metrics (now only in the Review Load section) ---
const PR_ROW_LABELS = ['Team PRs merged', 'Median time to merge', 'Avg comments per PR', 'Reviews by engineer'];

test('markdown Team Metrics no longer contains the PR review rows', () => {
  const md = renderMarkdown(RANGE, DATA_WITH_STATS, TEAM);
  for (const label of PR_ROW_LABELS) assert.doesNotMatch(md, new RegExp(label));
});

test('html Team Metrics no longer contains the PR review rows', () => {
  const html = renderHtml(RANGE, DATA_WITH_STATS, TEAM);
  for (const label of PR_ROW_LABELS) assert.doesNotMatch(html, new RegExp(label));
});

test('storage Team Metrics no longer contains the PR review rows', () => {
  const xml = renderStorage(RANGE, DATA_WITH_STATS, TEAM, {});
  for (const label of PR_ROW_LABELS) assert.doesNotMatch(xml, new RegExp(label));
});

// --- Review Load section ---
test('markdown Review Load section lists reviewers with approvals, events and % share', () => {
  const md = renderMarkdown(RANGE, DATA_WITH_STATS, TEAM);
  assert.match(md, /## Review Load/);
  // alice: 12/15 events = 80%, bob: 3/15 = 20%
  assert.match(md, /\| @alice \| 5 \| 3 \| 12 \| 80% \|/);
  assert.match(md, /\| @bob \| 2 \| 1 \| 3 \| 20% \|/);
});

test('html Review Load section embeds the chart svg and a table row per reviewer', () => {
  const html = renderHtml(RANGE, DATA_WITH_STATS, TEAM);
  assert.match(html, /<h2>Review Load<\/h2>/);
  assert.match(html, /<svg/); // inline chart
  assert.match(html, /<td>@alice<\/td><td>5<\/td><td>3<\/td><td>12<\/td><td>80%<\/td>/);
});

test('storage Review Load references the chart attachment and renders the table', () => {
  const xml = renderStorage(RANGE, DATA_WITH_STATS, TEAM, { chartFilenames: ['trend-review-load.png'] });
  assert.match(xml, /<h2>Review Load<\/h2>/);
  assert.match(xml, /ri:filename="trend-review-load.png"/);
  assert.match(xml, /<td>@bob<\/td><td>2<\/td><td>1<\/td><td>3<\/td><td>20%<\/td>/);
});

test('storage does not show the review-load chart under Trends', () => {
  const xml = renderStorage(RANGE, DATA_WITH_STATS, TEAM, {
    chartFilenames: ['trend-pd-alerts.png', 'trend-review-load.png']
  });
  const trendsIdx = xml.indexOf('<h2>Trends</h2>');
  const reviewIdx = xml.indexOf('<h2>Review Load</h2>');
  const reviewLoadImgIdx = xml.indexOf('ri:filename="trend-review-load.png"');
  // the review-load image ref must appear in the Review Load section, not Trends
  assert.ok(trendsIdx !== -1 && reviewIdx !== -1);
  assert.ok(reviewLoadImgIdx > reviewIdx, 'review-load chart should be under Review Load');
});

test('markdown Review Load shows a fallback when there is no review activity', () => {
  const md = renderMarkdown(RANGE, { github: { current: { teamPRs: { reviewerStats: [] } } } }, TEAM);
  assert.match(md, /## Review Load/);
  assert.match(md, /No review activity/);
});

// --- Shared repos labelled in the per-repo notes ---
const DATA_WITH_SHARED = {
  github: {
    current: {
      vulnerabilities: { total: 3, bySeverity: {}, items: [
        { title: 'v1', url: 'u', severity: 'high', package: 'p', repo: 'org/common.js', shared: true },
        { title: 'v2', url: 'u', severity: 'low', package: 'p', repo: 'org/common.js', shared: true },
        { title: 'v3', url: 'u', severity: 'high', package: 'p', repo: 'org/own.spa', shared: false }
      ] },
      dependabotPRs: { total: 2, items: [
        { title: 'd1', url: 'u', createdAt: '2026-06-01T00:00:00Z', repo: 'org/common.js', shared: true },
        { title: 'd2', url: 'u', createdAt: '2026-06-01T00:00:00Z', repo: 'org/own.spa', shared: false }
      ] },
      teamPRs: { reviewerStats: [] }
    },
    previous: {}
  }
};

function assertSharedLabels(out) {
  // Vulnerabilities note: "…common.js…</a>: 2 (…)" style differs per renderer,
  // so match on the label following the repo name/link.
  assert.match(out, /common\.js[^\n<]*(<\/a>)? \(shared\): 2/);
  assert.match(out, /common\.js[^\n<]*(<\/a>)? \(shared\): 1/);
  assert.doesNotMatch(out, /own\.spa[^\n<]*(<\/a>)? \(shared\)/);
}

test('markdown marks shared repos with a (shared) suffix in both GitHub notes', () => {
  assertSharedLabels(renderMarkdown(RANGE, DATA_WITH_SHARED, TEAM));
});

test('html marks shared repos with a (shared) suffix in both GitHub notes', () => {
  assertSharedLabels(renderHtml(RANGE, DATA_WITH_SHARED, TEAM));
});

test('storage marks shared repos with a (shared) suffix in both GitHub notes', () => {
  assertSharedLabels(renderStorage(RANGE, DATA_WITH_SHARED, TEAM, {}));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hBarChart, renderReviewLoadChart } from '../src/output/charts.js';

test('hBarChart renders one bar per row and includes labels and values', () => {
  const svg = hBarChart({
    rows: [{ label: 'alice', value: 10 }, { label: 'bob', value: 4 }],
    title: 'Review load'
  });
  assert.match(svg, /^<svg/);
  // one <rect> bar per row
  assert.equal((svg.match(/<rect /g) || []).length, 2);
  assert.match(svg, /alice/);
  assert.match(svg, /bob/);
  assert.match(svg, /Review load/);
});

test('hBarChart with no rows still returns a valid svg (no bars)', () => {
  const svg = hBarChart({ rows: [], title: 'Empty' });
  assert.match(svg, /^<svg/);
  assert.equal((svg.match(/<rect /g) || []).length, 0);
});

test('hBarChart escapes labels', () => {
  const svg = hBarChart({ rows: [{ label: 'a<b>&c', value: 1 }], title: 't' });
  assert.match(svg, /a&lt;b&gt;&amp;c/);
  assert.doesNotMatch(svg, /a<b>&c/);
});

test('renderReviewLoadChart sizes bars by events and caps at top N', () => {
  const stats = Array.from({ length: 20 }, (_, i) => ({
    login: `u${i}`, prs: 1, approvals: 1, events: 20 - i
  }));
  const chart = renderReviewLoadChart(stats, { displayName: 'Pineapples' }, { top: 15 });
  assert.equal(chart.name, 'review-load');
  assert.match(chart.svg, /^<svg/);
  // capped at 15 bars
  assert.equal((chart.svg.match(/<rect /g) || []).length, 15);
  // highest-events reviewer present, one beyond the cap absent
  assert.match(chart.svg, /u0/);
  assert.doesNotMatch(chart.svg, /u19/);
});

test('renderReviewLoadChart returns null when there are no reviewers', () => {
  assert.equal(renderReviewLoadChart([], { displayName: 'X' }), null);
});

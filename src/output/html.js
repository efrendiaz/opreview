// HTML renderer mirroring markdown.js. The intended workflow is:
// open the .html file in a browser, select all, copy, then paste into a
// Confluence page body — the rich-text clipboard makes Confluence build a
// native table with the multi-line cells, hyperlinks, and coloured deltas.

import { formatDuration } from '../sources/pagerduty.js';
import { renderReviewLoadChart } from './charts.js';

const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(d) {
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtRange(window) {
  const start = new Date(window.start);
  const endInclusive = new Date(new Date(window.end).getTime() - 1);
  return `${fmtDate(start)} - ${fmtDate(endInclusive)}`;
}

function monthNameFromLabel(label) {
  const idx = parseInt(label.split('-')[1], 10) - 1;
  return MONTHS_LONG[idx];
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function multiline(s) {
  // Convert \n line separators to <br>, escaping the surrounding text.
  return String(s).split('\n').map(esc).join('<br>');
}

function deltaCount(curr, prev) {
  if (curr == null || prev == null) return '';
  const d = curr - prev;
  if (d === 0) return '';
  const arrow = d > 0 ? '↑' : '↓';
  const color = d > 0 ? '#d04437' : '#14892c';
  return ` <span style="color:${color}">${arrow}${Math.abs(d)}</span>`;
}

function deltaDuration(currMs, prevMs) {
  if (currMs == null || prevMs == null) return '';
  const d = currMs - prevMs;
  if (d === 0) return '';
  const arrow = d > 0 ? '↑' : '↓';
  const color = d > 0 ? '#d04437' : '#14892c';
  return ` <span style="color:${color}">${arrow}${esc(formatDuration(Math.abs(d)))}</span>`;
}

function num(v) { return v == null ? '—' : esc(v); }

function issueList(issues) {
  if (!issues || !issues.length) return '';
  return issues.map(i =>
    `<a href="${esc(i.url)}">${esc(i.key)}</a>: ${esc(i.summary)}`
  ).join('<br>');
}

function recurringNote(titles) {
  if (!titles || !titles.length) return '';
  // If any entry has a URL we emit <a> markup, which means asCell preserves
  // the whole string as HTML — so escape title content inline. Otherwise
  // pass through plain so asCell escapes once.
  if (titles.some(t => t.url)) {
    return 'Top recurring:<br>' + titles.map(t => {
      const titlePart = t.url
        ? `<a href="${esc(t.url)}">${esc(t.title)}</a>`
        : `"${esc(t.title)}"`;
      return `${titlePart} (${t.count}x)`;
    }).join('<br>');
  }
  return 'Top recurring:\n' + titles.map(t => `"${t.title}" (${t.count}x)`).join('\n');
}

function pdHuList(incidents) {
  if (!incidents || !incidents.length) return '';
  return 'HU incidents:<br>' + incidents.map(i =>
    `<a href="${esc(i.url)}">${esc(i.title)}</a>`
  ).join('<br>');
}

function breachNote(b) {
  if (!b) return '';
  const parts = [];
  if (b.high > 0) parts.push(`HU ${b.high}`);
  if (b.low > 0) parts.push(`LU ${b.low}`);
  if (!parts.length) return 'Within SLO';
  const head = 'SLO breaches: ' + parts.join(', ');
  if (!b.top || !b.top.length) return head;
  const lines = b.top.map(t => {
    const tag = t.urgency === 'high' ? 'HU' : 'LU';
    return `<a href="${esc(t.url)}">${esc(t.title)}</a> (${tag} +${esc(formatDuration(t.overshootMs))} over)`;
  });
  return head + '<br>' + lines.join('<br>');
}

function topOccurrencesNote(top) {
  if (!top || !top.length) return '';
  const fmt = n => n.toLocaleString('en-US');
  return 'Top by occurrences:<br>' + top.map(t => {
    const titlePart = t.url
      ? `<a href="${esc(t.url)}">${esc(t.title)}</a>`
      : `"${t.title}"`;
    return `${titlePart} (${fmt(t.occurrences)})`;
  }).join('<br>');
}

const SEVERITY_COLOR = { critical: '#990000', high: '#d04437', medium: '#e8a200', low: '#36b37e' };

// Repos flagged as shared with another team (see isSharedRepo). Labelled in
// the per-repo notes so readers can tell exclusive debt from shared debt.
function sharedRepos(items) {
  return new Set(items.filter(i => i.shared).map(i => i.repo));
}
function sharedSuffix(shared, repo) {
  return shared.has(repo) ? ' (shared)' : '';
}

// Vulnerabilities cell: total (with delta) and, when the snapshot carries the
// exclusive/shared split, one line per group underneath.
function vulnsCell(v, delta = '') {
  if (!v || v.total == null) return num(v?.total);
  const head = num(v.total) + delta;
  if (!v.bySharing) return head;
  return `${head}\nexclusive: ${v.bySharing.exclusive}\nshared: ${v.bySharing.shared}`;
}

function vulnsByRepoNote(items) {
  if (!items || !items.length) return '';
  const shared = sharedRepos(items);
  const byRepo = new Map();
  for (const a of items) {
    let g = byRepo.get(a.repo);
    if (!g) { g = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }; byRepo.set(a.repo, g); }
    g[Object.hasOwn(g, a.severity) ? a.severity : 'unknown']++;
  }
  const order = ['critical', 'high', 'medium', 'low'];
  return [...byRepo.entries()]
    .map(([repo, s]) => ({ repo, s, total: s.critical + s.high + s.medium + s.low + s.unknown }))
    .sort((a, b) => b.total - a.total)
    .map(({ repo, s, total }) => {
      const parts = order
        .filter(k => s[k] > 0)
        .map(k => `<span style="color:${SEVERITY_COLOR[k]}">${k[0].toUpperCase()}${k.slice(1)}: ${s[k]}</span>`);
      if (s.unknown > 0) parts.push(`Unknown: ${s.unknown}`);
      return `<a href="https://github.com/${esc(repo)}/security/dependabot">${esc(repo)}</a>${sharedSuffix(shared, repo)}: ${total} (${parts.join(', ')})`;
    })
    .join('<br>');
}

function prsByRepoNote(items) {
  if (!items || !items.length) return '';
  const shared = sharedRepos(items);
  const counts = new Map();
  for (const p of items) counts.set(p.repo, (counts.get(p.repo) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([repo, n]) =>
      `<a href="https://github.com/${esc(repo)}/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot">${esc(repo)}</a>${sharedSuffix(shared, repo)}: ${n}`
    )
    .join('<br>');
}

function row(metric, current, previous, notes) {
  // metric/current/previous/notes are pre-built HTML fragments (or plain
  // strings with optional \n separators). \n is translated to <br>; HTML
  // already in the string passes through.
  return `      <tr><td>${asCell(metric)}</td><td>${asCell(current)}</td><td>${asCell(previous)}</td><td>${asCell(notes)}</td></tr>`;
}

// If the cell already contains <br> or <span> we trust it as HTML; if it's
// plain text with \n, we convert to <br>; null becomes em-dash.
function asCell(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/<(br|span|a)\b/i.test(s)) return s.replace(/\n/g, '<br>');
  return multiline(s);
}

export function renderHtml(range, data, team) {
  const monthName = monthNameFromLabel(range.label);
  const owner = process.env.JIRA_EMAIL || '';
  const title = `${monthName} Operational Review [${team.displayName}]`;

  const out = [];
  out.push('<!DOCTYPE html>');
  out.push('<html><head><meta charset="utf-8">');
  out.push(`<title>${esc(title)}</title>`);
  out.push('<style>');
  out.push('  body { font-family: -apple-system, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #172b4d; }');
  out.push('  h1 { font-size: 1.6rem; }');
  out.push('  h2 { font-size: 1.2rem; margin-top: 2rem; padding: 0.4rem 0.6rem; background: #deebff; }');
  out.push('  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }');
  out.push('  th, td { border: 1px solid #c1c7d0; padding: 0.5rem 0.7rem; vertical-align: top; text-align: left; }');
  out.push('  th { background: #f4f5f7; }');
  out.push('  table.meta { width: auto; }');
  out.push('  table.meta td:first-child { font-weight: 600; background: #f4f5f7; }');
  out.push('  a { color: #0052cc; }');
  out.push('</style>');
  out.push('</head><body>');

  out.push(`<h1>${esc(title)}</h1>`);

  // Metadata
  out.push('<table class="meta">');
  out.push(`  <tr><td>Team</td><td>${esc(team.displayName)}</td></tr>`);
  out.push(`  <tr><td>Date</td><td>${esc(fmtDate(new Date()))}</td></tr>`);
  out.push(`  <tr><td>Review period</td><td>${esc(fmtRange(range.current))}</td></tr>`);
  out.push(`  <tr><td>Previous review period</td><td>${esc(fmtRange(range.previous))}</td></tr>`);
  out.push(`  <tr><td>Owner</td><td>${esc(owner)}</td></tr>`);
  out.push('</table>');

  // Team Metrics
  out.push('<h2>Team Metrics</h2>');
  out.push('<table>');
  out.push('  <thead><tr><th>Metric</th><th>Current Period</th><th>Previous Period</th><th>Notes/Comments</th></tr></thead>');
  out.push('  <tbody>');

  const pd = data.pagerduty || {};
  if (pd.error) {
    out.push(row('PagerDuty', `error: ${pd.error}`, '', ''));
  } else {
    const pc = pd.current || {};
    const pp = pd.previous || {};
    const huAlertsNotes = [pdHuList(pc.highIncidents), recurringNote(pc.recurringTitles)].filter(Boolean).join('\n');
    out.push(row(
      'High Urgency PD Alerts<br>Total PD Alerts',
      `HU: ${num(pc.high)}${deltaCount(pc.high, pp.high)}\nTotal: ${num(pc.total)}${deltaCount(pc.total, pp.total)}`,
      `HU: ${num(pp.high)}\nTotal: ${num(pp.total)}`,
      huAlertsNotes
    ));
    out.push(row(
      'MTTA<br>(HU &lt;1h)<br>(LU &lt;9h)',
      `High: ${esc(formatDuration(pc.mttaHighMs))}${deltaDuration(pc.mttaHighMs, pp.mttaHighMs)}\nLow: ${esc(formatDuration(pc.mttaLowMs))}${deltaDuration(pc.mttaLowMs, pp.mttaLowMs)}`,
      `High: ${esc(formatDuration(pp.mttaHighMs))}\nLow: ${esc(formatDuration(pp.mttaLowMs))}`,
      breachNote(pc.breaches?.mtta)
    ));
    out.push(row(
      'MTTR<br>(HU &lt;4h)<br>(LU &lt;15h)',
      `High: ${esc(formatDuration(pc.mttrHighMs))}${deltaDuration(pc.mttrHighMs, pp.mttrHighMs)}\nLow: ${esc(formatDuration(pc.mttrLowMs))}${deltaDuration(pc.mttrLowMs, pp.mttrLowMs)}`,
      `High: ${esc(formatDuration(pp.mttrHighMs))}\nLow: ${esc(formatDuration(pp.mttrLowMs))}`,
      breachNote(pc.breaches?.mttr)
    ));
  }

  const jira = data.jira || {};
  if (jira.error) {
    out.push(row('Jira Incidents', `error: ${jira.error}`, '', ''));
  } else {
    const ic = jira.current?.incidents || [];
    const ip = jira.previous?.incidents || [];
    out.push(row(
      'Jira Incidents',
      num(ic.length) + deltaCount(ic.length, ip.length),
      num(ip.length),
      issueList(ic)
    ));
  }

  const rb = data.rollbar || {};
  if (rb.error) {
    out.push(row('Rollbars', `error: ${rb.error}`, '', ''));
  } else {
    const cc = rb.current?.count;
    const cp = rb.previous?.count;
    const open = rb.current?.openTotal;
    const top = rb.current?.topByOccurrences;
    const notes = [`Open at end of period: ${num(open)}`, topOccurrencesNote(top)].filter(Boolean).join('\n');
    out.push(row(
      'Rollbars',
      `Error: ${num(cc)}${deltaCount(cc, cp)}`,
      `Error: ${num(cp)}`,
      notes
    ));
  }

  const gh = data.github || {};
  if (gh.error) {
    out.push(row('Vulnerabilities', `error: ${gh.error}`, '', ''));
    out.push(row('Dependabot PRs', `error: ${gh.error}`, '', ''));
  } else {
    const vc = gh.current?.vulnerabilities || {};
    const vprev = gh.previous?.vulnerabilities;
    const vp = vprev?.total;
    out.push(row(
      'Vulnerabilities',
      vulnsCell(vc, deltaCount(vc.total, vp)),
      vulnsCell(vprev),
      vulnsByRepoNote(vc.items)
    ));
    const dp = gh.current?.dependabotPRs || {};
    const pp = gh.previous?.dependabotPRs?.total;
    out.push(row(
      'Dependabot PRs',
      num(dp.total) + deltaCount(dp.total, pp),
      num(pp),
      prsByRepoNote(dp.items)
    ));
  }

  const wz = data.wiz || {};
  if (wz.error) {
    out.push(row('WIZ', `error: ${wz.error}`, '', ''));
  } else if (wz.current?._skipped || wz.current?._todo) {
    out.push(row('WIZ', wz.current._skipped || wz.current._todo, '', ''));
  } else {
    const wc = wz.current || {};
    out.push(row(
      'WIZ',
      `Critical: ${num(wc.critical)}\nHigh: ${num(wc.high)}\nMedium: ${num(wc.medium)}`,
      '',
      ''
    ));
  }

  if (!jira.error) {
    const bc = jira.current?.bugs || [];
    const bp = jira.previous?.bugs || [];
    out.push(row(
      'Bugs',
      num(bc.length) + deltaCount(bc.length, bp.length),
      num(bp.length),
      issueList(bc)
    ));
  }

  out.push('  </tbody>');
  out.push('</table>');

  const reviewerStats = data.github?.current?.teamPRs?.reviewerStats;
  out.push('<h2>Review Load</h2>');
  out.push('<p><em>Current period. Sized by review events (proxy for review effort).</em></p>');
  if (reviewerStats && reviewerStats.length) {
    const chart = renderReviewLoadChart(reviewerStats, team);
    if (chart) out.push(`<p>${chart.svg}</p>`);
    const totalEvents = reviewerStats.reduce((s, r) => s + r.events, 0) || 1;
    out.push('<table><thead><tr><th>Engineer</th><th>PRs reviewed</th><th>Approvals</th><th>Review events</th><th>% of events</th></tr></thead>');
    out.push('  <tbody>');
    for (const r of reviewerStats) {
      const pct = Math.round((r.events / totalEvents) * 100);
      out.push(`    <tr><td>@${esc(r.login)}</td><td>${r.prs}</td><td>${r.approvals}</td><td>${r.events}</td><td>${pct}%</td></tr>`);
    }
    out.push('  </tbody></table>');
  } else {
    out.push('<p><em>No review activity in this period.</em></p>');
  }

  out.push('<h2>Service Metrics</h2>');
  out.push('<h2>Action Items</h2>');

  out.push('</body></html>');
  return out.join('\n');
}

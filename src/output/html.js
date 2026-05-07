// HTML renderer mirroring markdown.js. The intended workflow is:
// open the .html file in a browser, select all, copy, then paste into a
// Confluence page body — the rich-text clipboard makes Confluence build a
// native table with the multi-line cells, hyperlinks, and coloured deltas.

import { formatDuration } from '../sources/pagerduty.js';

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
  return parts.length ? 'SLO breaches: ' + parts.join(', ') : 'Within SLO';
}

function severityNote(bySeverity) {
  if (!bySeverity) return '';
  const order = ['critical', 'high', 'medium', 'low'];
  const parts = order
    .filter(k => bySeverity[k] > 0)
    .map(k => `${k[0].toUpperCase()}${k.slice(1)}: ${bySeverity[k]}`);
  if (bySeverity.unknown > 0) parts.push(`Unknown: ${bySeverity.unknown}`);
  return parts.join(', ');
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

function prList(prs, max = 5) {
  if (!prs || !prs.length) return '';
  const sorted = [...prs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const items = sorted.slice(0, max).map(p =>
    `<a href="${esc(p.url)}">${esc(p.title)}</a> — ${esc(p.repo)}`
  );
  if (sorted.length > max) items.push(`...and ${sorted.length - max} more`);
  return items.join('<br>');
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
      `HU: ${num(pc.high)}\nTotal: ${num(pc.total)}`,
      `HU: ${num(pp.high)}${deltaCount(pc.high, pp.high)}\nTotal: ${num(pp.total)}${deltaCount(pc.total, pp.total)}`,
      huAlertsNotes
    ));
    out.push(row(
      'MTTA<br>(HU &lt;1h)<br>(LU &lt;9h)',
      `High: ${esc(formatDuration(pc.mttaHighMs))}\nLow: ${esc(formatDuration(pc.mttaLowMs))}`,
      `High: ${esc(formatDuration(pp.mttaHighMs))}${deltaDuration(pc.mttaHighMs, pp.mttaHighMs)}\nLow: ${esc(formatDuration(pp.mttaLowMs))}${deltaDuration(pc.mttaLowMs, pp.mttaLowMs)}`,
      breachNote(pc.breaches?.mtta)
    ));
    out.push(row(
      'MTTR<br>(HU &lt;4h)<br>(LU &lt;15h)',
      `High: ${esc(formatDuration(pc.mttrHighMs))}\nLow: ${esc(formatDuration(pc.mttrLowMs))}`,
      `High: ${esc(formatDuration(pp.mttrHighMs))}${deltaDuration(pc.mttrHighMs, pp.mttrHighMs)}\nLow: ${esc(formatDuration(pp.mttrLowMs))}${deltaDuration(pc.mttrLowMs, pp.mttrLowMs)}`,
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
      num(ic.length),
      num(ip.length) + deltaCount(ic.length, ip.length),
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
      `Error: ${num(cc)}`,
      `Error: ${num(cp)}${deltaCount(cc, cp)}`,
      notes
    ));
  }

  const gh = data.github || {};
  if (gh.error) {
    out.push(row('Vulnerabilities', `error: ${gh.error}`, '', ''));
    out.push(row('Dependabot PRs', `error: ${gh.error}`, '', ''));
  } else {
    const vc = gh.current?.vulnerabilities || {};
    out.push(row(
      'Vulnerabilities',
      num(vc.total),
      '—',
      severityNote(vc.bySeverity)
    ));
    const dp = gh.current?.dependabotPRs || {};
    out.push(row(
      'Dependabot PRs',
      num(dp.total),
      '—',
      prList(dp.items)
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
      num(bc.length),
      num(bp.length) + deltaCount(bc.length, bp.length),
      issueList(bc)
    ));
  }

  out.push('  </tbody>');
  out.push('</table>');

  out.push('<h2>Service Metrics</h2>');
  out.push('<h2>Action Items</h2>');

  out.push('</body></html>');
  return out.join('\n');
}

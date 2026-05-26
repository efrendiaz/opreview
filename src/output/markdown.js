// Renders the gathered data into a Confluence-friendly markdown that mirrors
// the team's existing operational review template: metadata header, Team
// Metrics table with deltas vs. previous month, then empty placeholder sections
// (Service Metrics, Action Items) for the team to fill in manually.

import { formatDuration } from '../sources/pagerduty.js';

const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(d) {
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtRange(window) {
  const start = new Date(window.start);
  // window.end is exclusive (next month's first day); show the inclusive last day.
  const endInclusive = new Date(new Date(window.end).getTime() - 1);
  return `${fmtDate(start)} - ${fmtDate(endInclusive)}`;
}

function monthNameFromLabel(label) {
  const idx = parseInt(label.split('-')[1], 10) - 1;
  return MONTHS_LONG[idx];
}

// Inline coloured arrow + delta. Confluence renders inline HTML in table cells.
function deltaCount(curr, prev) {
  if (curr == null || prev == null) return '';
  const d = curr - prev;
  if (d === 0) return '';
  const arrow = d > 0 ? '↑' : '↓';
  const color = d > 0 ? 'red' : 'green';
  return ` <span style="color:${color}">${arrow}${Math.abs(d)}</span>`;
}

function deltaDuration(currMs, prevMs) {
  if (currMs == null || prevMs == null) return '';
  const d = currMs - prevMs;
  if (d === 0) return '';
  const arrow = d > 0 ? '↑' : '↓';
  const color = d > 0 ? 'red' : 'green';
  return ` <span style="color:${color}">${arrow}${formatDuration(Math.abs(d))}</span>`;
}

function num(v) { return v == null ? '—' : String(v); }

function issueList(issues) {
  if (!issues || !issues.length) return '';
  return issues.map(i => `[${i.key}](${i.url}): ${i.summary}`).join('\n');
}

function recurringNote(titles) {
  if (!titles || !titles.length) return '';
  return 'Top recurring:\n' + titles.map(t => {
    const titlePart = t.url ? `[${t.title}](${t.url})` : `"${t.title}"`;
    return `${titlePart} (${t.count}x)`;
  }).join('\n');
}

function pdHuList(incidents) {
  if (!incidents || !incidents.length) return '';
  return 'HU incidents:\n' + incidents.map(i => `[${i.title}](${i.url})`).join('\n');
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
    return `[${t.title}](${t.url}) (${tag} +${formatDuration(t.overshootMs)} over)`;
  });
  return head + '\n' + lines.join('\n');
}

function topOccurrencesNote(top) {
  if (!top || !top.length) return '';
  const fmt = n => n.toLocaleString('en-US');
  return 'Top by occurrences:\n' + top.map(t => {
    const titlePart = t.url ? `[${t.title}](${t.url})` : `"${t.title}"`;
    return `${titlePart} (${fmt(t.occurrences)})`;
  }).join('\n');
}

const SEVERITY_COLOR = { critical: '#990000', high: '#d04437', medium: '#e8a200', low: '#36b37e' };

// Per-repo Dependabot alert breakdown by severity. The org-wide total is
// already in the Current Period cell; the notes column zooms in on which
// repos are carrying the debt so EMs know where to push next.
function vulnsByRepoNote(items) {
  if (!items || !items.length) return '';
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
      return `[${repo}](https://github.com/${repo}/security/dependabot): ${total} (${parts.join(', ')})`;
    })
    .join('\n');
}

function prsByRepoNote(items) {
  if (!items || !items.length) return '';
  const counts = new Map();
  for (const p of items) counts.set(p.repo, (counts.get(p.repo) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([repo, n]) =>
      `[${repo}](https://github.com/${repo}/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot): ${n}`
    )
    .join('\n');
}

function cell(v) {
  if (v == null) return '—';
  const s = String(v);
  return s.includes('\n') ? s.replace(/\n/g, '<br/>') : s;
}

function row(metric, current, previous, notes) {
  return `| ${cell(metric)} | ${cell(current)} | ${cell(previous)} | ${cell(notes ?? '')} |`;
}

export function renderMarkdown(range, data, team) {
  const lines = [];
  const monthName = monthNameFromLabel(range.label);
  const owner = process.env.JIRA_EMAIL || '';

  // Title
  lines.push(`# ${monthName} Operational Review [${team.displayName}]`);
  lines.push('');

  // Metadata header
  lines.push('|   |   |');
  lines.push('|---|---|');
  lines.push(`| Team | ${team.displayName} |`);
  lines.push(`| Date | ${fmtDate(new Date())} |`);
  lines.push(`| Review period | ${fmtRange(range.current)} |`);
  lines.push(`| Previous review period | ${fmtRange(range.previous)} |`);
  lines.push(`| Owner | ${owner} |`);
  lines.push('');

  // Team Metrics
  lines.push('## Team Metrics');
  lines.push('');
  lines.push('| Metric | Current Period | Previous Period | Notes/Comments |');
  lines.push('|---|---|---|---|');

  // PagerDuty: combined HU+Total row, plus MTTA, MTTR
  const pd = data.pagerduty || {};
  if (pd.error) {
    lines.push(row('PagerDuty', `error: ${pd.error}`, '', ''));
  } else {
    const pc = pd.current || {};
    const pp = pd.previous || {};
    const huAlertsNotes = [pdHuList(pc.highIncidents), recurringNote(pc.recurringTitles)].filter(Boolean).join('\n');
    lines.push(row(
      'High Urgency PD Alerts<br/>Total PD Alerts',
      `HU: ${num(pc.high)}${deltaCount(pc.high, pp.high)}\nTotal: ${num(pc.total)}${deltaCount(pc.total, pp.total)}`,
      `HU: ${num(pp.high)}\nTotal: ${num(pp.total)}`,
      huAlertsNotes
    ));
    lines.push(row(
      'MTTA<br/>(HU <1h)<br/>(LU <9h)',
      `High: ${formatDuration(pc.mttaHighMs)}${deltaDuration(pc.mttaHighMs, pp.mttaHighMs)}\nLow: ${formatDuration(pc.mttaLowMs)}${deltaDuration(pc.mttaLowMs, pp.mttaLowMs)}`,
      `High: ${formatDuration(pp.mttaHighMs)}\nLow: ${formatDuration(pp.mttaLowMs)}`,
      breachNote(pc.breaches?.mtta)
    ));
    lines.push(row(
      'MTTR<br/>(HU <4h)<br/>(LU <15h)',
      `High: ${formatDuration(pc.mttrHighMs)}${deltaDuration(pc.mttrHighMs, pp.mttrHighMs)}\nLow: ${formatDuration(pc.mttrLowMs)}${deltaDuration(pc.mttrLowMs, pp.mttrLowMs)}`,
      `High: ${formatDuration(pp.mttrHighMs)}\nLow: ${formatDuration(pp.mttrLowMs)}`,
      breachNote(pc.breaches?.mttr)
    ));
  }

  // Jira incidents
  const jira = data.jira || {};
  if (jira.error) {
    lines.push(row('Jira Incidents', `error: ${jira.error}`, '', ''));
  } else {
    const ic = jira.current?.incidents || [];
    const ip = jira.previous?.incidents || [];
    lines.push(row(
      'Jira Incidents',
      num(ic.length) + deltaCount(ic.length, ip.length),
      num(ip.length),
      issueList(ic)
    ));
  }

  // Rollbars: error count in window with open total + top-3 in notes
  const rb = data.rollbar || {};
  if (rb.error) {
    lines.push(row('Rollbars', `error: ${rb.error}`, '', ''));
  } else {
    const cc = rb.current?.count;
    const cp = rb.previous?.count;
    const open = rb.current?.openTotal;
    const top = rb.current?.topByOccurrences;
    const notes = [`Open at end of period: ${num(open)}`, topOccurrencesNote(top)].filter(Boolean).join('\n');
    lines.push(row(
      'Rollbars',
      `Error: ${num(cc)}${deltaCount(cc, cp)}`,
      `Error: ${num(cp)}`,
      notes
    ));
  }

  // GitHub: open Dependabot vulnerabilities + open Dependabot PRs
  const gh = data.github || {};
  if (gh.error) {
    lines.push(row('Vulnerabilities', `error: ${gh.error}`, '', ''));
    lines.push(row('Dependabot PRs', `error: ${gh.error}`, '', ''));
  } else {
    const vc = gh.current?.vulnerabilities || {};
    const vp = gh.previous?.vulnerabilities?.total;
    lines.push(row(
      'Vulnerabilities',
      num(vc.total) + deltaCount(vc.total, vp),
      num(vp),
      vulnsByRepoNote(vc.items)
    ));
    const dp = gh.current?.dependabotPRs || {};
    const pp = gh.previous?.dependabotPRs?.total;
    lines.push(row(
      'Dependabot PRs',
      num(dp.total) + deltaCount(dp.total, pp),
      num(pp),
      prsByRepoNote(dp.items)
    ));
  }

  // Wiz
  const wz = data.wiz || {};
  if (wz.error) {
    lines.push(row('WIZ', `error: ${wz.error}`, '', ''));
  } else if (wz.current?._skipped || wz.current?._todo) {
    lines.push(row('WIZ', wz.current._skipped || wz.current._todo, '', ''));
  } else {
    const wc = wz.current || {};
    lines.push(row(
      'WIZ',
      `Critical: ${num(wc.critical)}\nHigh: ${num(wc.high)}\nMedium: ${num(wc.medium)}`,
      '',
      ''
    ));
  }

  // Bugs (last row, matching the team's template)
  if (!jira.error) {
    const bc = jira.current?.bugs || [];
    const bp = jira.previous?.bugs || [];
    lines.push(row(
      'Bugs',
      num(bc.length) + deltaCount(bc.length, bp.length),
      num(bp.length),
      issueList(bc)
    ));
  }

  lines.push('');
  lines.push('## Service Metrics');
  lines.push('');
  lines.push('## Action Items');
  lines.push('');

  return lines.join('\n');
}

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
  return 'Top by occurrences:\n' + top.map(t => {
    const titlePart = t.url ? `[${t.title}](${t.url})` : `"${t.title}"`;
    return `${titlePart} (${fmt(t.occurrences)})`;
  }).join('\n');
}

function prList(prs, max = 5) {
  if (!prs || !prs.length) return '';
  const sorted = [...prs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const items = sorted.slice(0, max).map(p => `[${p.title}](${p.url}) — ${p.repo}`);
  if (sorted.length > max) items.push(`...and ${sorted.length - max} more`);
  return items.join('\n');
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
      `HU: ${num(pc.high)}\nTotal: ${num(pc.total)}`,
      `HU: ${num(pp.high)}${deltaCount(pc.high, pp.high)}\nTotal: ${num(pp.total)}${deltaCount(pc.total, pp.total)}`,
      huAlertsNotes
    ));
    lines.push(row(
      'MTTA<br/>(HU <1h)<br/>(LU <9h)',
      `High: ${formatDuration(pc.mttaHighMs)}\nLow: ${formatDuration(pc.mttaLowMs)}`,
      `High: ${formatDuration(pp.mttaHighMs)}${deltaDuration(pc.mttaHighMs, pp.mttaHighMs)}\nLow: ${formatDuration(pp.mttaLowMs)}${deltaDuration(pc.mttaLowMs, pp.mttaLowMs)}`,
      breachNote(pc.breaches?.mtta)
    ));
    lines.push(row(
      'MTTR<br/>(HU <4h)<br/>(LU <15h)',
      `High: ${formatDuration(pc.mttrHighMs)}\nLow: ${formatDuration(pc.mttrLowMs)}`,
      `High: ${formatDuration(pp.mttrHighMs)}${deltaDuration(pc.mttrHighMs, pp.mttrHighMs)}\nLow: ${formatDuration(pp.mttrLowMs)}${deltaDuration(pc.mttrLowMs, pp.mttrLowMs)}`,
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
      num(ic.length),
      num(ip.length) + deltaCount(ic.length, ip.length),
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
      `Error: ${num(cc)}`,
      `Error: ${num(cp)}${deltaCount(cc, cp)}`,
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
    lines.push(row(
      'Vulnerabilities',
      num(vc.total),
      '—',
      severityNote(vc.bySeverity)
    ));
    const dp = gh.current?.dependabotPRs || {};
    lines.push(row(
      'Dependabot PRs',
      num(dp.total),
      '—',
      prList(dp.items)
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
      num(bc.length),
      num(bp.length) + deltaCount(bc.length, bp.length),
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

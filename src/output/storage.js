// Confluence storage-format renderer. Storage format is a stricter XML
// dialect of XHTML — tags must be well-formed (e.g. <br/> self-closes), the
// document is body-content only (no DOCTYPE/head/style), and Confluence
// applies its own page styling. Inline <span style> survives storage-format
// roundtrip well enough for our deltas.

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
  // Convert \n line separators to self-closing <br/> for storage format.
  return String(s).split('\n').map(esc).join('<br/>');
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
  // Use Confluence's Jira issue macro: renders inline as the issue type icon
  // + key + current status (e.g. "DONE" / "IN PROGRESS"), pulled live from Jira.
  return issues.map(i =>
    `<ac:structured-macro ac:name="jira" ac:schema-version="1"><ac:parameter ac:name="key">${esc(i.key)}</ac:parameter></ac:structured-macro>`
  ).join('<br/>');
}

function pdHuList(incidents) {
  if (!incidents || !incidents.length) return '';
  // Plain <a> rather than smart-link form: when the PagerDuty integration
  // isn't connected to the space, Confluence's smart-link fallback renders
  // the URL + a "Connect your account" button instead of our link text,
  // which makes the page unreadable. Plain links just show the title.
  return 'HU incidents:<br/>' + incidents.map(i =>
    `<a href="${esc(i.url)}">${esc(i.title)}</a>`
  ).join('<br/>');
}

function recurringNote(titles) {
  if (!titles || !titles.length) return '';
  // Plain <a> for the same reason as pdHuList — the smart-link form drops
  // a "Connect your account" prompt where the title should render.
  if (titles.some(t => t.url)) {
    return 'Top recurring:<br/>' + titles.map(t => {
      const titlePart = t.url
        ? `<a href="${esc(t.url)}">${esc(t.title)}</a>`
        : `"${esc(t.title)}"`;
      return `${titlePart} (${t.count}x)`;
    }).join('<br/>');
  }
  return 'Top recurring:\n' + titles.map(t => `"${t.title}" (${t.count}x)`).join('\n');
}

function breachNote(b) {
  if (!b) return '';
  const parts = [];
  if (b.high > 0) parts.push(`HU ${b.high}`);
  if (b.low > 0) parts.push(`LU ${b.low}`);
  if (!parts.length) return 'Within SLO';
  const head = 'SLO breaches: ' + parts.join(', ');
  if (!b.top || !b.top.length) return head;
  // Plain <a> rather than smart-link form — same reason as pdHuList: Confluence
  // shows a "Connect your account" prompt instead of our link text otherwise.
  const lines = b.top.map(t => {
    const tag = t.urgency === 'high' ? 'HU' : 'LU';
    return `<a href="${esc(t.url)}">${esc(t.title)}</a> (${tag} +${esc(formatDuration(t.overshootMs))} over)`;
  });
  return head + '<br/>' + lines.join('<br/>');
}

function topOccurrencesNote(top) {
  if (!top || !top.length) return '';
  const fmt = n => n.toLocaleString('en-US');
  return 'Top by occurrences:<br/>' + top.map(t => {
    const titlePart = t.url
      ? `<a href="${esc(t.url)}">${esc(t.title)}</a>`
      : `"${t.title}"`;
    return `${titlePart} (${fmt(t.occurrences)})`;
  }).join('<br/>');
}

const SEVERITY_COLOR = { critical: '#990000', high: '#d04437', medium: '#e8a200', low: '#36b37e' };

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
      return `<a href="https://github.com/${esc(repo)}/security/dependabot">${esc(repo)}</a>: ${total} (${parts.join(', ')})`;
    })
    .join('<br/>');
}

function prsByRepoNote(items) {
  if (!items || !items.length) return '';
  const counts = new Map();
  for (const p of items) counts.set(p.repo, (counts.get(p.repo) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([repo, n]) =>
      `<a href="https://github.com/${esc(repo)}/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot">${esc(repo)}</a>: ${n}`
    )
    .join('<br/>');
}

// If the cell already contains pre-built markup, normalise <br>→<br/> so the
// payload stays well-formed XML; if it's plain text with \n, escape and
// convert; null becomes em-dash. ac:/ri: prefixes preserve Confluence
// macros (e.g. the Jira issue macro).
function asCell(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/<(br|span|a|ac:|ri:)/i.test(s)) {
    return s.replace(/<br\s*\/?>(?!\s*\/)/gi, '<br/>').replace(/\n/g, '<br/>');
  }
  return multiline(s);
}

function row(metric, current, previous, notes) {
  return `<tr><td>${asCell(metric)}</td><td>${asCell(current)}</td><td>${asCell(previous)}</td><td>${asCell(notes)}</td></tr>`;
}

export function renderStorage(range, data, team, { chartFilenames = [], ownerAccountId = null } = {}) {
  const monthName = monthNameFromLabel(range.label);
  const ownerCell = ownerAccountId
    ? `<ac:link><ri:user ri:account-id="${esc(ownerAccountId)}"/></ac:link>`
    : esc(process.env.JIRA_EMAIL || '');

  const out = [];

  // Metadata table (2-col, no header row)
  out.push('<table>');
  out.push('<tbody>');
  out.push(`<tr><th>Team</th><td>${esc(team.displayName)}</td></tr>`);
  out.push(`<tr><th>Date</th><td>${esc(fmtDate(new Date()))}</td></tr>`);
  out.push(`<tr><th>Review period</th><td>${esc(fmtRange(range.current))}</td></tr>`);
  out.push(`<tr><th>Previous review period</th><td>${esc(fmtRange(range.previous))}</td></tr>`);
  out.push(`<tr><th>Owner</th><td>${ownerCell}</td></tr>`);
  out.push('</tbody></table>');

  // Team Metrics — explicit column widths so the Notes column gets the
  // lion's share of the row. Confluence Cloud uses pixel widths with a
  // data-table-width attribute on the <table>; percentages get ignored.
  out.push('<h2>Team Metrics</h2>');
  out.push('<table data-table-width="1200" data-layout="wide">');
  out.push('<colgroup>');
  out.push('<col style="width: 160.0px;" />');
  out.push('<col style="width: 180.0px;" />');
  out.push('<col style="width: 180.0px;" />');
  out.push('<col style="width: 680.0px;" />');
  out.push('</colgroup>');
  out.push('<tbody>');
  out.push('<tr><th>Metric</th><th>Current Period</th><th>Previous Period</th><th>Notes/Comments</th></tr>');

  const pd = data.pagerduty || {};
  if (pd.error) {
    out.push(row('PagerDuty', `error: ${pd.error}`, '', ''));
  } else {
    const pc = pd.current || {};
    const pp = pd.previous || {};
    const huAlertsNotes = [pdHuList(pc.highIncidents), recurringNote(pc.recurringTitles)].filter(Boolean).join('\n');
    out.push(row(
      'High Urgency PD Alerts<br/>Total PD Alerts',
      `HU: ${num(pc.high)}${deltaCount(pc.high, pp.high)}\nTotal: ${num(pc.total)}${deltaCount(pc.total, pp.total)}`,
      `HU: ${num(pp.high)}\nTotal: ${num(pp.total)}`,
      huAlertsNotes
    ));
    out.push(row(
      'MTTA<br/>(HU &lt;1h)<br/>(LU &lt;9h)',
      `High: ${esc(formatDuration(pc.mttaHighMs))}${deltaDuration(pc.mttaHighMs, pp.mttaHighMs)}\nLow: ${esc(formatDuration(pc.mttaLowMs))}${deltaDuration(pc.mttaLowMs, pp.mttaLowMs)}`,
      `High: ${esc(formatDuration(pp.mttaHighMs))}\nLow: ${esc(formatDuration(pp.mttaLowMs))}`,
      breachNote(pc.breaches?.mtta)
    ));
    out.push(row(
      'MTTR<br/>(HU &lt;4h)<br/>(LU &lt;15h)',
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
    const vp = gh.previous?.vulnerabilities?.total;
    out.push(row(
      'Vulnerabilities',
      num(vc.total) + deltaCount(vc.total, vp),
      num(vp),
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

  out.push('</tbody>');
  out.push('</table>');

  // Trends — image refs for chart attachments uploaded separately to the page.
  // Confluence renders these inline once the matching attachment exists.
  if (chartFilenames.length) {
    out.push('<h2>Trends</h2>');
    for (const filename of chartFilenames) {
      out.push(`<p><ac:image ac:align="center" ac:width="640"><ri:attachment ri:filename="${esc(filename)}"/></ac:image></p>`);
    }
  }

  out.push('<h2>Service Metrics</h2>');
  out.push('<h2>Action Items</h2>');

  return out.join('\n');
}

export function renderStorageTitle(range, team) {
  return `${monthNameFromLabel(range.label)} Operational Review [${team.displayName}]`;
}

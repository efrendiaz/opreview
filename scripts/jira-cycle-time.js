#!/usr/bin/env node
// Cycle-time analysis for a set of Jira tickets: how long they take to go from
// the first time they enter "In Progress" to reaching "Done", plus the cycle
// time of their linked GitHub PRs (time to merge, time to first review).
//
//   node scripts/jira-cycle-time.js [--jql "<JQL>"] [--keys ORNG-1,ORNG-2] [--label "Localization"]
//
// With no --jql/--keys it defaults to the Oranges localization-maintenance JQL
// (title match, migration excluded, this year). Status timing comes from each
// issue's changelog; PR links come from Jira's dev-status (the GitHub dev
// panel), then each PR's created/merged/review timestamps come from GitHub.
//
// Durations are reported as average AND median/p75/max (the median resists a
// single ticket parked for weeks).

import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';

const DEFAULT_JQL = `project = ORNG AND (summary ~ "localiz*" OR summary ~ "localis*" OR summary ~ "translat*" OR summary ~ "typo" OR summary ~ "re-pull" OR summary ~ "locale") AND NOT (summary ~ "smartcat" OR summary ~ "lokalise" OR summary ~ "storage") AND created >= "2026-01-01" ORDER BY created DESC`;

// --- Jira ---
function jiraHeaders() {
  const { JIRA_EMAIL, JIRA_TOKEN } = process.env;
  if (!JIRA_EMAIL || !JIRA_TOKEN) throw new Error('JIRA_EMAIL / JIRA_TOKEN not set in .env');
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}

async function jiraSearch(jql) {
  const base = process.env.JIRA_BASE_URL;
  const headers = jiraHeaders();
  let token = null;
  const all = [];
  do {
    const body = { jql, fields: ['summary', 'status', 'created'], maxResults: 100 };
    if (token) body.nextPageToken = token;
    const r = await fetch(`${base}/rest/api/3/search/jql`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Jira search → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    all.push(...(j.issues || []));
    token = j.isLast ? null : j.nextPageToken;
  } while (token);
  return all;
}

async function jiraIssuesByKeys(keys) {
  const jql = `key in (${keys.join(',')}) ORDER BY created DESC`;
  return jiraSearch(jql);
}

// First entry into "In Progress" and first arrival at "Done", from the issue's
// status-change history. Returns ms between them (or null if either is absent).
async function statusTiming(key) {
  const base = process.env.JIRA_BASE_URL;
  const r = await fetch(`${base}/rest/api/3/issue/${key}?expand=changelog&fields=created`, { headers: jiraHeaders() });
  if (!r.ok) throw new Error(`Jira issue ${key} → ${r.status}`);
  const j = await r.json();
  const transitions = [];
  for (const h of (j.changelog?.histories || [])) {
    for (const it of h.items) {
      if (it.field === 'status') transitions.push({ at: new Date(h.created).getTime(), from: it.fromString, to: it.toString });
    }
  }
  transitions.sort((a, b) => a.at - b.at);
  const firstInProgress = transitions.find(t => t.to === 'In Progress')?.at ?? null;
  const doneAt = firstInProgress == null
    ? null
    : (transitions.find(t => t.to === 'Done' && t.at >= firstInProgress)?.at ?? null);

  // Total time parked in "Blocked": sum each (enter Blocked → leave Blocked)
  // interval. A ticket can be blocked more than once.
  let blockedMs = 0, blockedCount = 0, blockStart = null;
  for (const t of transitions) {
    if (t.to === 'Blocked') blockStart = t.at;
    else if (t.from === 'Blocked' && blockStart != null) { blockedMs += t.at - blockStart; blockedCount++; blockStart = null; }
  }

  return {
    inProgressAt: firstInProgress,
    doneAt,
    cycleMs: (firstInProgress != null && doneAt != null) ? doneAt - firstInProgress : null,
    blockedMs: blockedCount ? blockedMs : null,
    blockedCount
  };
}

// Linked PRs from Jira's dev-status (GitHub dev panel). Returns [{status, url}].
async function linkedPRs(issueId) {
  const base = process.env.JIRA_BASE_URL;
  const r = await fetch(`${base}/rest/dev-status/latest/issue/detail?issueId=${issueId}&applicationType=GitHub&dataType=pullrequest`, { headers: jiraHeaders() });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.detail?.[0]?.pullRequests || []).map(pr => ({ status: pr.status, url: pr.url }));
}

// --- GitHub ---
function ghHeaders() {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set in .env');
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'opreview-jira-cycle-time'
  };
}

function parsePrUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

async function ghJson(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}`);
  return r.json();
}

// Time-to-merge and time-to-first-review (by someone other than the author) for
// one PR. Either may be null (not merged / never reviewed).
async function prMetrics(url) {
  const p = parsePrUrl(url);
  if (!p) return null;
  const pr = await ghJson(`/repos/${p.owner}/${p.repo}/pulls/${p.number}`);
  const created = new Date(pr.created_at).getTime();
  const mergeMs = pr.merged_at ? new Date(pr.merged_at).getTime() - created : null;
  let reviews = [];
  try { reviews = await ghJson(`/repos/${p.owner}/${p.repo}/pulls/${p.number}/reviews?per_page=100`); } catch { /* ignore */ }
  const firstReview = reviews
    .filter(r => r.submitted_at && r.user && r.user.login !== pr.user?.login)
    .map(r => new Date(r.submitted_at).getTime())
    .sort((a, b) => a - b)[0];
  return {
    repo: `${p.owner}/${p.repo}`, number: p.number, state: pr.state, merged: !!pr.merged_at,
    mergeMs, reviewMs: firstReview ? firstReview - created : null
  };
}

// --- stats / format ---
function percentile(sorted, pct) {
  if (!sorted.length) return null;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
function stats(arr) {
  const s = arr.filter(v => v != null).sort((a, b) => a - b);
  if (!s.length) return { count: 0, avg: null, median: null, p75: null, max: null };
  return {
    count: s.length,
    avg: s.reduce((a, b) => a + b, 0) / s.length,
    median: percentile(s, 50), p75: percentile(s, 75), max: s[s.length - 1]
  };
}
function fmtDur(ms) {
  if (ms == null) return 'N/A';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseArgs(argv) {
  const args = { jql: undefined, keys: [], label: 'Localization', out: 'out' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jql') args.jql = argv[++i];
    else if (a === '--keys') args.keys.push(...argv[++i].split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') { console.log('Usage: node scripts/jira-cycle-time.js [--jql "<JQL>" | --keys K1,K2] [--label NAME]'); process.exit(0); }
  }
  return args;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = process.env.JIRA_BASE_URL;
  const fetched = args.keys.length ? await jiraIssuesByKeys(args.keys) : await jiraSearch(args.jql || DEFAULT_JQL);

  // Only completed work: drop To Do / In Progress / anything not Done.
  const issues = fetched.filter(i => (i.fields?.status?.name || '') === 'Done');
  console.error(`Jira cycle-time — ${args.label} (${issues.length} Done tickets; ${fetched.length - issues.length} non-Done excluded)`);

  const rows = await mapPool(issues, 5, async (iss) => {
    const timing = await statusTiming(iss.key);
    const prRefs = await linkedPRs(iss.id);
    const prs = (await Promise.all(prRefs.map(p => prMetrics(p.url).catch(() => null)))).filter(Boolean);
    return {
      key: iss.key, id: iss.id,
      summary: iss.fields?.summary || '',
      status: iss.fields?.status?.name || '',
      cycleMs: timing.cycleMs,
      blockedMs: timing.blockedMs,
      blockedCount: timing.blockedCount,
      prs
    };
  });

  const cycle = stats(rows.map(r => r.cycleMs));
  const blockedRows = rows.filter(r => r.blockedMs != null);
  const blockedStats = stats(blockedRows.map(r => r.blockedMs));
  const allPrs = rows.flatMap(r => r.prs);
  const prMerge = stats(allPrs.map(p => p.mergeMs));
  const prReview = stats(allPrs.map(p => p.reviewMs));

  // Console summary
  console.error('');
  console.error(`In Progress → Done:  avg ${fmtDur(cycle.avg)} · median ${fmtDur(cycle.median)} · p75 ${fmtDur(cycle.p75)} · max ${fmtDur(cycle.max)} (n=${cycle.count})`);
  console.error(`PR time to merge:     avg ${fmtDur(prMerge.avg)} · median ${fmtDur(prMerge.median)} · max ${fmtDur(prMerge.max)} (n=${prMerge.count})`);
  console.error(`PR time to 1st review: avg ${fmtDur(prReview.avg)} · median ${fmtDur(prReview.median)} · max ${fmtDur(prReview.max)} (n=${prReview.count})`);
  console.error(`Blocked: ${blockedRows.length} of ${rows.length} tickets · median ${fmtDur(blockedStats.median)} · max ${fmtDur(blockedStats.max)}`);
  console.error(`Linked PRs: ${allPrs.length} across ${rows.filter(r => r.prs.length).length} tickets`);

  // HTML report
  const trip = st => st.count ? `${fmtDur(st.median)} <span class="muted">/ ${fmtDur(st.p75)} / ${fmtDur(st.max)}</span>` : '<span class="muted">—</span>';
  const ticketRows = rows.map(r => {
    const prCell = r.prs.length
      ? r.prs.map(p => `<a href="https://github.com/${esc(p.repo)}/pull/${p.number}">${esc(p.repo.split('/')[1])}#${p.number}</a> <span class="muted">(${p.merged ? 'merge ' + fmtDur(p.mergeMs) : p.state}${p.reviewMs != null ? ', review ' + fmtDur(p.reviewMs) : ''})</span>`).join('<br>')
      : '<span class="muted">none</span>';
    const blockedCell = r.blockedMs != null
      ? `Yes <span class="muted">(${fmtDur(r.blockedMs)}${r.blockedCount > 1 ? `, ${r.blockedCount}×` : ''})</span>`
      : '<span class="muted">No</span>';
    return `
        <tr>
          <td><a href="${esc(base)}/browse/${esc(r.key)}">${esc(r.key)}</a></td>
          <td>${esc(r.summary)}</td>
          <td class="num strong">${r.cycleMs != null ? fmtDur(r.cycleMs) : '<span class="muted">—</span>'}</td>
          <td>${blockedCell}</td>
          <td>${prCell}</td>
        </tr>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Jira cycle-time — ${esc(args.label)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:#172b4d; margin:32px auto; max-width:1000px; padding:0 16px; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:24px 0 8px; }
  .meta { color:#5e6c84; font-size:13px; margin-bottom:16px; }
  table { border-collapse:collapse; width:100%; margin-top:8px; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #ebecf0; vertical-align:top; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.03em; color:#5e6c84; border-bottom:2px solid #dfe1e6; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .strong { font-weight:600; } .muted { color:#97a0af; font-weight:400; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin:12px 0; }
  .card { flex:1 1 200px; border:1px solid #dfe1e6; border-radius:8px; padding:12px 14px; }
  .card .k { font-size:12px; color:#5e6c84; text-transform:uppercase; letter-spacing:.03em; }
  .card .v { font-size:24px; font-weight:600; margin-top:2px; }
  .card .sub { font-size:12px; color:#97a0af; margin-top:2px; }
  .note { background:#f4f5f7; border-radius:6px; padding:10px 14px; font-size:13px; color:#44546f; margin-top:16px; }
</style></head><body>
  <h1>Jira cycle-time — ${esc(args.label)}</h1>
  <div class="meta">${issues.length} Done tickets · status timing from issue changelog · PRs from the Jira GitHub dev panel</div>
  <div class="cards">
    <div class="card"><div class="k">In Progress → Done</div><div class="v">${fmtDur(cycle.median)}</div><div class="sub">avg ${fmtDur(cycle.avg)} · p75 ${fmtDur(cycle.p75)} · max ${fmtDur(cycle.max)} · n=${cycle.count}</div></div>
    <div class="card"><div class="k">PR time to merge</div><div class="v">${fmtDur(prMerge.median)}</div><div class="sub">avg ${fmtDur(prMerge.avg)} · max ${fmtDur(prMerge.max)} · n=${prMerge.count}</div></div>
    <div class="card"><div class="k">PR time to 1st review</div><div class="v">${fmtDur(prReview.median)}</div><div class="sub">avg ${fmtDur(prReview.avg)} · max ${fmtDur(prReview.max)} · n=${prReview.count}</div></div>
    <div class="card"><div class="k">Blocked at some point</div><div class="v">${blockedRows.length} / ${rows.length}</div><div class="sub">median ${fmtDur(blockedStats.median)} · max ${fmtDur(blockedStats.max)} blocked</div></div>
  </div>
  <h2>Done tickets</h2>
  <table>
    <thead><tr><th>Key</th><th>Summary</th><th class="num">In Progress → Done</th><th>Blocked (time)</th><th>PRs (merge / first review)</th></tr></thead>
    <tbody>${ticketRows}
    </tbody>
  </table>
  <div class="note">
    "In Progress → Done" = from the first time the ticket entered <em>In Progress</em> to the first time it reached <em>Done</em>
    (includes any Blocked / In Review / QA time in between — i.e. real elapsed time, not active work).
    Tickets that never entered In Progress or never reached Done show "—" and are excluded from the average.
    Durations: median / p75 / max. PR "first review" counts the earliest formal review by someone other than the author.
  </div>
</body></html>`;

  await mkdir(args.out, { recursive: true });
  const slug = args.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const outPath = `${args.out}/jira-cycle-time-${slug}.html`;
  await writeFile(outPath, html);
  console.error('');
  console.error(`Wrote ${outPath}`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });

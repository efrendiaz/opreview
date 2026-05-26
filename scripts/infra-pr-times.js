#!/usr/bin/env node
// One-off analysis: how long do a team's PRs take in the shared infrastructure
// repos, to see whether those PRs are a bottleneck in the dev process.
//
//   node scripts/infra-pr-times.js --team oranges [--months 3]
//
// Repos come from `infraRepos` in teams.json. "The team's PRs" = PRs whose
// author is a member of the team's GitHub team (org/<team-slug>), fetched live
// from the GitHub team membership API; override with `githubMembers` in
// teams.json if you'd rather pin the list.
//
// Three metrics, all reported as median / p75 / max (medians beat averages
// here — one PR forgotten for 60 days would wreck an average):
//   1. Time to merge       created -> merged_at, for PRs merged in the window
//   2. Time to first review created -> earliest review by someone other than
//                           the author (the cross-team wait that usually IS
//                           the bottleneck)
//   3. Time open now        age of the team's PRs still open today (backlog)

import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { loadTeam } from '../src/teams.js';

const API = 'https://api.github.com';

function ghHeaders() {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set in .env');
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'opreview-infra-pr-times'
  };
}

async function ghFetch(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`GitHub ${pathOrUrl} → ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return { data: await res.json(), link: res.headers.get('Link') };
}

function nextUrl(link) {
  if (!link) return null;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function ghPaginate(path) {
  let url = path;
  const all = [];
  while (url) {
    const { data, link } = await ghFetch(url);
    if (Array.isArray(data)) all.push(...data);
    else if (Array.isArray(data?.items)) all.push(...data.items);
    url = nextUrl(link);
  }
  return all;
}

// PRs sorted by created desc, stopping once we pass the window start. /pulls
// can't filter by author, so we pull everything in the window and filter
// client-side.
async function fetchPRsCreatedSince(repo, sinceMs) {
  let url = `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`;
  const all = [];
  while (url) {
    const { data, link } = await ghFetch(url);
    let stop = false;
    for (const pr of data) {
      if (new Date(pr.created_at).getTime() < sinceMs) { stop = true; break; }
      all.push(pr);
    }
    if (stop) break;
    url = nextUrl(link);
  }
  return all;
}

async function firstReviewMs(repo, number, author) {
  const reviews = await ghPaginate(`/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  const times = reviews
    .filter(r => r.submitted_at && r.user && r.user.login !== author)
    .map(r => new Date(r.submitted_at).getTime());
  return times.length ? Math.min(...times) : null;
}

async function teamMembers(org, slug) {
  const members = await ghPaginate(`/orgs/${org}/teams/${slug}/members?per_page=100`);
  return new Set(members.map(m => m.login));
}

// Run async mapper over items with bounded concurrency so we don't fan out
// hundreds of review calls at once.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function stats(msArr) {
  const s = [...msArr].sort((a, b) => a - b);
  return {
    count: s.length,
    median: percentile(s, 50),
    p75: percentile(s, 75),
    max: s.length ? s[s.length - 1] : null
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
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(num, den) {
  return den ? `${Math.round((num / den) * 100)}%` : '—';
}

function parseArgs(argv) {
  const args = { teams: [], months: 3, since: undefined, out: 'out', label: undefined, exclude: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--team' || a === '--teams') args.teams.push(...argv[++i].split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--months') args.months = Number(argv[++i]);
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--ytd') args.since = `${new Date().getUTCFullYear()}-01-01`;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--exclude') args.exclude.push(...argv[++i].split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/infra-pr-times.js --teams oranges,pineapples [--label "RnG Web"] [--months 3 | --since YYYY-MM-DD | --ytd] [--exclude user1,user2]');
      process.exit(0);
    }
  }
  return args;
}

function statLine(label, st) {
  if (!st.count) return `${label}: no data`;
  return `${label}: median ${fmtDur(st.median)}, p75 ${fmtDur(st.p75)}, max ${fmtDur(st.max)} (n=${st.count})`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.teams.length) throw new Error('Pass --teams oranges,pineapples (comma-separated)');
  const org = process.env.GITHUB_ORG || 'lessonnine';

  // Resolve every team, then union their members and infra repos so the
  // analysis treats them as one group (e.g. both squads of RnG Web). Members
  // come from each team's GitHub team membership unless pinned in teams.json.
  // `excludeMembers` (per team) + --exclude drop GitHub-team entries that
  // aren't really on the squad (managers from other orgs, bots, etc.).
  const teams = await Promise.all(args.teams.map(loadTeam));
  const members = new Set();
  const infraSet = new Set();
  const excluded = new Set(args.exclude);
  for (const team of teams) {
    const slug = team.githubTeamSlug || team.name;
    const list = team.githubMembers ? new Set(team.githubMembers) : await teamMembers(org, slug);
    for (const m of list) members.add(m);
    for (const r of (team.infraRepos || [])) infraSet.add(r);
    for (const m of (team.excludeMembers || [])) excluded.add(m);
  }
  for (const m of excluded) members.delete(m);
  const infraRepos = [...infraSet];
  if (!infraRepos.length) {
    throw new Error(`No infraRepos configured for teams "${args.teams.join(', ')}" in teams.json`);
  }

  const label = args.label || teams.map(t => t.displayName).join(' + ');
  const outSlug = (args.label ? args.label : args.teams.join('-'))
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let since;
  if (args.since) {
    since = new Date(`${args.since}T00:00:00Z`);
    if (isNaN(since.getTime())) throw new Error(`Invalid --since "${args.since}", expected YYYY-MM-DD`);
  } else {
    since = new Date();
    since.setMonth(since.getMonth() - args.months);
  }
  const sinceMs = since.getTime();
  const nowMs = Date.now();
  const windowDesc = args.since ? `since ${args.since}` : `${args.months} months`;

  console.error(`Infra PR cycle-time — ${label}`);
  console.error(`  window:  ${since.toISOString().slice(0, 10)} → today (${windowDesc})`);
  console.error(`  members (${members.size}): ${[...members].join(', ')}`);
  console.error(`  repos:   ${infraRepos.join(', ')}`);
  console.error('');

  const perRepo = [];
  const allMerge = [];
  const allReview = [];
  const allOpen = [];
  const openPRs = []; // for the backlog listing

  for (const repo of infraRepos) {
    process.stderr.write(`  ${repo}... `);
    const [windowPRs, openAll] = await Promise.all([
      fetchPRsCreatedSince(repo, sinceMs),
      ghPaginate(`/repos/${repo}/pulls?state=open&per_page=100`)
    ]);

    const cohort = windowPRs.filter(p => members.has(p.user?.login));
    const openMine = openAll.filter(p => members.has(p.user?.login));

    const mergeMs = cohort
      .filter(p => p.merged_at)
      .map(p => new Date(p.merged_at).getTime() - new Date(p.created_at).getTime());

    const reviewFirst = await mapPool(cohort, 6, p =>
      firstReviewMs(repo, p.number, p.user?.login)
    );
    const reviewMs = reviewFirst
      .map((t, idx) => (t == null ? null : t - new Date(cohort[idx].created_at).getTime()))
      .filter(v => v != null);

    for (const p of openMine) {
      const age = nowMs - new Date(p.created_at).getTime();
      allOpen.push(age);
      openPRs.push({ repo, number: p.number, title: p.title, url: p.html_url, author: p.user?.login, ageMs: age });
    }
    allMerge.push(...mergeMs);
    allReview.push(...reviewMs);

    perRepo.push({
      repo,
      opened: cohort.length,
      merged: mergeMs.length,
      reviewed: reviewMs.length,
      open: openMine.length,
      merge: stats(mergeMs),
      review: stats(reviewMs),
      openAge: stats(openMine.map(p => nowMs - new Date(p.created_at).getTime()))
    });
    process.stderr.write(`✓ (${cohort.length} team PRs in window, ${openMine.length} open now)\n`);
  }

  const global = {
    opened: perRepo.reduce((s, r) => s + r.opened, 0),
    merged: allMerge.length,
    reviewed: allReview.length,
    open: openPRs.length,
    merge: stats(allMerge),
    review: stats(allReview),
    openAge: stats(allOpen)
  };

  // Console summary
  console.error('');
  console.error(`GLOBAL — ${global.opened} team PRs opened in window across ${infraRepos.length} infra repos`);
  console.error(`  merged in window: ${global.merged} | got a review: ${global.reviewed} | open now: ${global.open}`);
  console.error('  ' + statLine('Time to merge      ', global.merge));
  console.error('  ' + statLine('Time to first review', global.review));
  console.error('  ' + statLine('Age of open PRs    ', global.openAge));

  // HTML report
  const repoUrl = r => `https://github.com/${r}`;
  const trip = st => st.count
    ? `${fmtDur(st.median)} <span class="muted">/ ${fmtDur(st.p75)} / ${fmtDur(st.max)}</span>`
    : '<span class="muted">—</span>';

  // Sort repos by PR volume so the busiest infra repo leads.
  const repoRows = [...perRepo].sort((a, b) => b.opened - a.opened).map(r => `
        <tr>
          <td><a href="${esc(repoUrl(r.repo))}">${esc(r.repo)}</a></td>
          <td class="num strong">${r.opened}</td>
          <td class="num">${r.merged} <span class="muted">(${pct(r.merged, r.opened)})</span></td>
          <td class="num">${r.reviewed} <span class="muted">(${pct(r.reviewed, r.opened)})</span></td>
          <td class="num">${r.open}</td>
          <td>${trip(r.merge)}</td>
          <td>${trip(r.review)}</td>
        </tr>`).join('');

  const openRows = openPRs.length
    ? openPRs.sort((a, b) => b.ageMs - a.ageMs).map(p => `
        <tr>
          <td class="num strong">${fmtDur(p.ageMs)}</td>
          <td><a href="${esc(p.url)}">#${p.number} ${esc(p.title)}</a></td>
          <td>${esc(p.author)}</td>
          <td>${esc(p.repo)}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="muted">None — no team PRs are open in these repos right now.</td></tr>';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Infra PR cycle-time — ${esc(label)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172b4d; margin: 32px auto; max-width: 960px; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  .meta { color: #5e6c84; font-size: 13px; margin-bottom: 16px; }
  .meta code { background: #f4f5f7; padding: 1px 5px; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #ebecf0; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #5e6c84; border-bottom: 2px solid #dfe1e6; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .strong { font-weight: 600; }
  .muted { color: #97a0af; font-weight: 400; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
  .card { flex: 1 1 180px; border: 1px solid #dfe1e6; border-radius: 8px; padding: 12px 14px; }
  .card .k { font-size: 12px; color: #5e6c84; text-transform: uppercase; letter-spacing: .03em; }
  .card .v { font-size: 24px; font-weight: 600; margin-top: 2px; }
  .card .sub { font-size: 12px; color: #97a0af; margin-top: 2px; }
  .note { background: #f4f5f7; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #44546f; margin-top: 16px; }
</style>
</head>
<body>
  <h1>Infra PR cycle-time — ${esc(label)}</h1>
  <div class="meta">
    Window <strong>${since.toISOString().slice(0, 10)} → ${new Date(nowMs).toISOString().slice(0, 10)}</strong> (${windowDesc})
    · ${members.size} members · ${infraRepos.length} infra repos<br>
    Repos: ${infraRepos.map(r => `<code>${esc(r)}</code>`).join(' ')}<br>
    Members: ${[...members].map(m => `<code>${esc(m)}</code>`).join(' ')}
  </div>

  <div class="cards">
    <div class="card"><div class="k">PRs opened</div><div class="v">${global.opened}</div><div class="sub">${global.merged} merged · ${global.open} open now</div></div>
    <div class="card"><div class="k">Time to merge</div><div class="v">${fmtDur(global.merge.median)}</div><div class="sub">p75 ${fmtDur(global.merge.p75)} · max ${fmtDur(global.merge.max)}</div></div>
    <div class="card"><div class="k">Time to first review</div><div class="v">${fmtDur(global.review.median)}</div><div class="sub">p75 ${fmtDur(global.review.p75)} · max ${fmtDur(global.review.max)}</div></div>
    <div class="card"><div class="k">Reviewed</div><div class="v">${pct(global.reviewed, global.opened)}</div><div class="sub">${global.reviewed} of ${global.opened} got a review</div></div>
  </div>

  <h2>By infra repo</h2>
  <table>
    <thead>
      <tr>
        <th>Repo</th><th class="num">PRs opened</th><th class="num">Merged</th><th class="num">Reviewed</th><th class="num">Open now</th>
        <th>Time to merge<br><span class="muted">med / p75 / max</span></th>
        <th>First review<br><span class="muted">med / p75 / max</span></th>
      </tr>
    </thead>
    <tbody>${repoRows}
    </tbody>
  </table>

  <h2>Open PRs today (oldest first)</h2>
  <table>
    <thead><tr><th class="num">Age</th><th>PR</th><th>Author</th><th>Repo</th></tr></thead>
    <tbody>${openRows}
    </tbody>
  </table>

  <div class="note">
    Cohort = PRs opened by team members in the window; <em>merged</em>/<em>reviewed</em> are subsets of it.
    Durations are <strong>median / p75 / max</strong> (median resists the long tail of a forgotten PR).
    "First review" counts the earliest formal review (approve / comment / request-changes) by someone other than the author —
    plain conversation comments aren't included.
  </div>
</body>
</html>`;

  await mkdir(args.out, { recursive: true });
  const outPath = `${args.out}/infra-pr-times-${outSlug}.html`;
  await writeFile(outPath, html);
  console.error('');
  console.error(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { getDateRange, getHistoryRanges } from './config.js';
import { loadTeam, listTeams } from './teams.js';
import { fetchPagerDuty, fetchPagerDutyHistory, formatDuration } from './sources/pagerduty.js';
import { fetchJira, fetchJiraHistory } from './sources/jira.js';
import { fetchRollbar, fetchRollbarHistory } from './sources/rollbar.js';
import { fetchWiz } from './sources/wiz.js';
import { fetchGitHub, fetchGitHubHistory } from './sources/github.js';
import { renderMarkdown } from './output/markdown.js';
import { renderHtml } from './output/html.js';
import { renderStorage, renderStorageTitle } from './output/storage.js';
import { renderTrendCharts, svgToPng } from './output/charts.js';
import { checkAccess as confluenceCheckAccess, publishPage, pageWebUrl, uploadAttachment, getCurrentUser } from './confluence.js';

function parseArgs(argv) {
  const args = { month: undefined, only: undefined, team: undefined, out: 'out', listTeams: false, checkConfluence: false, publish: false, history: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--only') args.only = argv[++i].split(',').map(s => s.trim());
    else if (a === '--team') args.team = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--list-teams') args.listTeams = true;
    else if (a === '--check-confluence') args.checkConfluence = true;
    else if (a === '--publish') args.publish = true;
    else if (a === '--history') args.history = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: opreview --team <name> [options]

Options:
  --team NAME         Team to run for (required for most actions). See teams.json.
  --month YYYY-MM     Review period (default: last full month)
  --only LIST         Comma-separated sources to run: pagerduty,jira,rollbar,github,wiz
  --out DIR           Output directory (default: ./out)
  --list-teams        List configured teams and exit
  --check-confluence  Verify Confluence API auth and parent folder access for --team
  --publish           Publish the review to Confluence (create or update by title)
  --history N         Fetch the last N months of trend data (default: 6, 0 to disable)
  -h, --help          Show this help

Example:
  opreview --team team-a --month 2026-04
  opreview --team team-a --only pagerduty,jira
  opreview --team team-a --check-confluence
  opreview --team team-a --month 2026-04 --publish
`);
      process.exit(0);
    }
  }
  return args;
}

// Wraps a source function so a single-source failure doesn't kill the run.
async function safe(name, fn) {
  process.stderr.write(`  ${name}... `);
  try {
    const result = await fn();
    process.stderr.write('✓\n');
    return result;
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    return { error: err.message };
  }
}

const SOURCES = {
  pagerduty: fetchPagerDuty,
  jira: fetchJira,
  rollbar: fetchRollbar,
  github: fetchGitHub,
  wiz: fetchWiz
};

async function main() {
  const args = parseArgs(process.argv);

  if (args.listTeams) {
    const names = await listTeams();
    for (const n of names) console.log(n);
    return;
  }

  if (args.checkConfluence) {
    const team = await loadTeam(args.team);
    console.error(`Confluence access check — ${team.displayName}`);
    const { user, folder, space } = await confluenceCheckAccess(team);
    console.log(`✓ Auth OK as ${user.displayName}${user.email ? ` <${user.email}>` : ''}`);
    console.log(`✓ Folder accessible: "${folder.title}" (id ${folder.id}, parentType ${folder.parentType || 'space'})`);
    if (space) {
      console.log(`  Space: ${space.name} (key ${space.key}, id ${space.id})`);
      const cp = team.confluenceParent;
      if (cp.spaceKey && cp.spaceKey !== space.key) {
        console.log(`  ⚠ teams.json spaceKey "${cp.spaceKey}" does not match folder's actual space "${space.key}"`);
      }
    }
    return;
  }

  const team = await loadTeam(args.team);
  const range = getDateRange(args.month);

  console.error(`Operational Review — ${team.displayName} — ${range.label}`);
  console.error(`  current:  ${range.current.start} → ${range.current.end}`);
  console.error(`  previous: ${range.previous.start} → ${range.previous.end}`);
  console.error('');
  console.error('Gathering data:');

  const sourceNames = args.only || Object.keys(SOURCES);
  const tasks = sourceNames.map(name => {
    if (!SOURCES[name]) throw new Error(`Unknown source: ${name}`);
    return safe(name, () => SOURCES[name](range, team)).then(result => [name, result]);
  });

  const entries = await Promise.all(tasks);
  const data = Object.fromEntries(entries);

  // Fetch history and render charts up-front so the storage XML can reference
  // the chart attachment filenames.
  const charts = []; // { name, svg, png } populated when --history > 0
  if (args.history > 0) {
    console.error('');
    console.error(`Fetching PD history (${args.history} months)...`);
    const windows = getHistoryRanges(args.month, args.history);
    const pdHistory = await fetchPagerDutyHistory(team, windows);
    console.error('');
    console.error(`PD trend — ${team.displayName}`);
    console.error('  month     | HU  | Tot  | MTTA(H/L)            | MTTR(H/L)');
    console.error('  ----------+-----+------+----------------------+---------------------');
    for (const m of pdHistory) {
      const mtta = `${formatDuration(m.mttaHighMs).padEnd(6)} / ${formatDuration(m.mttaLowMs)}`;
      const mttr = `${formatDuration(m.mttrHighMs).padEnd(6)} / ${formatDuration(m.mttrLowMs)}`;
      console.error(`  ${m.label}   | ${String(m.high).padStart(3)} | ${String(m.total).padStart(4)} | ${mtta.padEnd(20)} | ${mttr}`);
    }

    let rollbarHistory = null;
    try {
      rollbarHistory = await fetchRollbarHistory(team, windows);
      console.error('');
      console.error(`Rollbar trend — ${team.displayName} (open errors at end of month)`);
      console.error('  month     | open');
      console.error('  ----------+------');
      for (const m of rollbarHistory) {
        console.error(`  ${m.label}   | ${String(m.open).padStart(4)}`);
      }
    } catch (e) {
      console.error(`  rollbar history skipped: ${e.message}`);
    }

    let jiraHistory = null;
    try {
      jiraHistory = await fetchJiraHistory(team, windows);
      console.error('');
      console.error(`Jira trend — ${team.displayName} (open at end of month)`);
      console.error('  month     | incidents | bugs');
      console.error('  ----------+-----------+-----');
      for (const m of jiraHistory) {
        console.error(`  ${m.label}   | ${String(m.incidents).padStart(9)} | ${String(m.bugs).padStart(4)}`);
      }
    } catch (e) {
      console.error(`  jira history skipped: ${e.message}`);
    }

    // GitHub trend is scoped to the last 2 windows because the user only
    // started doing this review in March; older snapshots aren't meaningful.
    let githubHistory = null;
    try {
      const ghWindows = windows.slice(-2);
      console.error('');
      console.error(`Fetching GitHub history (${ghWindows.length} months)... this can take a minute.`);
      githubHistory = await fetchGitHubHistory(team, ghWindows);
      console.error('');
      console.error(`GitHub trend — ${team.displayName} (open at end of month)`);
      console.error('  month     | vulns | PRs');
      console.error('  ----------+-------+-----');
      for (const m of githubHistory) {
        console.error(`  ${m.label}   | ${String(m.vulnerabilities).padStart(5)} | ${String(m.dependabotPRs).padStart(3)}`);
      }
    } catch (e) {
      console.error(`  github history skipped: ${e.message}`);
    }

    for (const c of renderTrendCharts({ pd: pdHistory, rollbar: rollbarHistory, jira: jiraHistory, github: githubHistory }, team)) {
      c.png = await svgToPng(c.svg);
      charts.push(c);
    }
  }

  const slug = team.name;
  const chartFilenames = charts.map(c => `trend-${c.name}.png`);

  // For --publish, render the Owner cell as a Confluence user mention so the
  // page shows @Display Name (linked) instead of a plain email address.
  let ownerAccountId = null;
  if (args.publish) {
    try { ownerAccountId = (await getCurrentUser()).accountId; }
    catch (e) { console.error(`  (could not fetch current user, falling back to email: ${e.message})`); }
  }

  const md = renderMarkdown(range, data, team);
  const html = renderHtml(range, data, team);
  const storage = renderStorage(range, data, team, { chartFilenames, ownerAccountId });
  const title = renderStorageTitle(range, team);

  await mkdir(args.out, { recursive: true });
  const mdPath = `${args.out}/op-review-${slug}-${range.label}.md`;
  const htmlPath = `${args.out}/op-review-${slug}-${range.label}.html`;
  const xmlPath = `${args.out}/op-review-${slug}-${range.label}.xml`;
  const jsonPath = `${args.out}/op-review-${slug}-${range.label}.json`;
  await writeFile(mdPath, md);
  await writeFile(htmlPath, html);
  await writeFile(xmlPath, `<!-- Confluence storage format. Page title: ${title} -->\n${storage}\n`);
  await writeFile(jsonPath, JSON.stringify({ team: team.name, range, data }, null, 2));

  console.error('');
  console.error(`Wrote ${mdPath}`);
  console.error(`Wrote ${htmlPath}`);
  console.error(`Wrote ${xmlPath}`);
  console.error(`Wrote ${jsonPath}`);

  for (const c of charts) {
    const stem = `${args.out}/op-review-${slug}-${range.label}-trend-${c.name}`;
    await writeFile(`${stem}.svg`, c.svg);
    await writeFile(`${stem}.png`, c.png);
    console.error(`Wrote ${stem}.{svg,png}`);
  }

  if (args.publish) {
    console.error('');
    console.error(`Publishing to Confluence...`);
    const { page, created } = await publishPage(team, title, storage);
    const verb = created ? 'Created' : 'Updated';
    console.error(`✓ ${verb} page "${page.title}" (id ${page.id}, version ${page.version?.number})`);
    console.error(`  ${pageWebUrl(page)}`);

    for (const c of charts) {
      const filename = `trend-${c.name}.png`;
      const att = await uploadAttachment(page.id, filename, c.png, 'image/png');
      console.error(`  ✓ Uploaded ${filename} (id ${att.id}, version ${att.version?.number || '?'})`);
    }
  }

  console.error('');
  console.log(md);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});

// GitHub: open Dependabot vulnerability alerts and open Dependabot PRs across
// the team's repos. Repos are identified by a GitHub topic — set
// `githubTopic` per team in teams.json, then tag each of the team's repos
// in GitHub with that same topic so the search query picks them up.

const API = 'https://api.github.com';
const RETRY_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns how long to wait (ms) before retrying a failed response, or null if
// it is NOT a rate limit and should fail immediately. Only genuine rate limits
// are retried — a plain 403 (bad token, no repo access) must NOT be retried, or
// every request would stall for minutes of backoff before failing anyway.
export function retryDelayMs(status, headers, bodyText, attempt) {
  if (status !== 429 && status !== 403) return null;
  const retryAfter = headers.get('retry-after');
  if (retryAfter) return Number(retryAfter) * 1000;
  const reset = headers.get('x-ratelimit-reset');
  if (reset && headers.get('x-ratelimit-remaining') === '0') {
    return Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
  }
  // Secondary rate limit: identified by the message body, no reset headers.
  if (/secondary rate limit/i.test(bodyText || '')) {
    return Math.min(120000, 30000 * 2 ** attempt);
  }
  return null; // not a rate limit → fail fast
}

async function ghFetch(path, attempt = 0) {
  const url = path.startsWith('http') ? path : API + path;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'opreview'
    }
  });
  if (!res.ok) {
    const bodyText = await res.text();
    const delay = attempt < RETRY_ATTEMPTS
      ? retryDelayMs(res.status, res.headers, bodyText, attempt)
      : null;
    if (delay != null) {
      process.stderr.write(`    rate-limited (${res.status}), retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${RETRY_ATTEMPTS})\n`);
      await sleep(delay);
      return ghFetch(path, attempt + 1);
    }
    const err = new Error(`GitHub ${path} → ${res.status}: ${bodyText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return { data: await res.json(), linkHeader: res.headers.get('Link') };
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function ghPaginate(initialPath) {
  let url = initialPath;
  const all = [];
  while (url) {
    const { data, linkHeader } = await ghFetch(url);
    if (Array.isArray(data)) all.push(...data);
    else if (Array.isArray(data?.items)) all.push(...data.items);
    else throw new Error(`Unexpected GitHub response shape for ${url}`);
    url = nextPageUrl(linkHeader);
  }
  return all;
}

async function listReposByTopic(org, topic) {
  const q = encodeURIComponent(`org:${org} topic:${topic} archived:false`);
  return ghPaginate(`/search/repositories?q=${q}&per_page=100`);
}

// Paginate through a list endpoint sorted by `updated` desc, stopping when an
// item older than sinceMs is reached. Used by the historical fetchers so we
// only pull as much closed/resolved data as we need to reconstruct snapshots
// for the requested windows.
async function paginateUntilOlderThan(initialPath, sinceMs) {
  const all = [];
  let url = initialPath;
  while (url) {
    let res;
    try {
      res = await ghFetch(url);
    } catch (err) {
      if (err.status === 404 || err.status === 403) break;
      throw err;
    }
    const { data, linkHeader } = res;
    const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
    let stop = false;
    for (const item of items) {
      const updatedMs = new Date(item.updated_at).getTime();
      if (updatedMs < sinceMs) { stop = true; break; }
      all.push(item);
    }
    if (stop) break;
    url = nextPageUrl(linkHeader);
  }
  return all;
}

// Historical alert fetch for a repo: currently-open alerts (any age) plus
// resolved alerts updated since sinceMs.
async function fetchHistoricalAlerts(fullName, sinceMs) {
  let open = [];
  try { open = await ghPaginate(`/repos/${fullName}/dependabot/alerts?state=open&per_page=100`); }
  catch (err) { if (err.status !== 404 && err.status !== 403) throw err; }
  const resolved = await paginateUntilOlderThan(
    `/repos/${fullName}/dependabot/alerts?state=auto_dismissed,dismissed,fixed&sort=updated&direction=desc&per_page=100`,
    sinceMs
  );
  return [...open, ...resolved];
}

// Historical Dependabot PR fetch: currently-open dependabot PRs plus closed
// dependabot PRs updated since sinceMs. Filters by user.login client-side
// because the /pulls endpoint can't filter by author.
async function fetchHistoricalDependabotPRs(fullName, sinceMs) {
  const open = (await ghPaginate(`/repos/${fullName}/pulls?state=open&per_page=100`))
    .filter(pr => (pr.user?.login || '').startsWith('dependabot'));
  const closedRaw = await paginateUntilOlderThan(
    `/repos/${fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    sinceMs
  );
  const closed = closedRaw.filter(pr => (pr.user?.login || '').startsWith('dependabot'));
  return [...open, ...closed];
}

// Extract the repo full name from a GitHub issue/PR html_url.
// e.g. "https://github.com/org/repo/pull/123" → "org/repo"
export function repoFromUrl(htmlUrl) {
  const m = htmlUrl.match(/github\.com\/([^/]+\/[^/]+)\//);
  return m ? m[1] : '';
}

export function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Real review events from a PR's reviews: one entry per submitted review
// (PENDING reviews and events without a user are ignored). Keeps every event —
// e.g. a reviewer who requests changes twice then approves yields 3 entries —
// so downstream can count approvals and total review activity, not just people.
// Events by authorLogin (the PR author, compared case-insensitively) are
// dropped: replying to feedback on your own PR is not reviewing it.
export function reviewEventsFromReviews(reviews, authorLogin = '') {
  const author = (authorLogin || '').toLowerCase();
  return reviews
    .filter(r => r.state !== 'PENDING' && r.user?.login)
    .filter(r => !author || r.user.login.toLowerCase() !== author)
    .map(r => ({ login: r.user.login, state: r.state }));
}

// Distinct human reviewer logins from a PR's review events (PENDING reviews and
// events without a user are ignored). authorLogin is excluded like above.
export function reviewersFromReviews(reviews, authorLogin = '') {
  return [...new Set(reviewEventsFromReviews(reviews, authorLogin).map(e => e.login))];
}

// Per-reviewer stats across the given PRs. excludeLogins are omitted; bots
// that review (Copilot, bugbot, …) count like any reviewer. For each reviewer:
//   prs       — distinct PRs they reviewed
//   approvals — count of real APPROVED events (re-approvals counted separately)
//   events    — count of all review events (approve/changes/comment) — the best
//               proxy for review effort/time.
// Sorted by events descending.
export function computeReviewerStats(enriched, excludeLogins = []) {
  const exclude = new Set((excludeLogins || []).map(l => l.toLowerCase()));
  const skip = login => exclude.has(login.toLowerCase());

  const byLogin = new Map();
  for (const pr of enriched) {
    const countedPrFor = new Set();
    for (const ev of pr.reviewEvents || []) {
      if (skip(ev.login)) continue;
      let s = byLogin.get(ev.login);
      if (!s) { s = { login: ev.login, prs: 0, approvals: 0, events: 0 }; byLogin.set(ev.login, s); }
      s.events++;
      if (ev.state === 'APPROVED') s.approvals++;
      if (!countedPrFor.has(ev.login)) { s.prs++; countedPrFor.add(ev.login); }
    }
  }
  return [...byLogin.values()].sort((a, b) => b.events - a.events);
}

// True when a PR's merge time falls in the half-open window [startMs, endMs).
// The end is exclusive so a PR merged on the first instant of the next period
// is not counted in this period (and thus never double-counted across reports).
export function prMergedInWindow(mergedAtIso, startMs, endMs) {
  if (!mergedAtIso) return false;
  const t = new Date(mergedAtIso).getTime();
  return t >= startMs && t < endMs;
}

// Run fn over items with at most `limit` in flight at once, preserving order.
// Used to enrich PRs without firing hundreds of concurrent GitHub requests
// (which would trip the very secondary rate limit the batching avoids).
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

// Aggregate enriched PRs into the metrics shown in the report. Reviewer load
// counts distinct reviewers per PR (bots included); excludeLogins are omitted.
export function computePRMetrics(enriched, excludeLogins = []) {
  const mergeTimes = enriched.map(p => p.timeToMergeMs).filter(t => t != null);
  const totalComments = enriched.reduce((s, p) => s + p.comments, 0);

  const excludeSet = new Set((excludeLogins || []).map(l => l.toLowerCase()));
  const reviewerLoad = {};
  for (const pr of enriched) {
    for (const login of pr.reviewers) {
      if (excludeSet.has(login.toLowerCase())) continue;
      reviewerLoad[login] = (reviewerLoad[login] || 0) + 1;
    }
  }

  return {
    total: enriched.length,
    medianTimeToMergeMs: median(mergeTimes),
    totalComments,
    avgComments: enriched.length ? totalComments / enriched.length : null,
    reviewerLoad, // { login: count } — PRs reviewed, used by the metrics table
    reviewerStats: computeReviewerStats(enriched, excludeLogins) // [{login, prs, approvals, events}]
  };
}

// GitHub Search caps any single query at 1000 results, so per-batch pagination
// stops there regardless of how many PRs actually matched.
const SEARCH_RESULT_CAP = 1000;

// Fetch team PR metrics for the given repos over [startMs, endMs).
// GitHub Search doesn't support topic: on issues/PRs, so we batch repos into
// groups of 5 (Search supports up to 5 repo: qualifiers per query) — far fewer
// API calls than one-per-repo, keeping us under the secondary rate limit.
// The merged: date qualifier is only day-granular and inclusive, so we
// over-fetch by date and then filter precisely with prMergedInWindow.
export async function fetchTeamPRMetrics(repoNames, startMs, endMs, excludeLogins = []) {
  const since = new Date(startMs).toISOString().slice(0, 10);
  const until = new Date(endMs).toISOString().slice(0, 10);

  const BATCH = 5;
  const batches = [];
  for (let i = 0; i < repoNames.length; i += BATCH) batches.push(repoNames.slice(i, i + BATCH));

  const prs = [];
  for (let b = 0; b < batches.length; b++) {
    const repoQ = batches[b].map(r => `repo:${r}`).join(' ');
    const q = encodeURIComponent(
      `${repoQ} is:pr is:merged merged:${since}..${until} -author:app/dependabot`
    );
    const items = await ghPaginate(`/search/issues?q=${q}&per_page=100`);
    if (items.length >= SEARCH_RESULT_CAP) {
      process.stderr.write(
        `    warning: PR search batch ${b + 1} hit GitHub's ${SEARCH_RESULT_CAP}-result cap; ` +
        `team PR metrics may undercount for ${batches[b].join(', ')}\n`
      );
    }
    prs.push(...items);
    if (b < batches.length - 1) await sleep(700);
  }

  // Enrich each PR with its reviews (bounded concurrency — these hit
  // /repos/…/reviews, not Search, but still count against the REST rate limit).
  const enriched = await mapLimit(prs, 8, async pr => {
    const fullName = repoFromUrl(pr.html_url);
    let reviews = [];
    try {
      reviews = await ghPaginate(`/repos/${fullName}/pulls/${pr.number}/reviews?per_page=100`);
    } catch (_) { /* ignore */ }

    const mergedAt = pr.pull_request?.merged_at || pr.closed_at;
    const createdMs = new Date(pr.created_at).getTime();
    const mergedMs = mergedAt ? new Date(mergedAt).getTime() : null;
    const reviewEvents = reviewEventsFromReviews(reviews, pr.user?.login);

    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login || '',
      repo: fullName,
      createdAt: pr.created_at,
      mergedAt,
      timeToMergeMs: mergedMs ? mergedMs - createdMs : null,
      comments: (pr.comments || 0) + (pr.review_comments || 0),
      reviewers: [...new Set(reviewEvents.map(e => e.login))],
      reviewEvents
    };
  });

  const inWindow = enriched.filter(p => prMergedInWindow(p.mergedAt, startMs, endMs));
  return computePRMetrics(inWindow, excludeLogins);
}

function alertOpenAt(alert, tMs) {
  const createdMs = new Date(alert.created_at).getTime();
  if (createdMs > tMs) return false;
  if (alert.state === 'open') return true;
  const resolution = alert.fixed_at || alert.dismissed_at || alert.auto_dismissed_at;
  if (!resolution) return false;
  return new Date(resolution).getTime() > tMs;
}

function prOpenAt(pr, tMs) {
  const createdMs = new Date(pr.created_at).getTime();
  if (createdMs > tMs) return false;
  if (pr.state === 'open') return true;
  if (!pr.closed_at) return false;
  return new Date(pr.closed_at).getTime() > tMs;
}

export async function fetchGitHub({ current, previous }, team) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not set in .env');
  }
  const org = process.env.GITHUB_ORG;
  if (!org) {
    throw new Error('GITHUB_ORG not set in .env');
  }
  if (!team?.githubTopic) {
    throw new Error(`githubTopic not set for team "${team?.name}" in teams.json`);
  }

  const repos = await listReposByTopic(org, team.githubTopic);
  const repoNames = repos.map(r => r.full_name);

  // End-of-period snapshots (matches the chart and the "Review period" header).
  // A live count would drift from the chart's last bar by however many days the
  // run happens after the period ends, which confuses readers comparing the two.
  const currentEndMs = new Date(current.end).getTime();
  const prevEndMs = new Date(previous.end).getTime();
  const sinceMs = new Date(previous.start).getTime();

  const [perRepo, currentPRMetrics, previousPRMetrics] = await Promise.all([
    Promise.all(repos.map(async r => {
      const [alerts, prs] = await Promise.all([
        fetchHistoricalAlerts(r.full_name, sinceMs),
        fetchHistoricalDependabotPRs(r.full_name, sinceMs)
      ]);
      return { repo: r.full_name, alerts, prs };
    })),
    fetchTeamPRMetrics(repoNames, new Date(current.start).getTime(), currentEndMs, team.excludeMembers),
    fetchTeamPRMetrics(repoNames, new Date(previous.start).getTime(), prevEndMs, team.excludeMembers)
  ]);

  const allAlerts = perRepo.flatMap(r => r.alerts.map(a => ({ ...a, _repo: r.repo })));
  const allPRs = perRepo.flatMap(r => r.prs.map(p => ({ ...p, _repo: r.repo })));

  function snapshotAt(endMs) {
    const openAlerts = allAlerts.filter(a => alertOpenAt(a, endMs));
    const openPRs = allPRs.filter(p => prOpenAt(p, endMs));
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    const items = openAlerts.map(a => ({
      title: a.security_advisory?.summary || 'Security alert',
      url: a.html_url,
      severity: (a.security_advisory?.severity || 'unknown').toLowerCase(),
      package: a.dependency?.package?.name || '',
      repo: a._repo
    }));
    for (const a of items) {
      bySeverity[Object.hasOwn(bySeverity, a.severity) ? a.severity : 'unknown']++;
    }
    return {
      vulnerabilities: { total: items.length, bySeverity, items },
      dependabotPRs: {
        total: openPRs.length,
        items: openPRs.map(p => ({
          title: p.title,
          url: p.html_url,
          createdAt: p.created_at,
          repo: p._repo
        }))
      }
    };
  }

  return {
    current: { repos: perRepo.length, ...snapshotAt(currentEndMs), teamPRs: currentPRMetrics },
    previous: { ...snapshotAt(prevEndMs), teamPRs: previousPRMetrics }
  };
}

// Snapshot history of open vulnerabilities and Dependabot PRs at the end of
// each window. Fetches alerts in any state and Dependabot PRs in any state
// across all team repos, then buckets by window-end timestamp.
export async function fetchGitHubHistory(team, windows) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not set in .env');
  }
  const org = process.env.GITHUB_ORG;
  if (!org) {
    throw new Error('GITHUB_ORG not set in .env');
  }
  if (!team?.githubTopic) {
    throw new Error(`githubTopic not set for team "${team?.name}" in teams.json`);
  }

  const repos = await listReposByTopic(org, team.githubTopic);
  const sinceMs = Math.min(...windows.map(w => new Date(w.start).getTime()));

  const perRepo = await Promise.all(repos.map(async r => {
    const [alerts, prs] = await Promise.all([
      fetchHistoricalAlerts(r.full_name, sinceMs),
      fetchHistoricalDependabotPRs(r.full_name, sinceMs)
    ]);
    return { alerts, prs };
  }));

  const allAlerts = perRepo.flatMap(r => r.alerts);
  const allPRs = perRepo.flatMap(r => r.prs);

  return windows.map(w => {
    const endMs = new Date(w.end).getTime();
    return {
      label: w.label,
      vulnerabilities: allAlerts.filter(a => alertOpenAt(a, endMs)).length,
      dependabotPRs: allPRs.filter(p => prOpenAt(p, endMs)).length
    };
  });
}

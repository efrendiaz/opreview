// GitHub: open Dependabot vulnerability alerts and open Dependabot PRs across
// the team's repos. Repos are identified by a GitHub topic — set
// `githubTopic` per team in teams.json, then tag each of the team's repos
// in GitHub with that same topic so the search query picks them up.

const API = 'https://api.github.com';

async function ghFetch(path) {
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
    const body = await res.text();
    const err = new Error(`GitHub ${path} → ${res.status}: ${body.slice(0, 300)}`);
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

  // End-of-period snapshots (matches the chart and the "Review period" header).
  // A live count would drift from the chart's last bar by however many days the
  // run happens after the period ends, which confuses readers comparing the two.
  const currentEndMs = new Date(current.end).getTime();
  const prevEndMs = new Date(previous.end).getTime();
  const sinceMs = new Date(previous.start).getTime();

  const perRepo = await Promise.all(repos.map(async r => {
    const [alerts, prs] = await Promise.all([
      fetchHistoricalAlerts(r.full_name, sinceMs),
      fetchHistoricalDependabotPRs(r.full_name, sinceMs)
    ]);
    return { repo: r.full_name, alerts, prs };
  }));

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
    current: { repos: perRepo.length, ...snapshotAt(currentEndMs) },
    previous: snapshotAt(prevEndMs)
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

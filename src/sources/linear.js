// Linear: bug backlog for teams that moved their board from Jira to Linear.
// Linear keeps the migrated Jira history (original createdAt), so a team's
// whole bug trend comes from here once `linearBugs` is set in teams.json:
//   "linearBugs": { "team": "WEBC", "labels": ["Bug", "type:bug"] }
// Linear has no issue types; bugs are the issues carrying one of `labels`.

const LINEAR_URL = 'https://api.linear.app/graphql';

const QUERY = `query OpenBugs($filter: IssueFilter, $after: String) {
  issues(first: 100, after: $after, filter: $filter, includeArchived: true) {
    nodes { identifier title url }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Open at end of window: created before the end and neither completed nor
// canceled before it — the Linear twin of jira.js's withSnapshotDate.
function openAtEndFilter(cfg, window) {
  const end = window.end;
  return {
    team: { key: { eq: cfg.team } },
    labels: { some: { name: { in: cfg.labels } } },
    createdAt: { lt: end },
    and: [
      { or: [{ completedAt: { null: true } }, { completedAt: { gte: end } }] },
      { or: [{ canceledAt: { null: true } }, { canceledAt: { gte: end } }] }
    ]
  };
}

export async function openLinearBugsAtEndOf(window, cfg, { fetchImpl = fetch } = {}) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('Linear env missing in .env: LINEAR_API_KEY');
  if (!cfg?.team || !cfg?.labels?.length) throw new Error('linearBugs needs "team" and "labels" in teams.json');

  const filter = openAtEndFilter(cfg, window);
  const issues = [];
  let after = null;
  do {
    const res = await fetchImpl(LINEAR_URL, {
      method: 'POST',
      // Personal API keys go in raw; "Bearer <key>" is for OAuth tokens.
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { filter, after } })
    });
    if (!res.ok) throw new Error(`Linear → ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`Linear → ${body.errors.map(e => e.message).join('; ')}`);
    const page = body.data.issues;
    for (const i of page.nodes) {
      issues.push({ key: i.identifier, summary: i.title || '', url: i.url, tracker: 'linear' });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

// Jira: lists of incident tickets and bug tickets opened in the period.
// Two separate JQLs per team (jiraJql for incidents, jiraBugsJql for bugs)
// because they typically live in different projects.

async function jiraSearch(jql) {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN } = process.env;
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const url = `${JIRA_BASE_URL}/rest/api/3/search/jql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jql, fields: ['summary'], maxResults: 100 })
  });
  if (!res.ok) {
    throw new Error(`Jira → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function dateOnly(iso) {
  return iso.slice(0, 10);
}

function withDateRange(baseJql, window) {
  // Splice the date filter in before any trailing ORDER BY so users can paste
  // JQL straight from the Jira UI without us breaking it.
  const dateClause = `created >= "${dateOnly(window.start)}" AND created < "${dateOnly(window.end)}"`;
  const m = baseJql.match(/^(.*?)(\s+ORDER\s+BY\s+.*)$/is);
  if (m) return `${m[1]} AND ${dateClause}${m[2]}`;
  return `${baseJql} AND ${dateClause}`;
}

async function issuesInWindow(window, baseJql) {
  if (!baseJql) return null;
  const jql = withDateRange(baseJql, window);
  const data = await jiraSearch(jql);
  const base = process.env.JIRA_BASE_URL;
  return (data.issues || []).map(i => ({
    key: i.key,
    summary: i.fields?.summary || '',
    url: `${base}/browse/${i.key}`
  }));
}

export async function fetchJira({ current, previous }, team) {
  const required = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Jira env missing in .env: ${missing.join(', ')}`);
  if (!team?.jiraJql) {
    throw new Error(`jiraJql not set for team "${team?.name}" in teams.json`);
  }

  // Backlog snapshot at end of each window so the table count matches the
  // trend chart and the issue lists in the Notes column show the chronic
  // tickets, not just whatever was newly filed in-month.
  const [
    currIncidents, prevIncidents,
    currBugs, prevBugs
  ] = await Promise.all([
    openIssuesAtEndOf(current, team.jiraJql),
    openIssuesAtEndOf(previous, team.jiraJql),
    openIssuesAtEndOf(current, team.jiraBugsJql),
    openIssuesAtEndOf(previous, team.jiraBugsJql)
  ]);

  return {
    current: { incidents: currIncidents, bugs: currBugs },
    previous: { incidents: prevIncidents, bugs: prevBugs }
  };
}

// Splice an "open at end of window" filter into the team's JQL: the issue
// must have been created before the window end AND either be unresolved or
// have been resolved after the window end. Inserted before any trailing
// ORDER BY for the same paste-as-is reasons as withDateRange.
function withSnapshotDate(baseJql, window) {
  const endDate = dateOnly(window.end);
  const filter = `created < "${endDate}" AND (resolved IS EMPTY OR resolved >= "${endDate}")`;
  const m = baseJql.match(/^(.*?)(\s+ORDER\s+BY\s+.*)$/is);
  if (m) return `${m[1]} AND ${filter}${m[2]}`;
  return `${baseJql} AND ${filter}`;
}

async function openAtEndOf(window, baseJql) {
  if (!baseJql) return null;
  const jql = withSnapshotDate(baseJql, window);
  const data = await jiraSearch(jql);
  // newer search/jql may omit `total`; fall back to issues.length.
  return typeof data.total === 'number' ? data.total : (data.issues?.length || 0);
}

// Like openAtEndOf, but returns the issue list (key/summary/url) so the
// report's Notes column can show the actual sticky tickets, not just a count.
async function openIssuesAtEndOf(window, baseJql) {
  if (!baseJql) return null;
  const jql = withSnapshotDate(baseJql, window);
  const data = await jiraSearch(jql);
  const base = process.env.JIRA_BASE_URL;
  return (data.issues || []).map(i => ({
    key: i.key,
    summary: i.fields?.summary || '',
    url: `${base}/browse/${i.key}`
  }));
}

// Snapshot of open incidents and bugs at the end of each window — backlog
// trend rather than inflow. Bugs JQL is optional (returns null/0 when
// absent).
export async function fetchJiraHistory(team, windows) {
  const required = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Jira env missing in .env: ${missing.join(', ')}`);
  if (!team?.jiraJql) {
    throw new Error(`jiraJql not set for team "${team?.name}" in teams.json`);
  }
  return Promise.all(windows.map(async w => {
    const [incidents, bugs] = await Promise.all([
      openAtEndOf(w, team.jiraJql),
      openAtEndOf(w, team.jiraBugsJql)
    ]);
    return {
      label: w.label,
      incidents: incidents ?? 0,
      bugs: bugs ?? 0
    };
  }));
}

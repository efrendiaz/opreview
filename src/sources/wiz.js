// Wiz: vulnerability counts by severity.
// Wiz uses OAuth client credentials → bearer token → GraphQL.
// Auth is wired below; the GraphQL query needs your project filter to
// be useful, so it's left as a TODO. Once you know your WIZ_PROJECT_ID
// the snippet at the bottom should work.

let cachedToken = { value: null, expiresAt: 0 };

async function getWizToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  const { WIZ_CLIENT_ID, WIZ_CLIENT_SECRET, WIZ_AUTH_URL } = process.env;
  const res = await fetch(WIZ_AUTH_URL || 'https://auth.app.wiz.io/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      audience: 'wiz-api',
      client_id: WIZ_CLIENT_ID,
      client_secret: WIZ_CLIENT_SECRET
    })
  });
  if (!res.ok) throw new Error(`Wiz auth → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };
  return data.access_token;
}

async function wizGql(query, variables) {
  const token = await getWizToken();
  const res = await fetch(process.env.WIZ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Wiz GraphQL → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Wiz GraphQL errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}

export async function fetchWiz(_range, team) {
  const { WIZ_CLIENT_ID, WIZ_CLIENT_SECRET, WIZ_API_URL } = process.env;
  if (!WIZ_CLIENT_ID || !WIZ_CLIENT_SECRET || !WIZ_API_URL) {
    return { current: { _skipped: 'Wiz env vars not set' } };
  }

  // TODO: implement once you have a service account.
  // Below is the rough shape of what you'd want — adapt to your tenant's schema.
  // The team's project filter comes from teams.json (team.wizProjectId).
  /*
  const query = `
    query IssuesBySeverity($filterBy: IssueFilters) {
      issues(first: 0, filterBy: $filterBy) {
        criticalSeverityCount
        highSeverityCount
        mediumSeverityCount
        lowSeverityCount
      }
    }
  `;
  const variables = {
    filterBy: {
      status: ['OPEN'],
      project: team?.wizProjectId ? [team.wizProjectId] : undefined
    }
  };
  const data = await wizGql(query, variables);
  return { current: {
    critical: data.issues.criticalSeverityCount,
    high: data.issues.highSeverityCount,
    medium: data.issues.mediumSeverityCount
  }};
  */

  return { current: { _todo: 'Wiz query not yet implemented — auth is wired, see comments in src/sources/wiz.js' } };
}

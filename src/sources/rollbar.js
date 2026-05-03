// Rollbar: error item counts.
// API: https://docs.rollbar.com/reference/list-all-items
//
// Rollbar's /items/ endpoint authenticates with a project-scoped read token,
// so to mirror a multi-project Fix query we accept an array of tokens
// (one per project) and aggregate the results. Filter mirrors the team's
// saved Fix query: level=error, status=active, environment=production.

async function rollbarFetchItems(token, status = 'active', maxPages = 5) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.rollbar.com/api/1/items/?level=error&status=${status}&environment=production&page=${page}`;
    const res = await fetch(url, {
      headers: { 'X-Rollbar-Access-Token': token, Accept: 'application/json' }
    });
    if (!res.ok) {
      throw new Error(`Rollbar /items/ → ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const batch = data?.result?.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

function inWindow(item, window) {
  const ts = item.last_occurrence_timestamp; // unix seconds
  if (!ts) return false;
  return ts * 1000 >= new Date(window.start).getTime()
    && ts * 1000 < new Date(window.end).getTime();
}

export async function fetchRollbar({ current, previous }, team) {
  const tokens = (team?.rollbarReadTokens || []).filter(Boolean);
  if (!tokens.length) {
    throw new Error(`rollbarReadTokens is empty for team "${team?.name}" in teams.json`);
  }

  // Fetch all projects in parallel and concatenate.
  const perProject = await Promise.all(tokens.map(rollbarFetchItems));
  const items = perProject.flat();

  return {
    current: {
      count: items.filter(i => inWindow(i, current)).length,
      openTotal: items.length,
      projects: tokens.length
    },
    previous: {
      count: items.filter(i => inWindow(i, previous)).length
    }
  };
}

// Was this item open (unresolved) at the given moment? Treats `active` and
// `muted` as open; `resolved`/`archived` are open only if their last_modified
// is later than `tMs` (Rollbar updates last_modified on status change, so
// it's a reasonable resolution-time proxy).
function openAt(item, tMs) {
  const createdMs = (item.first_occurrence_timestamp || 0) * 1000;
  if (createdMs > tMs) return false;
  if (item.status === 'active' || item.status === 'muted') return true;
  const modifiedMs = (item.last_modified_timestamp || 0) * 1000;
  return modifiedMs > tMs;
}

// History as monthly snapshots of open errors. Counts items that were
// unresolved at end-of-month, so resolution work shows up as a downward
// slope (unlike the volume metric which only ever grows with new errors).
export async function fetchRollbarHistory(team, windows) {
  const tokens = (team?.rollbarReadTokens || []).filter(Boolean);
  if (!tokens.length) {
    throw new Error(`rollbarReadTokens is empty for team "${team?.name}" in teams.json`);
  }
  const fetches = tokens.flatMap(t => [
    rollbarFetchItems(t, 'active', 10),
    rollbarFetchItems(t, 'resolved', 10)
  ]);
  const perFetch = await Promise.all(fetches);
  const items = [...new Map(perFetch.flat().map(i => [i.id, i])).values()];
  return windows.map(w => {
    const endMs = new Date(w.end).getTime();
    return {
      label: w.label,
      open: items.filter(i => openAt(i, endMs)).length
    };
  });
}

// Rollbar: error item counts.
// API: https://docs.rollbar.com/reference/list-all-items
//
// Rollbar's /items/ endpoint authenticates with a project-scoped read token,
// so to mirror a multi-project Fix query we accept an array of tokens
// (one per project) and aggregate the results. Filter mirrors the team's
// saved Fix query: level=error, status=active, environment=production.

function rollbarItemUrl(item) {
  const slug = process.env.ROLLBAR_ACCOUNT_SLUG;
  if (!slug || !item.project_slug || !item.counter) return null;
  return `https://app.rollbar.com/a/${encodeURIComponent(slug)}/fix/item/${encodeURIComponent(item.project_slug)}/${item.counter}`;
}

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

// Was the item active at any point during the window? Used for "top by
// occurrences" so currently-still-firing items count for the month they
// most recently overlapped, even if last_occurrence has since moved past.
function activeInWindow(item, window) {
  const startMs = new Date(window.start).getTime();
  const endMs = new Date(window.end).getTime();
  const firstMs = (item.first_occurrence_timestamp || 0) * 1000;
  const lastMs = (item.last_occurrence_timestamp || 0) * 1000;
  return firstMs < endMs && lastMs >= startMs;
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

// Pull active + resolved items across all team tokens and dedupe by id.
// Both the current-period fetch and the history fetch use this so they
// agree on the underlying dataset.
async function fetchAllItems(tokens) {
  const fetches = tokens.flatMap(t => [
    rollbarFetchItems(t, 'active', 10),
    rollbarFetchItems(t, 'resolved', 10)
  ]);
  const perFetch = await Promise.all(fetches);
  return [...new Map(perFetch.flat().map(i => [i.id, i])).values()];
}

export async function fetchRollbar({ current, previous }, team) {
  const tokens = (team?.rollbarReadTokens || []).filter(Boolean);
  if (!tokens.length) {
    throw new Error(`rollbarReadTokens is empty for team "${team?.name}" in teams.json`);
  }

  const items = await fetchAllItems(tokens);
  const currentEndMs = new Date(current.end).getTime();

  // Top-3 by lifetime total_occurrences among items active during the review
  // window (items whose lifetime overlaps the period). Lifetime is the only
  // count Rollbar's /items/ endpoint exposes — flag this in the Notes label.
  const topByOccurrences = [...items]
    .filter(i => activeInWindow(i, current))
    .sort((a, b) => (b.total_occurrences || 0) - (a.total_occurrences || 0))
    .slice(0, 3)
    .map(i => ({
      title: i.title || `Item ${i.counter}`,
      occurrences: i.total_occurrences || 0,
      url: rollbarItemUrl(i)
    }));

  return {
    current: {
      count: items.filter(i => inWindow(i, current)).length,
      // Open backlog at end of current review period (matches trend chart's
      // last data point — stable for a given --month, not "now").
      openTotal: items.filter(i => openAt(i, currentEndMs)).length,
      topByOccurrences,
      projects: tokens.length
    },
    previous: {
      count: items.filter(i => inWindow(i, previous)).length
    }
  };
}

// History as monthly snapshots of open errors. Counts items that were
// unresolved at end-of-month, so resolution work shows up as a downward
// slope (unlike the volume metric which only ever grows with new errors).
export async function fetchRollbarHistory(team, windows) {
  const tokens = (team?.rollbarReadTokens || []).filter(Boolean);
  if (!tokens.length) {
    throw new Error(`rollbarReadTokens is empty for team "${team?.name}" in teams.json`);
  }
  const items = await fetchAllItems(tokens);
  return windows.map(w => {
    const endMs = new Date(w.end).getTime();
    return {
      label: w.label,
      open: items.filter(i => openAt(i, endMs)).length
    };
  });
}

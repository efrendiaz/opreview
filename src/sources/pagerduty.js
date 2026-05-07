// PagerDuty: incident counts (HU/Total), MTTA, MTTR — by urgency.
// Docs: https://developer.pagerduty.com/api-reference/

const BASE = 'https://api.pagerduty.com';

// SLO targets (same across both teams). Renderers use these in metric labels
// and the source uses them to count breaches per period.
export const SLO_MS = {
  mtta: { high: 1 * 60 * 60 * 1000, low: 9 * 60 * 60 * 1000 },
  mttr: { high: 4 * 60 * 60 * 1000, low: 15 * 60 * 60 * 1000 }
};

// PD service names include the environment by convention; restrict to
// production by excluding services whose name contains a non-prod env
// keyword as a whole word. Word boundaries keep things like
// `developer-portal-production` from being misclassified.
const NON_PROD_RE = /\b(staging|sandbox|qa|development|test|dev)\b/i;

function isProduction(incident) {
  return !NON_PROD_RE.test(incident.service?.summary || '');
}

async function pdFetch(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_TOKEN}`,
      Accept: 'application/vnd.pagerduty+json;version=2'
    }
  });
  if (!res.ok) {
    throw new Error(`PagerDuty ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function getAllIncidents(since, until, teamIds) {
  const all = [];
  let offset = 0;
  const limit = 100;
  // PagerDuty paginates with offset/more. Keep going until done.
  while (true) {
    const data = await pdFetch('/incidents', {
      since,
      until,
      'team_ids[]': teamIds,
      'statuses[]': ['triggered', 'acknowledged', 'resolved'],
      limit,
      offset
    });
    all.push(...data.incidents);
    if (!data.more) break;
    offset += limit;
    if (offset > 5000) break; // sanity guard
  }
  return all;
}

// Pull PD's pre-computed per-incident metrics so MTTA/MTTR match the
// PagerDuty Insights UI exactly. /incidents.acknowledgements is unreliable
// for analytics — it omits auto-acks via integrations and log-entry events
// that PD itself counts as "acknowledged" — so we trust the analytics API.
async function getAnalyticsMetrics(since, until, teamIds) {
  const all = [];
  let starting_after = null;
  while (true) {
    let res;
    let attempt = 0;
    while (true) {
      res = await fetch(`${BASE}/analytics/raw/incidents`, {
        method: 'POST',
        headers: {
          Authorization: `Token token=${process.env.PAGERDUTY_TOKEN}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filters: { created_at_start: since, created_at_end: until, team_ids: teamIds },
          limit: 1000,
          starting_after
        })
      });
      // PD analytics rate-limits aggressively; exponential backoff up to ~60s
      // total before giving up. Honours Retry-After when present.
      if (res.status !== 429 || attempt >= 5) break;
      const retryAfter = Number(res.headers.get('Retry-After')) || (2 ** attempt);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      attempt++;
    }
    if (!res.ok) {
      throw new Error(`PagerDuty /analytics/raw/incidents → ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    all.push(...(data.data || []));
    if (!data.more) break;
    starting_after = data.last;
    if (all.length > 50000) break; // sanity guard
  }
  return all;
}

function avg(nums) {
  const valid = nums.filter(n => n != null);
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export function formatDuration(ms) {
  if (ms == null) return 'N/A';
  if (ms < 30 * 1000) return '0m';
  // Round to the nearest minute (matches PagerDuty's Insights display) and
  // recompose into d/h/m so we don't show "60m" or "24h".
  const totalMins = Math.round(ms / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || (!days && !hours)) parts.push(`${mins}m`);
  return parts.join(' ');
}

function topRecurringTitles(incidents, topN = 3, minCount = 2) {
  const counts = new Map();
  for (const i of incidents) {
    const t = (i.title || '').trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([title, count]) => ({ title, count }));
}

function countBreaches(incidents) {
  const breaches = {
    mtta: { high: 0, low: 0 },
    mttr: { high: 0, low: 0 }
  };
  for (const i of incidents) {
    const u = i.urgency;
    if (u !== 'high' && u !== 'low') continue;
    if (i._ackSec != null && i._ackSec * 1000 > SLO_MS.mtta[u]) breaches.mtta[u]++;
    if (i._resolveSec != null && i._resolveSec * 1000 > SLO_MS.mttr[u]) breaches.mttr[u]++;
  }
  return breaches;
}

async function summarize(window, teamIds) {
  const [allIncidents, analytics] = await Promise.all([
    getAllIncidents(window.start, window.end, teamIds),
    getAnalyticsMetrics(window.start, window.end, teamIds)
  ]);
  const metricsMap = new Map(analytics.map(a => [a.id, a]));

  const incidents = allIncidents.filter(isProduction);
  const nonProdExcluded = allIncidents.length - incidents.length;
  // Enrich each incident with PD's pre-computed metrics — these are PD's
  // authoritative MTTA/MTTR per incident, matching what the Insights UI
  // displays. The acknowledgements array on /incidents misses some signals
  // (auto-acks, log-entry events) that PD's analytics pipeline does count.
  for (const i of incidents) {
    const m = metricsMap.get(i.id);
    i._ackSec = m?.seconds_to_first_ack ?? null;
    i._resolveSec = m?.seconds_to_resolve ?? null;
  }
  const high = incidents.filter(i => i.urgency === 'high');
  const low = incidents.filter(i => i.urgency === 'low');

  const toMs = secs => secs == null ? null : secs * 1000;

  return {
    total: incidents.length,
    high: high.length,
    low: low.length,
    nonProdExcluded,
    mttaHighMs: toMs(avg(high.map(i => i._ackSec))),
    mttaLowMs: toMs(avg(low.map(i => i._ackSec))),
    mttrHighMs: toMs(avg(high.map(i => i._resolveSec))),
    mttrLowMs: toMs(avg(low.map(i => i._resolveSec))),
    recurringTitles: topRecurringTitles(incidents),
    breaches: countBreaches(incidents),
    highIncidents: high.map(i => ({
      id: i.id,
      title: i.title || i.summary || i.id,
      url: i.html_url
    }))
  };
}

export async function fetchPagerDuty({ current, previous }, team) {
  if (!process.env.PAGERDUTY_TOKEN) {
    throw new Error('PAGERDUTY_TOKEN not set in .env');
  }
  const teamIds = (team?.pagerdutyTeamIds || []).filter(Boolean);
  if (!teamIds.length) {
    throw new Error(`pagerdutyTeamIds not set for team "${team?.name}" in teams.json`);
  }

  const [curr, prev] = await Promise.all([
    summarize(current, teamIds),
    summarize(previous, teamIds)
  ]);

  return { current: curr, previous: prev };
}

// Fetch monthly summaries for an array of windows (oldest first). Used to drive
// trend charts; identical per-month logic to the regular fetch but stripped of
// the comparison/delta scaffolding (each window stands alone).
export async function fetchPagerDutyHistory(team, windows) {
  if (!process.env.PAGERDUTY_TOKEN) {
    throw new Error('PAGERDUTY_TOKEN not set in .env');
  }
  const teamIds = (team?.pagerdutyTeamIds || []).filter(Boolean);
  if (!teamIds.length) {
    throw new Error(`pagerdutyTeamIds not set for team "${team?.name}" in teams.json`);
  }
  return Promise.all(
    windows.map(async w => ({ label: w.label, ...(await summarize(w, teamIds)) }))
  );
}

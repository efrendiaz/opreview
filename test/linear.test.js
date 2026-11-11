import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openLinearBugsAtEndOf } from '../src/sources/linear.js';
import { fetchJira, fetchJiraHistory } from '../src/sources/jira.js';

const WINDOW = { label: '2026-10', start: '2026-10-01T04:00:00.000Z', end: '2026-11-01T04:00:00.000Z' };
const PREV = { label: '2026-09', start: '2026-09-01T04:00:00.000Z', end: '2026-10-01T04:00:00.000Z' };
const CFG = { team: 'WEBC', labels: ['Bug', 'type:bug'] };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function linearPage(nodes, hasNextPage = false, endCursor = null) {
  return { data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } };
}

test('open-at-end filter: team, bug labels, created before the end, neither completed nor canceled before it', async () => {
  process.env.LINEAR_API_KEY = 'k';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => linearPage([]) };
  };
  await openLinearBugsAtEndOf(WINDOW, CFG, { fetchImpl });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.linear.app/graphql');
  assert.equal(calls[0].init.headers.Authorization, 'k');
  assert.deepEqual(body.variables.filter, {
    team: { key: { eq: 'WEBC' } },
    labels: { some: { name: { in: ['Bug', 'type:bug'] } } },
    createdAt: { lt: WINDOW.end },
    and: [
      { or: [{ completedAt: { null: true } }, { completedAt: { gte: WINDOW.end } }] },
      { or: [{ canceledAt: { null: true } }, { canceledAt: { gte: WINDOW.end } }] }
    ]
  });
  assert.match(body.query, /includeArchived: true/);
});

test('maps issues to key/summary/url and follows pagination', async () => {
  process.env.LINEAR_API_KEY = 'k';
  const pages = [
    linearPage([{ identifier: 'WEBC-1', title: 'one', url: 'https://linear.app/babbel/issue/WEBC-1/one' }], true, 'c1'),
    linearPage([{ identifier: 'WEBC-2', title: 'two', url: 'https://linear.app/babbel/issue/WEBC-2/two' }])
  ];
  const cursors = [];
  const fetchImpl = async (_url, init) => {
    cursors.push(JSON.parse(init.body).variables.after);
    return { ok: true, json: async () => pages.shift() };
  };
  const issues = await openLinearBugsAtEndOf(WINDOW, CFG, { fetchImpl });
  assert.deepEqual(cursors, [null, 'c1']);
  assert.deepEqual(issues, [
    { key: 'WEBC-1', summary: 'one', url: 'https://linear.app/babbel/issue/WEBC-1/one', tracker: 'linear' },
    { key: 'WEBC-2', summary: 'two', url: 'https://linear.app/babbel/issue/WEBC-2/two', tracker: 'linear' }
  ]);
});

test('a GraphQL error is an error, not an empty bug list', async () => {
  process.env.LINEAR_API_KEY = 'k';
  const fetchImpl = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'bad filter' }] }) });
  await assert.rejects(openLinearBugsAtEndOf(WINDOW, CFG, { fetchImpl }), /bad filter/);
});

test('missing LINEAR_API_KEY is reported', async () => {
  delete process.env.LINEAR_API_KEY;
  await assert.rejects(openLinearBugsAtEndOf(WINDOW, CFG, { fetchImpl: async () => { throw new Error('no call'); } }), /LINEAR_API_KEY/);
});

// --- fetchJira: incidents stay on Jira, bugs move to Linear when configured ---
function routeFetch(log) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('linear.app')) {
      log.push(['linear', body.variables.filter.createdAt.lt]);
      return { ok: true, json: async () => linearPage([{ identifier: 'WEBC-9', title: 'bug', url: 'https://linear.app/x' }]) };
    }
    log.push(['jira', body.jql]);
    return { ok: true, json: async () => ({ issues: [{ key: 'BIM-1', fields: { summary: 'inc' } }] }) };
  };
}

function jiraEnv() {
  Object.assign(process.env, { JIRA_BASE_URL: 'https://j', JIRA_EMAIL: 'e', JIRA_TOKEN: 't', LINEAR_API_KEY: 'k' });
}

test('fetchJira takes bugs from Linear when the team sets linearBugs; incidents still come from Jira', async () => {
  jiraEnv();
  const log = [];
  globalThis.fetch = routeFetch(log);
  const team = { name: 'oranges', jiraJql: 'project = BIM', jiraBugsJql: 'project = ORNG AND type = Bug', linearBugs: CFG };
  const r = await fetchJira({ current: WINDOW, previous: PREV }, team);
  assert.equal(log.filter(([s]) => s === 'jira').length, 2);
  assert.ok(log.filter(([s]) => s === 'jira').every(([, jql]) => jql.startsWith('project = BIM')));
  assert.deepEqual(log.filter(([s]) => s === 'linear').map(([, end]) => end).sort(), [PREV.end, WINDOW.end]);
  assert.equal(r.current.bugs[0].key, 'WEBC-9');
  assert.equal(r.current.incidents[0].key, 'BIM-1');
});

test('fetchJira without linearBugs keeps the Jira bugs JQL', async () => {
  jiraEnv();
  const log = [];
  globalThis.fetch = routeFetch(log);
  const team = { name: 'x', jiraJql: 'project = BIM', jiraBugsJql: 'project = ORNG AND type = Bug' };
  await fetchJira({ current: WINDOW, previous: PREV }, team);
  assert.equal(log.filter(([s]) => s === 'linear').length, 0);
  assert.equal(log.filter(([, jql]) => String(jql).startsWith('project = ORNG')).length, 2);
});

test('fetchJiraHistory counts Linear bugs per window', async () => {
  jiraEnv();
  globalThis.fetch = routeFetch([]);
  const team = { name: 'oranges', jiraJql: 'project = BIM', jiraBugsJql: 'project = ORNG', linearBugs: CFG };
  assert.deepEqual(await fetchJiraHistory(team, [PREV, WINDOW]), [
    { label: '2026-09', incidents: 1, bugs: 1 },
    { label: '2026-10', incidents: 1, bugs: 1 }
  ]);
});

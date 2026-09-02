import { test } from 'node:test';
import assert from 'node:assert/strict';

import { otherTeamTopics } from '../src/teams.js';

const TEAMS = {
  oranges: { githubTopic: 'oranges' },
  pineapples: { githubTopic: 'pineapples' },
  kiwis: { githubTopic: 'pineapples' }, // same topic twice → dedupe
  mangos: {} // no githubTopic → ignored
};

test('otherTeamTopics returns the topics of every other team, deduplicated', () => {
  assert.deepEqual(otherTeamTopics(TEAMS, 'oranges'), ['pineapples']);
});

test('otherTeamTopics never includes the team\'s own topic even if another team reuses it', () => {
  assert.deepEqual(otherTeamTopics(TEAMS, 'kiwis'), ['oranges']);
});

test('otherTeamTopics is empty when the team is the only one configured', () => {
  assert.deepEqual(otherTeamTopics({ solo: { githubTopic: 'solo' } }, 'solo'), []);
});

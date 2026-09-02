import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TEAMS_PATH = resolve(process.cwd(), 'teams.json');

async function readTeamsFile() {
  let raw;
  try {
    raw = await readFile(TEAMS_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('teams.json not found. Copy teams.example.json to teams.json and fill in your team configs.');
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`teams.json is not valid JSON: ${err.message}`);
  }
  // Strip $comment / $schema-style metadata keys.
  return Object.fromEntries(
    Object.entries(parsed).filter(([k]) => !k.startsWith('$'))
  );
}

export async function listTeams() {
  const teams = await readTeamsFile();
  return Object.keys(teams);
}

// githubTopic values of every team except `name`, deduplicated and without the
// team's own topic. A repo tagged with any of these is "shared" in the report.
export function otherTeamTopics(teams, name) {
  const own = teams[name]?.githubTopic;
  const topics = Object.entries(teams)
    .filter(([k, t]) => k !== name && t.githubTopic && t.githubTopic !== own)
    .map(([, t]) => t.githubTopic);
  return [...new Set(topics)];
}

export async function loadTeam(name) {
  const teams = await readTeamsFile();
  const available = Object.keys(teams);
  if (!name) {
    throw new Error(`--team is required. Available: ${available.join(', ')}`);
  }
  const team = teams[name];
  if (!team) {
    throw new Error(`Unknown team "${name}". Available: ${available.join(', ')}`);
  }
  return { name, ...team, otherTeamTopics: otherTeamTopics(teams, name) };
}

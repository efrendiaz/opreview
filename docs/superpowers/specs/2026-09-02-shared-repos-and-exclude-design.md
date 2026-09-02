# GitHub: mark shared repos in the report; exclude repos per team

**Date:** 2026-09-02
**Status:** Approved

## Problem

1. Some repos carry the GitHub topic of more than one team (e.g.
   `usa-tech-common.js` is tagged both `oranges` and `pineapples`). In the
   per-repo Vulnerabilities / Dependabot PRs breakdown they look identical
   to a team's exclusive repos, so a reader can't tell which debt is owned
   by the team alone and which is shared with another team.
2. A repo can carry a team's topic but be irrelevant for the operational
   review (e.g. `lessonnine/flow-builder.prototype` for Oranges). The only
   way to drop it today is to remove the topic in GitHub, which affects
   everything else that uses the topic.

## Decision

1. A repo is **shared** when, besides the team's own topic, it carries the
   `githubTopic` of any other team configured in `teams.json`. Shared repos
   keep contributing to totals and charts unchanged; they are only labelled
   with a ` (shared)` suffix in the per-repo notes of the Vulnerabilities
   and Dependabot PRs rows. Repo counts are reported as
   `{ total, exclusive, shared }` in the JSON output.
2. A new optional per-team field `excludeRepos` (array of `org/repo`,
   case-insensitive) removes repos right after topic discovery, so the
   exclusion applies to the metrics table, the trend charts and Review Load
   alike.

## Design

- `src/teams.js`: `loadTeam()` attaches `otherTeamTopics` — the
  `githubTopic` values of every other team in `teams.json` (deduplicated,
  the team's own topic removed). Exposed as pure
  `otherTeamTopics(teams, name)` for testing.
- `src/sources/github.js`:
  - `isSharedRepo(repo, otherTeamTopics)` — true when `repo.topics`
    intersects `otherTeamTopics`. The Search API already returns `topics`.
  - `filterExcludedRepos(repos, excludeRepos)` — drops repos whose
    `full_name` is listed (case-insensitive). Empty/absent list is a no-op.
  - Both `fetchGitHub()` and `fetchGitHubHistory()` apply
    `filterExcludedRepos` immediately after `listReposByTopic`.
  - Snapshot items (alerts and Dependabot PRs) gain `shared: boolean`;
    `current.repos` becomes `{ total, exclusive, shared }`.
- Renderers (`markdown.js`, `html.js`, `storage.js`): `vulnsByRepoNote` and
  `prsByRepoNote` append ` (shared)` after the repo link when any item for
  that repo is flagged shared. Ordering unchanged.
- `teams.example.json` and README document `excludeRepos`.

## Tests (TDD)

- `test/github.test.js`: `isSharedRepo` (shared, exclusive, no topics,
  no other teams); `filterExcludedRepos` (removes, case-insensitive,
  empty/undefined list).
- `test/teams.test.js`: `otherTeamTopics` excludes own topic, dedupes,
  ignores teams without `githubTopic`.
- `test/output.test.js`: the three renderers show ` (shared)` only next to
  shared repos in both notes.

## Out of scope

- Separate totals or chart series for exclusive vs shared repos.
- Splitting Review Load by repo ownership.

## Addendum: Cursor and Copilot out of Review Load

Requested alongside this change. No code: the 2026-07-31 spec already
routes noisy bots through `excludeMembers`, so `cursor[bot]` and
`copilot-pull-request-reviewer[bot]` are added to `excludeMembers` for both
teams in `teams.json`. `excludeMembers` and `excludeRepos` are now documented
in `teams.example.json` and the README.

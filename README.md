# opreview

CLI for engineering managers. Gathers monthly operational review data from PagerDuty, Jira, Rollbar, and GitHub, renders it as a Confluence-shaped report (table + trend charts), and publishes the page directly to the team's Confluence folder.

Configure one or more teams in `teams.json` and the same CLI runs for each.

## What it produces

For each team, one Confluence page per month with:

- **Header**: team, date, review period, previous review period, owner
- **Team Metrics table**: PagerDuty (HU/Total alerts, MTTA, MTTR with SLO breach counts), Jira (open incidents and bugs at end of month, with ticket links), Rollbar (open errors at end of month), GitHub (open vulnerabilities and Dependabot PRs)
- **Trend charts**: PD alerts (stacked HU/LU), MTTA/MTTR with SLO threshold lines, Rollbar open backlog, Jira open backlog, GitHub open backlog (last 6 months for everything except GitHub which is last 2)
- **Empty section headers** for *Service Metrics* and *Action Items* — the team fills those in manually

The same content also lands locally as `.md`, `.html`, `.xml` (Confluence storage format), and `.json`.

## Timezone

Set `REPORT_TIMEZONE` in `.env` to your PagerDuty/Jira account's IANA timezone (e.g. `America/New_York`, `Europe/Berlin`) so the monthly window boundaries match what those UIs show. Leave unset and the boundaries are UTC midnight, which can pull in a few incidents the UIs treat as the previous month.

## Prerequisites

- Node.js 18+
- An Atlassian (Jira/Confluence) API token, a PagerDuty API token, Rollbar read tokens for your project(s), and a GitHub PAT
- A Confluence folder (or page) under which monthly reviews should live, one per team

## Setup

```bash
git clone <this repo>
cd opreview
npm install
cp .env.example .env            # fill in user-scoped tokens (see below)
cp teams.example.json teams.json # add an entry per team you manage
```

`.env` holds tokens tied to **you** — same across every team you manage. `teams.json` holds per-team selectors (PagerDuty team IDs, Jira JQL, Rollbar tokens, GitHub topic, Confluence folder ID). Both are gitignored.

## Getting tokens

### PagerDuty (`PAGERDUTY_TOKEN`)
1. Log in to PagerDuty via Okta.
2. Top-right avatar → **My Profile** → **User Settings** → **Create API User Token** (read-only is fine).
3. Paste into `PAGERDUTY_TOKEN` in `.env`.

### Atlassian / Jira / Confluence (`JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_BASE_URL`)
The same Atlassian token works for both Jira and Confluence.
1. https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token**.
2. `JIRA_EMAIL` is your Atlassian login email; `JIRA_TOKEN` is the new token; `JIRA_BASE_URL` is your instance root (e.g. `https://your-org.atlassian.net`).

### Rollbar (per-project tokens in `teams.json`; `ROLLBAR_ACCOUNT_SLUG` in `.env`)
Rollbar tokens are scoped to a single project, so each team needs one per project it watches.
1. In each Rollbar project: **Project Settings** → **Project Access Tokens** → create one with **read** scope.
2. Add the token strings into the team's `rollbarReadTokens` array in `teams.json`.
3. The script fetches both active and resolved items so it can compute end-of-month backlog snapshots and surface the top-3 noisiest errors.
4. Set `ROLLBAR_ACCOUNT_SLUG` in `.env` to your Rollbar account slug (the segment after `/a/` in any Rollbar URL). Optional — without it, top-3 titles render as plain text instead of clickable links.

### GitHub (`GITHUB_TOKEN`, `GITHUB_ORG`)
1. Generate a PAT at https://github.com/settings/tokens with `repo` and `security_events` scopes (or a fine-grained token with equivalent permissions).
2. `GITHUB_TOKEN` is the PAT; `GITHUB_ORG` is your GitHub organization name.
3. Tag each repo with a topic matching your team name (e.g. `team-a`, `team-b`). The script discovers repos via that topic.

### Wiz — *not yet wired*
OAuth is set up but the GraphQL query is a TODO; needs a service account with read access from the security team. Skipped at runtime if env vars are absent.

## Configuring a team

Each entry in `teams.json` looks like:

```json
{
  "your-team": {
    "displayName": "Your Team",
    "pagerdutyTeamIds": ["PXXXXXX"],
    "jiraJql": "project = INC AND \"responsible team[dropdown]\" = your-team ORDER BY created DESC",
    "jiraBugsJql": "project = YOUR AND type = Bug ORDER BY created DESC",
    "rollbarReadTokens": ["...", "..."],
    "wizProjectId": "",
    "githubTopic": "your-team",
    "confluenceParent": {
      "spaceKey": "XYZ",
      "folderId": "1234567890"
    }
  }
}
```

### Where each value comes from

| Field | How to find it |
|---|---|
| `pagerdutyTeamIds` | Open the PD team page; the ID is in the URL (`PXXXXXX`). Comma-separated array if multiple. |
| `jiraJql` | The JQL you'd run manually to find your team's incidents. Date range gets appended automatically. |
| `jiraBugsJql` | Same, but for bugs (typically a different project). |
| `rollbarReadTokens` | One token per Rollbar project the team watches. |
| `githubTopic` | The GitHub repo topic that identifies your team's repos in the org. |
| `confluenceParent.spaceKey` / `.folderId` | Open the parent Confluence folder; the ID is in the URL after `/folder/`. Space key is the short uppercase ID. |

## Running it

```bash
# Generate the review locally (no publish):
node src/index.js --team your-team

# Generate for a specific month:
node src/index.js --team your-team --month 2026-04

# Verify Confluence access before first publish:
node src/index.js --team your-team --check-confluence

# Generate AND publish to Confluence (idempotent: creates first time, updates after):
node src/index.js --team your-team --month 2026-04 --publish

# Sanity-check one source in isolation while testing tokens:
node src/index.js --team your-team --only pagerduty --month 2026-04

# List the teams configured in teams.json:
node src/index.js --list-teams
```

Default `--history 6` pulls 6 months of trend data; pass `--history 0` to skip charts entirely.

### Confluence publish flow

The first `--publish` for a team creates a page titled `{Month} Operational Review [{Team}]` under the team's `confluenceParent.folderId` and uploads the trend PNGs as page attachments. Re-running with `--publish` finds the page by title and updates it (incrementing the version) — so you can re-run safely after you tweak data, JQLs, or charts.

If `--check-confluence` reports anything off (wrong space, missing permissions, unknown folder), publishing won't work; fix those first.

## Output files

```
out/
├── op-review-<team>-YYYY-MM.md          # markdown source (also printed to stdout)
├── op-review-<team>-YYYY-MM.html        # browser-renderable copy
├── op-review-<team>-YYYY-MM.xml         # Confluence storage format actually published
├── op-review-<team>-YYYY-MM.json        # raw data — useful for debugging or scripting
└── op-review-<team>-YYYY-MM-trend-*.{svg,png}
```

The PNGs get uploaded as Confluence attachments when you `--publish`; the SVGs are kept locally for inspection.

## Architecture

```
src/
├── index.js              # CLI: arg parsing, orchestration, output, publish
├── config.js             # date-range and history-window math
├── teams.js              # loads teams.json, resolves --team
├── confluence.js         # API client: auth check, find/create/update page, upload attachment
├── sources/
│   ├── pagerduty.js      # incidents, MTTA/MTTR, SLO breach count, recurring titles
│   ├── jira.js           # open-at-end-of-month snapshots for incidents and bugs
│   ├── rollbar.js        # open-at-end-of-month snapshots across project tokens
│   ├── github.js         # Dependabot alerts + PRs by topic
│   └── wiz.js            # auth wired, query TODO
└── output/
    ├── markdown.js       # the .md report
    ├── html.js           # the .html report
    ├── storage.js        # Confluence storage format (.xml) — what gets published
    └── charts.js         # SVG bar/line chart helpers + sharp-based PNG conversion
```

Each source exports `fetchX(range, team)`; trend-aware sources also export `fetchXHistory(team, windows)`. Failures in one source surface as an `error` in the output table without breaking the rest of the run.

## Troubleshooting

- **`Fatal: fetch failed`** — usually a transient blip in one of the upstream APIs. Re-run.
- **`Confluence ... → 404` on publish** — the parent folder ID in `teams.json` is wrong, or your token doesn't have edit access. Re-run with `--check-confluence` to localise.
- **GitHub secondary rate limit** — should be rare with the current implementation, but if you hit it, wait a few minutes.
- **MTTA/MTTR shows `N/A`** — no incidents of that urgency were acknowledged/resolved in the period. Not an error.

## Future work

- Wire Wiz once a security-managed service account exists.
- Default `--history` to a per-source value (e.g. GitHub stays at 2, others at 6) without manual slicing in `index.js`.
- Cache long paginations between runs so prep iterations are fast.
- Action-item carry-forward: pull last month's open action items from the previous Confluence page.

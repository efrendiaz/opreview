# opreview on tools.babbel — design

**Date:** 2026-05-26
**Author:** Efren Diaz (with Claude Code)
**Status:** Draft for review

## Goal

Run opreview as an internal web app on `lessonnine/tools.babbel` so engineering
managers can generate and view the monthly operational review in the browser
(behind Okta) instead of running the CLI locally with personal tokens.
Everything is **on demand**: the manager picks a team and month, previews the
generated report, and then publishes manually. **Confluence stays the canonical
destination**, and **publishing is a deliberate manual action the manager takes
after reviewing the report.** No scheduled jobs.

## Context

- **Today:** opreview is a Node ESM CLI. Each EM runs `node src/index.js --team X
  --month YYYY-MM [--publish]` with user-scoped tokens in `.env`. It gathers
  PagerDuty / Jira / Rollbar / GitHub data, renders Markdown/HTML/Confluence-XML
  + trend charts, and (with `--publish`) creates/updates a Confluence page.
- **Target platform (`tools.babbel`):** a self-service internal-app host (DevEx /
  Backend Platform). Key facts that shape this design:
  - **Stack:** Node 22, TypeScript, **Express + express-handlebars**, Prisma +
    Postgres. Already depends on `octokit`, `@octokit/auth-app`, `p-limit`,
    AWS SDK.
  - **App mounting:** each app lives in `apps/<name>/`; the host auto-mounts
    `apps/<name>/routes.ts` (or `routes.js`). A `tsx` CJS/ESM bridge lets
    plain **JS ESM modules run as-is** alongside TS.
  - **CLI / jobs:** convention `apps/<name>/cli/main.ts` exporting `run(argv)`,
    invoked via `bctl <app> <command>`. Scheduled work hangs off this; the cron
    trigger itself is configured by the platform.
  - **Secrets:** `TOOLS_CREDENTIALS` env var holds a JSON object loaded from the
    `tools.credentials` AWS secret. No per-user `.env` in production.
  - **Auth:** Okta is preconfigured by the platform — the app does not implement
    auth.
  - **Deploy:** branch → PR → merge (no approvals) → live. Prisma migrations run
    at container boot.

## Approach

**Approach A — vendor the opreview core (JS) and add a thin TS app layer.**
Chosen over publishing opreview as an npm package (B — heavier versioning/registry,
fights the "contained in one folder" model) and over a full TS rewrite (C — most
effort/risk; the platform tolerates JS).

### Layout

```
apps/opreview/
├── core/                # opreview logic, copied ~as-is (JS ESM)
│   ├── config.js
│   ├── confluence.js
│   ├── teams.js         # adapted: load committed config, no secrets
│   ├── sources/         # pagerduty, jira, rollbar, github, wiz
│   └── output/          # markdown, html, storage, charts
├── credentials.ts       # reads TOOLS_CREDENTIALS → process.env shape core expects
├── teams.config.json    # per-team selectors, NO secrets (committed)
├── routes.ts            # Express routes + UI (Okta-gated by platform)
├── views/               # handlebars templates for the UI
└── styles.css
```

### Why vendor (not import)

The core modules are framework-agnostic and already battle-tested. Copying them
keeps the app self-contained (platform requirement), avoids a private registry,
and lets the `tsx` bridge run them unchanged. Cost: drift between the two copies.
Mitigation: keep `core/` a verbatim copy with a header comment pointing at the
source repo + commit, and treat the standalone opreview repo as the source of
truth for logic changes (port deltas over in small PRs).

## Components

### 1. Credentials adapter (`credentials.ts`)

The core reads tokens from `process.env` (`PAGERDUTY_TOKEN`, `JIRA_EMAIL`,
`JIRA_TOKEN`, `JIRA_BASE_URL`, `GITHUB_TOKEN`, `GITHUB_ORG`, `ROLLBAR_ACCOUNT_SLUG`,
`REPORT_TIMEZONE`, per-team Rollbar tokens). The adapter parses
`TOOLS_CREDENTIALS` once at startup and populates the values the core expects, so
**core stays unmodified**. Per-project Rollbar tokens move out of `teams.json`
into `TOOLS_CREDENTIALS` (keyed by team), referenced by name from
`teams.config.json`.

### 2. Team configuration (UI-managed, Postgres)

The app must let a manager **enter and edit a team's configuration through the
UI** (no hand-editing `teams.json`). This is the full set of values opreview
needs today, split into non-secret **selectors** (UI-editable, stored in
Postgres) and **secrets** (kept in `TOOLS_CREDENTIALS`, never typed into the UI
— see the open question below if that should change):

**Per-team selectors (UI form → `app_opreview.team_config`):**
- `displayName`
- `confluenceParent.spaceKey` + `confluenceParent.folderId`
- `pagerdutyTeamIds[]`
- `jiraJql`, `jiraBugsJql`
- `githubTopic`
- `infraRepos[]`, `excludeMembers[]`
- (optional, only if those sources get used) `wizProjectId`,
  `speedcurveSiteIds[]`

**Shared/global selectors (set once, also UI-editable or env):**
- `JIRA_BASE_URL`, `GITHUB_ORG`, `ROLLBAR_ACCOUNT_SLUG`, `REPORT_TIMEZONE`

**Secrets — storage location DEFERRED (Efren to consult):**
- `PAGERDUTY_TOKEN`, `JIRA_EMAIL` + `JIRA_TOKEN` (also used for Confluence),
  GitHub auth (PAT or GitHub App), per-team Rollbar read tokens,
  SpeedCurve/Wiz secrets if ever wired.
- Three candidate models (see Open investigation items): all in
  `TOOLS_CREDENTIALS`; all via the UI (encrypted in Postgres); or hybrid
  (shared in `TOOLS_CREDENTIALS`, per-team Rollbar via UI). The design is
  unblocked either way — only the credentials adapter's source changes.

Persistence comes back into v1 **for configuration** (not report caching): a
Prisma model in schema `app_opreview` holds one row per team plus a singleton
row for the shared selectors. The credentials adapter (component 1) still
sources secrets from `TOOLS_CREDENTIALS`, matching per-team Rollbar tokens to
the team by name.

### 3. Web UI (`routes.ts` + views)

- `GET /` — landing. If the manager has at least one saved team, show team +
  month pickers straight away (the common case: a returning EM **just picks the
  period**). If no team is configured yet, route to the setup form.
- `GET /config` / `POST /config` — first-run setup and later edits: the form
  that captures the per-team selectors from component 2 and saves them to
  Postgres, so config is entered **once** and reused on every return.
- `GET /report?team=X&month=YYYY-MM` — generate and render the report inline:
  the metrics table + trend charts (inline **SVG** in the browser, no
  rasterization needed) + the per-repo vulnerabilities/Dependabot breakdown.
  Month defaults to the last full month but **any historical month** is
  selectable (reject future months and anything before a sane floor).
  Generation is synchronous (multi-source API calls); show a loading state.
- `POST /publish` — manager-triggered: render Confluence storage XML, publish
  (create/update by title), upload chart PNGs. Returns the Confluence page URL.
  This is the **manual step after review**.

### 4. Persistence (Postgres) — config only

Per-app schema `app_opreview` holds the team configuration so it survives
across sessions: the EM configures a team once, then on every later visit only
chooses the period. Prisma models: `team_config` (one row per team) and a
singleton `shared_config` for the global selectors. **No report caching in
v1** — reports are generated on demand; add a `(team, month)` cache later only
if multi-source latency proves painful.

## Data flow

1. **First run (once per team):** manager fills the config form → saved to
   Postgres.
2. **Select:** on return, manager picks an already-configured team + any month.
3. **Generate & review:** `GET /report` gathers sources + renders → manager
   reviews the numbers in the browser.
4. **Publish (manual):** manager clicks Publish → `POST /publish` → Confluence
   create/update + chart attachments → page URL shown.
5. **Narrative sections:** Service Metrics / Action Items are filled by the
   manager in Confluence (as today); re-publishing preserves them
   (`preserveManualSections`, already implemented in `confluence.js`).

## Open investigation items

These came out of the "credentials: to explore" decision and must be resolved
during implementation (likely with Backend Platform):

1. **GitHub auth** — does `TOOLS_CREDENTIALS` already expose a GitHub App
   (the platform uses `@octokit/auth-app`)? If so, the GitHub source should use
   an installation token instead of a personal PAT. Confirm the App has
   `dependabot_alerts:read`, `pull_requests:read`, `contents:read`, `metadata`.
2. **PagerDuty / Jira+Confluence / Rollbar service accounts** — do read-only
   service accounts exist? If not, bootstrap with Efren's current tokens in
   `TOOLS_CREDENTIALS` and migrate to service accounts later. Confluence writes
   (publish) need an account with edit access to each team's parent folder.
3. **Charts / `sharp`** — Confluence needs PNG attachments (it strips inline
   SVG). `sharp` is a native dep not currently in tools.babbel. Options: (a) add
   `sharp` and confirm it builds in their Docker image; (b) use a pure-JS SVG→PNG
   path; (c) publish charts as SVG-derived PNGs generated elsewhere. The web UI
   itself needs no rasterization (inline SVG).
4. **Secrets storage (DEFERRED — Efren to consult)** — whether tokens live in
   `TOOLS_CREDENTIALS`, are entered via the UI (encrypted in Postgres), or a
   hybrid. Pick before the credentials adapter is finalized; does not block the
   rest of the build.

## Error handling

- Per-source failures already degrade gracefully in the core (a source error
  surfaces as an `error` cell, the rest of the report renders). Preserve this.
- `POST /publish` must surface Confluence API errors (wrong folder, missing edit
  permission) to the UI with the underlying message, not a generic 500.
- Missing/incomplete `TOOLS_CREDENTIALS` keys: fail fast at startup with a clear
  message naming the missing key (mirror the platform's `dora` warning pattern).

## Testing

- Port/keep any existing core behavior; add route tests using `supertest`
  (already a devDep) for `/config`, `/report`, and `/publish` (mock the core +
  Confluence client; use a test Postgres schema for config round-trips).
- A smoke test that the app mounts and `/` renders.
- A render-only path (e.g. `/report` without publish) for safe manual
  verification against real sources before publishing.

## Out of scope (v1, YAGNI)

- Editing Service Metrics / Action Items inside the tools.babbel UI (stay in
  Confluence).
- Any scheduled/automated runs — generation and publishing are always manual,
  on demand.
- Auto-publishing — publish is always a manual button after review.
- Report caching in Postgres (config is persisted; reports are regenerated).
- Wiz (still a TODO in the core).

## Risks

- **Core/vendor drift** between the standalone repo and `apps/opreview/core/`.
- **`sharp` in Docker** may need build tooling; if it's painful, charts for
  Confluence become the long pole.
- **Service-account availability** is the main external dependency; the UI can
  ship on Efren's tokens but that runs as "him".

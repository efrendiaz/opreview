# opreview on tools.babbel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Where this runs:** This plan is executed **inside the `lessonnine/tools.babbel` repo**, not in the opreview repo where it was written. Clone tools.babbel, branch, and work under `apps/opreview/`. The opreview repo remains the source of truth for the vendored `core/` logic.

**Goal:** Ship opreview as an on-demand internal web app under `apps/opreview/` in tools.babbel: a manager picks a team + any month, previews the rendered operational review in the browser, and publishes to Confluence with a button. Team config is entered once and persisted.

**Architecture:** Vendor opreview's framework-agnostic JS core (`sources/`, `output/`, `config.js`, `confluence.js`) into `apps/opreview/core/` unchanged; add a thin TypeScript layer (Express `routes.ts`, a credentials adapter, a Postgres-backed config store, handlebars views). The platform auto-mounts `apps/opreview/routes.ts`, provides Okta auth, secrets via `TOOLS_CREDENTIALS`, and Prisma+Postgres.

**Tech Stack:** Node 22, TypeScript, Express, express-handlebars, Prisma + Postgres, `tsx` CJS/ESM bridge, vitest + supertest. Charts: opreview's SVG (inline in UI) + `sharp` for Confluence PNGs (see Task 9).

---

## Reference files in tools.babbel (read these first)

The platform glue must match existing conventions. Before coding, read:
- `src/app.ts` — how apps auto-mount (`apps/<name>/routes.ts`), the `tsx/cjs` + `tsx/esm/api` bridge that lets JS ESM run.
- `apps/dora/routes.ts` — the canonical `express.Router()` app: route handlers, reading secrets via a `src/lib/*-token` helper, loading static files with `__dirname`.
- `apps/dora/index.html` + `styles.css` — static asset serving pattern for an app UI.
- `src/prisma/client.ts` and `src/prisma/apps/*.ts` — the per-app Prisma helper pattern (e.g. `doraDb`). New apps add their `@@schema("app_opreview")` models and a helper.
- `prisma/schema.prisma` — add the app's schema name to the datasource `schemas = [...]` list; migrations live in `prisma/migrations/`.
- `AGENTS.md` §bctl and "Adding a CLI" — only relevant if a CLI is ever added (not in v1; no scheduled jobs).
- `.env.example` + README "Environment variables" — the `TOOLS_CREDENTIALS` JSON contract.

## Source files to vendor from the opreview repo

Copy verbatim from `<opreview>/src/` into `apps/opreview/core/` (Task 1):
`config.js`, `confluence.js`, `teams.js` (will be bypassed — see Task 4),
`sources/{pagerduty,jira,rollbar,github,wiz}.js`, `output/{markdown,html,storage,charts}.js`.

## Credentials & selectors contract (from the spec)

- **Selectors (non-secret, persisted in Postgres, UI-editable):** per team —
  `displayName`, `confluenceParent.spaceKey`, `confluenceParent.folderId`,
  `pagerdutyTeamIds[]`, `jiraJql`, `jiraBugsJql`, `githubTopic`, `infraRepos[]`,
  `excludeMembers[]`. Shared — `jiraBaseUrl`, `githubOrg`, `rollbarAccountSlug`,
  `reportTimezone`.
- **Secrets (in `TOOLS_CREDENTIALS`):** `PAGERDUTY_TOKEN`, `JIRA_EMAIL`,
  `JIRA_TOKEN`, `GITHUB_TOKEN` (or GitHub App), per-team Rollbar read tokens
  (keyed `ROLLBAR_<TEAM>` → array). **DEFERRED decision** (Efren consulting):
  secrets could instead be UI-entered/encrypted; if so, only Task 4 changes.

---

## Phase 1 — App runs on the platform and renders a report

### Task 1: Scaffold the app and vendor the core

**Files:**
- Create: `apps/opreview/core/` (copied tree — see "Source files to vendor")
- Create: `apps/opreview/core/VENDORED.md`
- Create: `apps/opreview/routes.ts` (placeholder)
- Test: `apps/opreview/core/core.smoke.test.ts`

- [ ] **Step 1: Copy the core tree** from the opreview repo into `apps/opreview/core/` preserving structure (`config.js`, `confluence.js`, `sources/*.js`, `output/*.js`). Do not edit them yet.

- [ ] **Step 2: Add provenance note** `apps/opreview/core/VENDORED.md`:

```markdown
# Vendored opreview core
Copied verbatim from the opreview repo (source of truth for this logic).
Source commit: <fill in the opreview git SHA you copied from>.
Do not hand-edit here — change in opreview and re-copy, keeping diffs small.
```

- [ ] **Step 3: Write a smoke test** `apps/opreview/core/core.smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getDateRange } from './config.js';

describe('vendored core', () => {
  it('computes a month range usable by the app', () => {
    const r = getDateRange('2026-04');
    expect(r.label).toBe('2026-04');
    expect(r.prevLabel).toBe('2026-03');
    expect(new Date(r.current.start).getUTCMonth()).toBe(3); // April = 3
  });
});
```

- [ ] **Step 4: Add a placeholder route** so the app mounts. `apps/opreview/routes.ts`:

```ts
import { Router, type Request, type Response } from 'express';
const router = Router();
router.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));
export default router;
```

- [ ] **Step 5: Run the smoke test**

Run: `npm test -- apps/opreview/core/core.smoke.test.ts`
Expected: PASS. (If `getDateRange` import fails, the `tsx` ESM bridge in `src/app.ts` is what makes `.js` ESM importable from `.ts` — confirm the test runner picks up the same bridge; vitest uses native ESM so `.js` imports resolve directly.)

- [ ] **Step 6: Verify the app mounts** — `npm run dev`, open `http://localhost:3000/opreview/health`, expect `{"ok":true}`.

- [ ] **Step 7: Commit**

```bash
git add apps/opreview
git commit -m "feat(opreview): scaffold app and vendor core"
```

### Task 2: Credentials adapter

**Files:**
- Create: `apps/opreview/credentials.ts`
- Test: `apps/opreview/credentials.test.ts`

The core reads `process.env.PAGERDUTY_TOKEN`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_BASE_URL`, `GITHUB_TOKEN`, `GITHUB_ORG`, `ROLLBAR_ACCOUNT_SLUG`, `REPORT_TIMEZONE`. The adapter maps `TOOLS_CREDENTIALS` (+ shared config) into those names without touching the core.

- [ ] **Step 1: Write the failing test** `apps/opreview/credentials.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSecrets, rollbarTokensFor } from './credentials.js';

beforeEach(() => {
  process.env.TOOLS_CREDENTIALS = JSON.stringify({
    PAGERDUTY_TOKEN: 'pd', JIRA_EMAIL: 'a@b.com', JIRA_TOKEN: 'jt',
    GITHUB_TOKEN: 'gh', ROLLBAR_ORANGES: ['r1', 'r2'],
  });
});

describe('credentials adapter', () => {
  it('hydrates core env names from TOOLS_CREDENTIALS', () => {
    loadSecrets();
    expect(process.env.PAGERDUTY_TOKEN).toBe('pd');
    expect(process.env.JIRA_TOKEN).toBe('jt');
    expect(process.env.GITHUB_TOKEN).toBe('gh');
  });
  it('resolves per-team rollbar tokens by team name', () => {
    expect(rollbarTokensFor('oranges')).toEqual(['r1', 'r2']);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './credentials.js'`).
Run: `npm test -- apps/opreview/credentials.test.ts`

- [ ] **Step 3: Implement** `apps/opreview/credentials.ts`:

```ts
// Maps the platform's TOOLS_CREDENTIALS secret bag onto the env var names the
// vendored core reads, so core stays unmodified. Per-team Rollbar tokens are
// stored as ROLLBAR_<TEAM> arrays. Shared non-secret selectors come from the
// config store (Task 5), not here.
type Bag = Record<string, unknown>;

function bag(): Bag {
  try { return JSON.parse(process.env.TOOLS_CREDENTIALS || '{}') as Bag; }
  catch { return {}; }
}

const PASS_THROUGH = [
  'PAGERDUTY_TOKEN', 'JIRA_EMAIL', 'JIRA_TOKEN', 'GITHUB_TOKEN',
] as const;

export function loadSecrets(): void {
  const b = bag();
  for (const key of PASS_THROUGH) {
    const v = b[key];
    if (typeof v === 'string' && v) process.env[key] = v;
  }
}

export function rollbarTokensFor(team: string): string[] {
  const v = bag()[`ROLLBAR_${team.toUpperCase()}`];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
```

- [ ] **Step 4: Run the test — expect PASS.**

- [ ] **Step 5: Commit** `git add apps/opreview/credentials.* && git commit -m "feat(opreview): TOOLS_CREDENTIALS adapter"`

### Task 3: Report service (wire core to a team + month)

**Files:**
- Create: `apps/opreview/report-service.ts`
- Test: `apps/opreview/report-service.test.ts`

Bridges a config object → the `team` shape the core expects and runs the same gather+render pipeline as opreview's `src/index.js`, but returns the rendered artifacts instead of writing files.

- [ ] **Step 1: Write the failing test** (mocks the source fetchers so no network):

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('./core/sources/pagerduty.js', () => ({
  fetchPagerDuty: async () => ({ current: { total: 1, high: 0 }, previous: { total: 0 } }),
  fetchPagerDutyHistory: async () => [],
  formatDuration: (ms: number | null) => (ms == null ? 'N/A' : `${ms}ms`),
  SLO_MS: { mtta: { high: 1, low: 1 }, mttr: { high: 1, low: 1 } },
}));
vi.mock('./core/sources/jira.js', () => ({ fetchJira: async () => ({ current: { incidents: [], bugs: [] }, previous: { incidents: [], bugs: [] } }), fetchJiraHistory: async () => [] }));
vi.mock('./core/sources/rollbar.js', () => ({ fetchRollbar: async () => ({ current: { count: 0, openTotal: 0 } }), fetchRollbarHistory: async () => [] }));
vi.mock('./core/sources/github.js', () => ({ fetchGitHub: async () => ({ current: { vulnerabilities: { total: 0, bySeverity: {}, items: [] }, dependabotPRs: { total: 0, items: [] } }, previous: {} }), fetchGitHubHistory: async () => [] }));
vi.mock('./core/sources/wiz.js', () => ({ fetchWiz: async () => ({ current: { _skipped: 'off' } }) }));

import { generateReport } from './report-service.js';

const team = { name: 'oranges', displayName: 'Oranges', pagerdutyTeamIds: ['P1'], jiraJql: 'x', jiraBugsJql: 'y', githubTopic: 'oranges', confluenceParent: { spaceKey: 'RNG', folderId: '1' } };

describe('generateReport', () => {
  it('returns html, storage, title and charts for a month', async () => {
    const out = await generateReport(team as any, '2026-04', { history: 0 });
    expect(out.title).toContain('Oranges');
    expect(out.html).toContain('Team Metrics');
    expect(Array.isArray(out.charts)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** `apps/opreview/report-service.ts`:

```ts
import { loadSecrets, rollbarTokensFor } from './credentials.js';
import { getDateRange, getHistoryRanges } from './core/config.js';
import { fetchPagerDuty, fetchPagerDutyHistory } from './core/sources/pagerduty.js';
import { fetchJira, fetchJiraHistory } from './core/sources/jira.js';
import { fetchRollbar, fetchRollbarHistory } from './core/sources/rollbar.js';
import { fetchGitHub, fetchGitHubHistory } from './core/sources/github.js';
import { fetchWiz } from './core/sources/wiz.js';
import { renderHtml } from './core/output/html.js';
import { renderStorage, renderStorageTitle } from './core/output/storage.js';
import { renderTrendCharts, svgToPng } from './core/output/charts.js';

export interface TeamConfig {
  name: string; displayName: string;
  pagerdutyTeamIds: string[]; jiraJql: string; jiraBugsJql: string;
  githubTopic: string; infraRepos?: string[]; excludeMembers?: string[];
  rollbarReadTokens?: string[];
  confluenceParent: { spaceKey: string; folderId: string };
}

export interface GeneratedReport {
  title: string; html: string; storage: string;
  charts: { name: string; svg: string; png: Buffer }[];
  range: ReturnType<typeof getDateRange>;
  data: Record<string, unknown>;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (e) { return { error: (e as Error).message }; }
}

export async function generateReport(
  team: TeamConfig, month: string, opts: { history?: number } = {}
): Promise<GeneratedReport> {
  loadSecrets();
  // The core's Rollbar source reads team.rollbarReadTokens; inject from secrets.
  const t = { ...team, rollbarReadTokens: team.rollbarReadTokens ?? rollbarTokensFor(team.name) };
  const range = getDateRange(month);
  const history = opts.history ?? 6;

  const [pagerduty, jira, rollbar, github, wiz] = await Promise.all([
    safe(() => fetchPagerDuty(range, t)),
    safe(() => fetchJira(range, t)),
    safe(() => fetchRollbar(range, t)),
    safe(() => fetchGitHub(range, t)),
    safe(() => fetchWiz(range, t)),
  ]);
  const data: Record<string, unknown> = { pagerduty, jira, rollbar, github, wiz };

  let charts: GeneratedReport['charts'] = [];
  if (history > 0) {
    const windows = getHistoryRanges(month, history);
    const ghWindows = windows.slice(-2);
    const [pd, rb, jh, gh] = await Promise.all([
      safe(() => fetchPagerDutyHistory(t, windows)),
      safe(() => fetchRollbarHistory(t, windows)),
      safe(() => fetchJiraHistory(t, windows)),
      safe(() => fetchGitHubHistory(t, ghWindows)),
    ]);
    const pick = <V>(v: V | { error: string }) => ('error' in (v as object) ? null : (v as V));
    const svgs = renderTrendCharts(
      { pd: pick(pd), rollbar: pick(rb), jira: pick(jh), github: pick(gh) }, t
    );
    charts = await Promise.all(svgs.map(async c => ({ ...c, png: await svgToPng(c.svg) })));
  }

  const chartFilenames = charts.map(c => `trend-${c.name}.png`);
  const html = renderHtml(range, data, t);
  const storage = renderStorage(range, data, t, { chartFilenames, ownerAccountId: null });
  const title = renderStorageTitle(range, t);
  return { title, html, storage, charts, range, data };
}
```

- [ ] **Step 4: Run the test — expect PASS.** Fix import-path/shape mismatches against the actual vendored modules (e.g. confirm `renderHtml(range, data, team)` and `renderStorage(range, data, team, opts)` signatures match the copied `output/*.js`).

- [ ] **Step 5: Commit** `git add apps/opreview/report-service.* && git commit -m "feat(opreview): report generation service"`

### Task 4: `/report` route renders inline (no DB yet — use a temp inline team)

**Files:**
- Modify: `apps/opreview/routes.ts`
- Create: `apps/opreview/views/report.handlebars`
- Test: `apps/opreview/routes.report.test.ts`

To prove end-to-end rendering before the config store exists, accept a team from a temporary in-memory map keyed by name. (Replaced by the DB store in Task 6.)

- [ ] **Step 1: Write the failing test** (mock report-service):

```ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('./report-service.js', () => ({
  generateReport: async () => ({ title: 'April Operational Review [Oranges]', html: '<table>Team Metrics</table>', storage: '<x/>', charts: [], range: { label: '2026-04' }, data: {} }),
}));
import router from './routes.js';

const app = express().use('/opreview', router);

describe('GET /opreview/report', () => {
  it('renders the report html for a known team', async () => {
    const res = await request(app).get('/opreview/report?team=oranges&month=2026-04');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Team Metrics');
  });
  it('400s on bad month', async () => {
    const res = await request(app).get('/opreview/report?team=oranges&month=2026-13');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** the `/report` handler in `apps/opreview/routes.ts` (replace placeholder). Render inline SVG charts directly (no PNG needed for the browser):

```ts
import { Router, type Request, type Response } from 'express';
import { generateReport } from './report-service.js';

const router = Router();

// TEMP inline teams until the config store lands (Task 6).
const TEMP_TEAMS: Record<string, any> = {
  oranges: { name: 'oranges', displayName: 'Oranges', pagerdutyTeamIds: [], jiraJql: '', jiraBugsJql: '', githubTopic: 'oranges', confluenceParent: { spaceKey: 'RNG', folderId: '0' } },
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

router.get('/health', (_req, res) => res.json({ ok: true }));

router.get('/report', async (req: Request, res: Response) => {
  const team = String(req.query.team || '');
  const month = String(req.query.month || '');
  if (!MONTH_RE.test(month)) { res.status(400).send('month must be YYYY-MM'); return; }
  const cfg = TEMP_TEAMS[team];
  if (!cfg) { res.status(404).send(`unknown team "${team}"`); return; }
  try {
    const report = await generateReport(cfg, month);
    const chartsSvg = report.charts.map(c => c.svg).join('\n');
    res.render('report', { title: report.title, body: report.html, chartsSvg });
  } catch (e) {
    res.status(502).send(`generation failed: ${(e as Error).message}`);
  }
});

export default router;
```

- [ ] **Step 4: Add the view** `apps/opreview/views/report.handlebars`:

```handlebars
<h1>{{title}}</h1>
<section class="report">{{{body}}}</section>
<section class="charts">{{{chartsSvg}}}</section>
```

(Use triple-stache `{{{ }}}` — the body and SVG are trusted server-rendered markup. Confirm the platform's handlebars setup in `src/app.ts` resolves app-local views, or register `apps/opreview/views` as an extra views dir per the platform's convention.)

- [ ] **Step 5: Run the test — expect PASS.**

- [ ] **Step 6: Manual check** — `npm run dev`, open `/opreview/report?team=oranges&month=2026-04` with real `TOOLS_CREDENTIALS` set locally; confirm the table + charts render.

- [ ] **Step 7: Commit** `git add apps/opreview && git commit -m "feat(opreview): /report renders inline"`

### Task 5: `POST /publish` to Confluence

**Files:**
- Modify: `apps/opreview/routes.ts`
- Test: `apps/opreview/routes.publish.test.ts`

- [ ] **Step 1: Write the failing test** (mock the vendored confluence client + report-service):

```ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('./report-service.js', () => ({ generateReport: async () => ({ title: 'T', html: '<i/>', storage: '<s/>', charts: [{ name: 'pd-alerts', svg: '<svg/>', png: Buffer.from('x') }], range: {}, data: {} }) }));
vi.mock('./core/confluence.js', () => ({
  publishPage: async () => ({ page: { id: '42', title: 'T', version: { number: 2 }, _links: { webui: '/x' } }, created: false }),
  uploadAttachment: async () => ({ id: 'att1', version: { number: 1 } }),
  pageWebUrl: () => 'https://confluence/x',
}));
import router from './routes.js';
const app = express().use(express.json()).use('/opreview', router);

describe('POST /opreview/publish', () => {
  it('publishes and returns the page url', async () => {
    const res = await request(app).post('/opreview/publish').send({ team: 'oranges', month: '2026-04' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://confluence/x');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** the publish handler (append to `routes.ts`):

```ts
import { publishPage, uploadAttachment, pageWebUrl } from './core/confluence.js';

router.post('/publish', async (req: Request, res: Response) => {
  const { team, month } = req.body ?? {};
  if (!MONTH_RE.test(String(month))) { res.status(400).json({ error: 'month must be YYYY-MM' }); return; }
  const cfg = TEMP_TEAMS[String(team)];
  if (!cfg) { res.status(404).json({ error: `unknown team "${team}"` }); return; }
  try {
    const report = await generateReport(cfg, String(month));
    const { page } = await publishPage(cfg, report.title, report.storage);
    for (const c of report.charts) {
      await uploadAttachment(page.id, `trend-${c.name}.png`, c.png, 'image/png');
    }
    res.json({ url: pageWebUrl(page), version: page.version?.number });
  } catch (e) {
    // Surface the real Confluence error (wrong folder / no edit access), not a 500.
    res.status(502).json({ error: (e as Error).message });
  }
});
```

- [ ] **Step 4: Run the test — expect PASS.**

- [ ] **Step 5: Commit** `git add apps/opreview && git commit -m "feat(opreview): manual publish to Confluence"`

---

## Phase 2 — Persisted team configuration (enter once, reuse)

### Task 6: Prisma model + config store

**Files:**
- Modify: `prisma/schema.prisma` (add `app_opreview` schema + models)
- Create: `src/prisma/apps/opreview.ts` (per-app client helper, matching `src/prisma/apps/dora.ts`)
- Create: `apps/opreview/config-store.ts`
- Test: `apps/opreview/config-store.test.ts`

- [ ] **Step 1: Add the schema** — in `prisma/schema.prisma`, add `app_opreview` to the datasource `schemas = [...]` list and define:

```prisma
model OpreviewTeam {
  id            String   @id @default(cuid())
  name          String   @unique
  displayName   String
  spaceKey      String
  folderId      String
  pagerdutyTeamIds String[]
  jiraJql       String
  jiraBugsJql   String
  githubTopic   String
  infraRepos    String[] @default([])
  excludeMembers String[] @default([])
  updatedAt     DateTime @updatedAt
  @@map("teams")
  @@schema("app_opreview")
}

model OpreviewShared {
  id               Int    @id @default(1)
  jiraBaseUrl      String
  githubOrg        String
  rollbarAccountSlug String @default("")
  reportTimezone   String @default("")
  @@map("shared_config")
  @@schema("app_opreview")
}
```

- [ ] **Step 2: Create the per-app client helper** `src/prisma/apps/opreview.ts` — copy the shape of `src/prisma/apps/dora.ts` (export an `opreviewDb` scoped to this app's models).

- [ ] **Step 3: Create the migration**
Run: `npx prisma migrate dev --name opreview_config`
Expected: a new folder under `prisma/migrations/` touching only `app_opreview`.

- [ ] **Step 4: Write the failing test** `apps/opreview/config-store.test.ts` (uses the dev DB):

```ts
import { describe, it, expect } from 'vitest';
import { saveTeam, getTeam, listTeams } from './config-store.js';

describe('config store', () => {
  it('round-trips a team config', async () => {
    await saveTeam({ name: 'oranges', displayName: 'Oranges', spaceKey: 'RNG', folderId: '123', pagerdutyTeamIds: ['P1'], jiraJql: 'a', jiraBugsJql: 'b', githubTopic: 'oranges', infraRepos: [], excludeMembers: [] });
    const t = await getTeam('oranges');
    expect(t?.displayName).toBe('Oranges');
    expect((await listTeams()).map(x => x.name)).toContain('oranges');
  });
});
```

- [ ] **Step 5: Run it — expect FAIL.**

- [ ] **Step 6: Implement** `apps/opreview/config-store.ts`:

```ts
import { opreviewDb } from '../../src/prisma/apps/opreview';

export interface StoredTeam {
  name: string; displayName: string; spaceKey: string; folderId: string;
  pagerdutyTeamIds: string[]; jiraJql: string; jiraBugsJql: string;
  githubTopic: string; infraRepos: string[]; excludeMembers: string[];
}

export async function saveTeam(t: StoredTeam): Promise<void> {
  await opreviewDb.opreviewTeam.upsert({ where: { name: t.name }, update: t, create: t });
}
export async function getTeam(name: string): Promise<StoredTeam | null> {
  return opreviewDb.opreviewTeam.findUnique({ where: { name } });
}
export async function listTeams(): Promise<StoredTeam[]> {
  return opreviewDb.opreviewTeam.findMany({ orderBy: { displayName: 'asc' } });
}
```

- [ ] **Step 7: Run the test — expect PASS.**

- [ ] **Step 8: Commit** `git add prisma src/prisma/apps/opreview.ts apps/opreview/config-store.* && git commit -m "feat(opreview): persisted team config"`

### Task 7: Map stored config → core team shape; wire `/report` and `/publish` to the store

**Files:**
- Create: `apps/opreview/team-mapping.ts`
- Modify: `apps/opreview/routes.ts` (drop `TEMP_TEAMS`, read from store)
- Test: `apps/opreview/team-mapping.test.ts`

- [ ] **Step 1: Write the failing test** for the mapper:

```ts
import { describe, it, expect } from 'vitest';
import { toCoreTeam } from './team-mapping.js';

it('maps a stored team to the core team shape', () => {
  const core = toCoreTeam({ name: 'oranges', displayName: 'Oranges', spaceKey: 'RNG', folderId: '9', pagerdutyTeamIds: ['P1'], jiraJql: 'a', jiraBugsJql: 'b', githubTopic: 'oranges', infraRepos: [], excludeMembers: [] });
  expect(core.confluenceParent).toEqual({ spaceKey: 'RNG', folderId: '9' });
  expect(core.name).toBe('oranges');
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** `apps/opreview/team-mapping.ts`:

```ts
import type { StoredTeam } from './config-store.js';
import type { TeamConfig } from './report-service.js';

export function toCoreTeam(s: StoredTeam): TeamConfig {
  return {
    name: s.name, displayName: s.displayName,
    pagerdutyTeamIds: s.pagerdutyTeamIds, jiraJql: s.jiraJql, jiraBugsJql: s.jiraBugsJql,
    githubTopic: s.githubTopic, infraRepos: s.infraRepos, excludeMembers: s.excludeMembers,
    confluenceParent: { spaceKey: s.spaceKey, folderId: s.folderId },
  };
}
```

- [ ] **Step 4: Update `/report` and `/publish`** in `routes.ts`: remove `TEMP_TEAMS`; resolve the team via `getTeam(team)` then `toCoreTeam(...)`. Also apply shared config (jiraBaseUrl/githubOrg/rollbarAccountSlug/reportTimezone) to `process.env` before generating — add a `loadShared()` to `config-store.ts` that sets `JIRA_BASE_URL`, `GITHUB_ORG`, `ROLLBAR_ACCOUNT_SLUG`, `REPORT_TIMEZONE`.

- [ ] **Step 5: Update the two route tests** to mock `getTeam`/`loadShared` instead of `TEMP_TEAMS`; run — expect PASS.

- [ ] **Step 6: Commit** `git add apps/opreview && git commit -m "feat(opreview): routes read persisted config"`

### Task 8: Config UI + landing

**Files:**
- Modify: `apps/opreview/routes.ts` (`GET /`, `GET /config`, `POST /config`)
- Create: `apps/opreview/views/landing.handlebars`, `apps/opreview/views/config.handlebars`
- Test: `apps/opreview/routes.config.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const store: any = { teams: [] as any[] };
vi.mock('./config-store.js', () => ({
  listTeams: async () => store.teams,
  getTeam: async (n: string) => store.teams.find((t: any) => t.name === n) ?? null,
  saveTeam: async (t: any) => { store.teams.push(t); },
  loadShared: async () => {},
}));
import router from './routes.js';
const app = express().use(express.urlencoded({ extended: true })).use('/opreview', router);

describe('config UI', () => {
  it('landing offers setup when no teams', async () => {
    const res = await request(app).get('/opreview/');
    expect(res.text.toLowerCase()).toContain('config');
  });
  it('POST /config saves and redirects', async () => {
    const res = await request(app).post('/opreview/config').type('form').send({
      name: 'oranges', displayName: 'Oranges', spaceKey: 'RNG', folderId: '1',
      pagerdutyTeamIds: 'P1,P2', jiraJql: 'a', jiraBugsJql: 'b', githubTopic: 'oranges',
      infraRepos: '', excludeMembers: '',
    });
    expect(res.status).toBe(302);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** the handlers in `routes.ts`:

```ts
import { listTeams, getTeam, saveTeam, loadShared } from './config-store.js';

const csv = (v: unknown) => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);

router.get('/', async (_req, res) => {
  const teams = await listTeams();
  const month = defaultMonth(); // last full month, YYYY-MM
  res.render('landing', { teams, month, hasTeams: teams.length > 0 });
});

router.get('/config', async (req, res) => {
  const editing = req.query.team ? await getTeam(String(req.query.team)) : null;
  res.render('config', { team: editing });
});

router.post('/config', async (req, res) => {
  const b = req.body;
  await saveTeam({
    name: b.name, displayName: b.displayName, spaceKey: b.spaceKey, folderId: b.folderId,
    pagerdutyTeamIds: csv(b.pagerdutyTeamIds), jiraJql: b.jiraJql, jiraBugsJql: b.jiraBugsJql,
    githubTopic: b.githubTopic, infraRepos: csv(b.infraRepos), excludeMembers: csv(b.excludeMembers),
  });
  res.redirect('/opreview/');
});
```

Add `defaultMonth()` (last full month) near the top of `routes.ts`:

```ts
function defaultMonth(): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Add views.** `landing.handlebars` — if `hasTeams`, a form `GET /opreview/report` with a team `<select>` (options from `teams`) and a `month` `<input type="month" value="{{month}}">` plus a "Configure a team" link; else prompt to `GET /opreview/config`. `config.handlebars` — a `POST /opreview/config` form with one field per selector (text inputs; comma-separated for the array fields), pre-filled from `team` when editing. Include a note that secrets live in `TOOLS_CREDENTIALS` (per the deferred decision).

- [ ] **Step 5: Run the test — expect PASS.**

- [ ] **Step 6: Manual check** — `npm run dev`: configure a team, return to `/opreview/`, pick a month, view the report, click Publish.

- [ ] **Step 7: Commit** `git add apps/opreview && git commit -m "feat(opreview): config + landing UI"`

---

## Phase 3 — Charts for Confluence (resolve the `sharp` question)

### Task 9: PNG rasterization for publish

**Files:**
- Modify: `package.json` (add `sharp`) OR `apps/opreview/core/output/charts.js` (swap rasterizer)
- Test: `apps/opreview/charts.png.test.ts`

The vendored `charts.js` uses `sharp` for `svgToPng`. The web UI uses inline SVG and needs no PNG; only `POST /publish` needs PNGs.

- [ ] **Step 1: Check whether `sharp` builds** in the tools.babbel Docker image. Run `npm i sharp` locally, `npm run build`, and a container build. If clean, prefer this (least change).

- [ ] **Step 2a (sharp works): Write a test** that `svgToPng('<svg .../>')` returns a non-empty PNG Buffer (magic bytes `89 50 4E 47`). Run — expect PASS. Done.

- [ ] **Step 2b (sharp painful): Swap rasterizer** to a pure-JS path (e.g. `@resvg/resvg-js`) behind the same `svgToPng` signature in `core/output/charts.js`; note the deviation in `VENDORED.md`. Write the same magic-bytes test; run — expect PASS.

- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(opreview): chart PNG rasterization for Confluence"`

---

## Self-review notes (gaps to watch during execution)

- **Vendored signatures:** Tasks 3/5 assume `renderHtml(range,data,team)`, `renderStorage(range,data,team,{chartFilenames,ownerAccountId})`, `renderTrendCharts({pd,rollbar,jira,github},team)`, `svgToPng(svg)`, `publishPage(team,title,storage)`, `uploadAttachment(pageId,filename,buf,mime)`, `pageWebUrl(page)`. Verify against the actually-copied files; adjust calls if opreview has drifted.
- **tsx ESM bridge:** `.ts` importing vendored `.js` ESM works at runtime via the bridge in `src/app.ts`; under vitest it's native ESM. If a vendored module uses `import 'dotenv/config'` (e.g. none of the `output/*` do, but `index.js` does — and we are NOT vendoring `index.js`), strip such side-effect imports from anything vendored.
- **Okta/auth:** provided by the platform around the mounted app; no auth code here. Confirm `/opreview/*` is behind it.
- **Secrets location:** Task 2 reads `TOOLS_CREDENTIALS`. If the deferred decision lands on UI-entered secrets, only `credentials.ts` (+ a Prisma secret model) changes; routes/report-service are unaffected.
- **Rollbar token wiring:** `report-service` injects `rollbarReadTokens` into the team object the core's `fetchRollbar` reads — confirm that's the property name the vendored `rollbar.js` expects.

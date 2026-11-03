# OpenSpecSight Core (Phases 0–4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bootable, self-hosted Nuxt 4 app where an operator connects a GitHub repo, an LLM analysis generates the living spec (features + scenarios), manual syncs record changes per release, and both are browsable in the UI.

**Architecture:** Nuxt 4 monolith with strict layers: `app/` (UI, auto-imports) → `server/api` (thin, zod-validated) → `server/services` (all business logic) → `server/db` (Drizzle over better-sqlite3). Background work runs through a jobs table processed by a Nitro task. LLM and GitHub are both behind injectable service interfaces so everything is testable with `LLM_MOCK=true` and a stubbed GitHub API.

**Tech Stack:** Nuxt `^4.6.4`, `@nuxt/ui` `^4.12`, `better-sqlite3` `^13`, `drizzle-orm` `^0.45` + `drizzle-kit`, Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible`), `octokit`, `zod` `^4`, pnpm, Node 24, TypeScript strict, vitest + @playwright/test.

**Spec:** `docs/superpowers/specs/2026-11-03-openspecsight-design.md` — read it first; this plan argues from it. Plans 2 (map/flows/Ask) and 3 (digests/release notes/MCP) follow separately.

## Global Constraints

- Node `>=24` (`engines` in package.json); pnpm; TypeScript `strict: true`.
- All UI text, generated content, comments, commit messages, README: **English**. Chat with the owner stays in Spanish.
- Config **only** via env; commit `.env.example`, gitignore `.env` and `data/`. Keys (GitHub PAT, LLM key) never in code, logs, or API responses.
- Defaults from spec: `DATABASE_PATH=./data/app.db`, `GITHUB_MAX_FILES=10000`, `GITHUB_MAX_TOTAL_BYTES=157286400`, `LLM_API_STYLE=anthropic`, `LLM_BASE_URL=https://api.minimax.io/anthropic`, `LLM_MOCK=false`, `PUBLIC_APP_URL=http://localhost:3000`.
- Layering rule: pages → composables → `server/api` → `server/services` → `server/db`. UI never imports DB, octokit, or AI SDK. Auto-imports for anything under `app/composables`, `app/utils`, `app/components`, `server/utils`.
- Domain types live only in `shared/` (single source of truth for client and server).
- Syncs never modify `source=manual` scenarios; changes to them are stored as `proposed` revisions only (spec §6.3).
- Everything testable without network: `LLM_MOCK=true` returns fixture structured outputs; GitHub goes through `GITHUB_API_BASE` (default `https://api.github.com`) so tests can point octokit at a local stub.
- License: MIT. README in English with quickstart.
- Before scaffolding or adding any Nuxt/Nuxt UI integration, consult the official `nuxt` and `nuxt-ui` MCPs for the current install/setup commands — do not rely on memory.
- Conventional commits (`feat:`, `test:`, `chore:`, `fix:`). Run `pnpm lint` + `pnpm test:unit` green before every commit step.

## Review Focus

1. **A sync must never modify a `source=manual` scenario** — a user edit surviving syncs is an anti-goal (spec §4). Test pinned in Task 10.
2. **No API key → app still fully works in dev/e2e** (`LLM_MOCK=true`); a fresh clone with empty `.env` keys must boot and run the whole flow. Test pinned in Task 12.
3. **Secrets leakage** — GitHub PATs and LLM keys must never appear in any API response, serialized project JSON, or client bundle. PAT stored AES-256-GCM encrypted. Tests pinned in Tasks 6 and 12.
4. **Oversized repos** — analysis enforces `GITHUB_MAX_FILES` / `GITHUB_MAX_TOTAL_BYTES` before calling the LLM and records the limit hit in the analysis row instead of crashing. Test pinned in Task 8.
5. **Duplicate/concurrent syncs** — starting a sync while one is running must be rejected with a clear error, not double-run. Test pinned in Task 7.

---

### Task 1: Repo scaffold + Nuxt 4 app with test harness

**Files:**
- Create: repo root (`.gitignore`, `LICENSE`, `README.md`, `.env.example`, `package.json`, `nuxt.config.ts`, `tsconfig.json`)
- Create: `app/app.vue`, `app/layouts/default.vue`, `app/pages/index.vue`, `app/assets/css/main.css`
- Create: `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`
- Test: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Produces: a running Nuxt app with `@nuxt/ui` module registered, color-mode toggle in `layouts/default.vue`, home page rendering "OpenSpecSight"; scripts `dev`, `build`, `test:unit` (vitest), `test:e2e` (playwright), `lint`; CI running both suites.

- [ ] **Step 1: Init repo and app.** `git init`; scaffold Nuxt 4 app with pnpm (consult the `nuxt` MCP for the current `pnpm create nuxt` flow); add `@nuxt/ui` following the `nuxt-ui` MCP instructions (module + `main.css` with `@import "tailwindcss"; @import "@nuxt/ui";`). Write `.gitignore` (node_modules, .nuxt, .output, data/, .env, .playwright-mcp, test-results), MIT `LICENSE`, `.env.example` with every key from Global Constraints, `README.md` quickstart (English).
- [ ] **Step 2: Wire test tooling.** Install `vitest` + `@playwright/test` (+ `@nuxt/test-utils` if the MCP recommends it); `vitest.config.ts` covering `tests/unit/**/*.spec.ts` and `shared/**`; `playwright.config.ts` with `webServer: { command: 'pnpm dev', env: { LLM_MOCK: 'true', AUTH_PASSWORD: 'test-pass', SESSION_SECRET: 'test-secret', DATABASE_PATH: './data/test-e2e.db' } }`; CI workflow installs pnpm, runs lint + unit + e2e on Node 24.
- [ ] **Step 3: Failing smoke e2e.** `tests/e2e/smoke.spec.ts`: expect `page.goto('/')` → title contains "OpenSpecSight" and `h1` says "OpenSpecSight" (home page is a projects placeholder for now). Run `pnpm playwright test smoke` → FAIL (no content).
- [ ] **Step 4: Minimal UI to pass.** `app/app.vue` with `<NuxtLayout><NuxtPage/></NuxtLayout>`; `layouts/default.vue` with `UApp` wrapper + header (logo, color-mode toggle) + sidebar placeholder; `pages/index.vue` renders `<h1>OpenSpecSight</h1>`. Run `pnpm playwright test smoke` → PASS. Run `pnpm dev` once, load `/` manually to confirm no console errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "chore: scaffold Nuxt 4 app with Nuxt UI, vitest and Playwright"`

### Task 2: Drizzle schema, client, migrations, FTS5

**Files:**
- Create: `drizzle.config.ts`, `server/db/schema.ts`, `server/db/client.ts`, `server/db/migrations/` (generated)
- Test: `tests/unit/db.spec.ts`

**Interfaces:**
- Produces:
  - `getDB(): Database` (better-sqlite3 singleton at `DATABASE_PATH`, applies migrations + creates FTS on first call) — exported from `server/db/client.ts`.
  - Tables (camelCase columns): `projects (id integer pk, name text, description text, createdAt text)`, `repositories (id, projectId →projects, owner text, repo text, branch text, patEncrypted text nullable, lastSyncedSha text nullable)`, `features (id, projectId, parentId nullable →features, name text, description text, sortOrder integer, source text 'ai'|'manual')`, `scenarios (id, featureId →features, context text, action text, outcome text, category text 'happy'|'edge'|'error', code text, sortOrder integer, source text)`, `featureFiles (id, featureId →features, path text)`, `analyses (id, projectId, type text 'initial'|'sync', status text 'queued'|'running'|'done'|'error', progress integer 0-100, step text, statsJson text, error text, createdAt, finishedAt)`, `releases (id, projectId, repositoryId →repositories, sha text, title text, category text, highlight integer 0|1, summary text, authorsJson text, message text, committedAt text)`, `scenarioRevisions (id, releaseId →releases, scenarioId nullable →scenarios, featureId →features, kind text 'new'|'changed'|'gone'|'fixed', state text 'applied'|'proposed', beforeJson text, afterJson text)`, `annotations (id, scenarioId →scenarios, body text, author text, createdAt text)`, `jobs (id, type text, payloadJson text, status text 'queued'|'running'|'done'|'error', attempts integer, error text, createdAt, finishedAt)`.
  - FTS5 virtual table `scenarios_fts (context, action, outcome, feature_name)` kept in sync by AFTER INSERT/UPDATE/DELETE triggers on `scenarios`.

- [ ] **Step 1: Failing tests.** `tests/unit/db.spec.ts` (uses `DATABASE_PATH=:memory:`): (a) `getDB()` returns same instance twice; (b) insert project → repository → feature → scenario roundtrip returns row with all fields; (c) after inserting a scenario, `SELECT * FROM scenarios_fts WHERE scenarios_fts MATCH 'login'` finds it; after updating the scenario's action, FTS reflects the new text; after delete, FTS row gone. Run `pnpm vitest run tests/unit/db.spec.ts` → FAIL (module missing).
- [ ] **Step 2: Implement schema + client.** `schema.ts` with drizzle sqlite-core definitions above; `drizzle.config.ts` pointing at `server/db/schema.ts` with migrations dir `server/db/migrations`; `client.ts`: open better-sqlite3 at env `DATABASE_PATH` (mkdir parent), `drizzle()` wrapper, run migrations, `exec` the FTS5 DDL + triggers (write triggers by hand — drizzle-kit does not generate virtual tables). Run the unit tests → PASS.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "feat: drizzle schema, sqlite client with FTS5 sync triggers"`

### Task 3: Single-user auth

**Files:**
- Create: `server/utils/session.ts` (HMAC-signed token `{u, exp}`, cookie `os_session`, 7-day TTL), `server/api/auth/login.post.ts`, `server/middleware/01.auth.ts`, `app/pages/login.vue`, `app/middleware/auth.global.ts`
- Test: `tests/unit/session.spec.ts`, `tests/e2e/auth.spec.ts`

**Interfaces:**
- Produces: `createSessionToken(): string` / `verifySessionToken(token?: string): boolean` (auto-imported in server code); POST `/api/auth/login` `{ password }` → sets cookie; all other `/api/**` return 401 without valid cookie; pages redirect to `/login` unless authed (`useAuthed()` composable).

- [ ] **Step 1: Failing unit test.** `session.spec.ts`: token verifies; tampered token fails; expired token fails. Run → FAIL.
- [ ] **Step 2: Implement `session.ts`** (HMAC-SHA256 over JSON payload using `SESSION_SECRET`; timing-safe compare). Unit tests → PASS.
- [ ] **Step 3: Failing e2e.** `auth.spec.ts`: `/` redirects to `/login`; wrong password shows error and stays; correct password (`AUTH_PASSWORD` from webServer env) lands on `/`; `/api/projects` without cookie → 401. Run → FAIL.
- [ ] **Step 4: Implement login page (UForm + UInput password + UButton), server middleware** (skip `/api/auth/login`), **global page middleware** (skip `/login`) **+ `useAuthed()` composable** (calls `/api/auth/me`). E2E → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: single-operator auth with signed session cookie"`

### Task 4: LLM service with mock mode + shared zod schemas

**Files:**
- Create: `shared/types.ts` (domain types: `ProjectSummary`, `FeatureNode`, `ScenarioDTO`, `ReleaseDTO`, `AnalysisStatus`…), `shared/schemas.ts`, `server/services/llm.service.ts`, `fixtures/llm/*.json`
- Test: `tests/unit/llm.service.spec.ts`

**Interfaces:**
- Produces:
  - `createLlmClient(): LlmClient` where `LlmClient = { generate<T>(name: string, schema: ZodType<T>, prompt: string): Promise<T> }` — resolves provider from env (`LLM_API_STYLE`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MOCK`); mock mode returns fixture JSON chosen by `name` validated against `schema`; real mode uses AI SDK `generateObject` with the matching provider.
  - Zod schemas in `shared/schemas.ts` (also fixture shapes): `FeatureInventorySchema = { features: Array<{ name, description, files: string[], children?: Array<{ name, description, files: string[] }> }> }`; `FeatureScenariosSchema = { featureName, groups: Array<{ context: string, scenarios: Array<{ action, outcome, category: 'happy'|'edge'|'error' }> }> }`; `SyncUpdateSchema = { title, category, highlight: boolean, summary, featureUpdates: Array<{ featureName, changedFiles: string[], scenarios: Array<{ kind: 'new'|'changed'|'gone'|'fixed', matchCode?: string, context, action, outcome, category }> }> }`.
  - Mock fixture resolution: `name` maps to `fixtures/llm/<name with ':' → '.'>.json`; a discriminator suffix selects variants, e.g. `'feature-scenarios:authentication'` → `feature-scenarios.authentication.json`, `'sync-update:authentication'` → `sync-update.authentication.json`. Base fixtures this plan needs: `feature-inventory`, `feature-scenarios.authentication`, `feature-scenarios.tasks`, `sync-update.authentication`.
- Consumes: Task 2 types conventions.

- [ ] **Step 1: Failing tests.** `llm.service.spec.ts` (env `LLM_MOCK=true`): `generate('feature-inventory', FeatureInventorySchema, 'ignored')` deep-equals fixture JSON; unknown name rejects; a fixture violating its schema rejects. Real-mode branch test: with `LLM_MOCK=false` + fake style, `createLlmClient()` builds without network and `generate` is not called (assert provider factory got env values — dependency-inject the AI SDK module or its factory for the test). Run → FAIL.
- [ ] **Step 2: Write fixtures + schemas + service.** Two small believable fixtures (a mini "task manager" app: `Authentication`, `Tasks` features, login/token scenarios). Mock reads fixture by name from `fixtures/llm/`; real mode instantiates `@ai-sdk/anthropic` (or `@ai-sdk/openai-compatible` when `LLM_API_STYLE=openai`) with `baseURL`/`apiKey` and calls `generateObject`. Tests → PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat: llm service with env-configurable provider and mock mode"`

### Task 5: GitHub service (octokit behind an interface)

**Files:**
- Create: `server/services/github.service.ts`, `fixtures/github/*.json`
- Test: `tests/unit/github.service.spec.ts`

**Interfaces:**
- Produces: `createGithubService(opts?: { token?: string; baseUrl?: string }): GithubService` with `getRepo(owner, repo): Promise<{ defaultBranch: string }>`; `getTree(owner, repo, ref): Promise<Array<{ path: string; type: 'blob'|'tree'; sha: string; size: number }>>` (recursive, `truncated` flag handled by erroring); `getBlob(owner, repo, sha): Promise<string>` (utf-8 decoded); `compareCommits(owner, repo, base, head): Promise<{ commits: Array<{ sha, message, authorName, committedAt }>, files: Array<{ filename, patch? }> }>`; `listCommits(owner, repo, ref, perPage?): Promise<Array<{ sha, message, authorName, committedAt }>>`. `baseUrl` defaults to env `GITHUB_API_BASE` else `https://api.github.com`.
- Test strategy: unit tests inject `baseUrl` pointing at a local stub server (`tests/unit/helpers/stub-server.ts`, plain `node:http` serving `fixtures/github/*.json`).

- [ ] **Step 1: Failing tests.** With stub server: `getTree` maps entries and rejects when `truncated: true`; `compareCommits` maps commits+files including `patch`; missing token + private-repo 404 surfaces a typed `GithubError` with owner/repo in the message. Run → FAIL.
- [ ] **Step 2: Implement service.** Thin octokit wrappers; one `Octokit` instance per service; no caching. Tests → PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat: github service over octokit with injectable base url"`

### Task 6: Projects & repositories — API, PAT encryption, UI

**Files:**
- Create: `server/utils/crypto.ts`, `server/api/projects/index.get.ts`, `server/api/projects/index.post.ts`, `server/api/projects/[id]/index.get.ts`, `server/api/projects/[id]/index.delete.ts`, `server/api/projects/[id]/repositories/index.post.ts`
- Create: `app/composables/useProjects.ts`, `app/components/project/CreateProjectModal.vue`, `app/components/project/ProjectCard.vue`
- Modify: `app/pages/index.vue` (list + create), `app/pages/projects/[id].vue` (overview placeholder showing repo info)
- Test: `tests/unit/crypto.spec.ts`, `tests/e2e/projects.spec.ts`

**Interfaces:**
- Produces:
  - `encryptSecret(plain: string): string` / `decryptSecret(cipher: string): string` — AES-256-GCM, key = scrypt(`SESSION_SECRET`, static salt); format `v1:iv:tag:cipher` base64.
  - API: `GET /api/projects` → `ProjectSummary[]` (id, name, description, repositories: `{owner, repo, branch}[]` — **never** `patEncrypted`); `POST /api/projects` `{ name, description, owner, repo, branch?, pat? }` (zod; validates repo via Task 5 `getRepo`, defaults branch to default branch; stores PAT encrypted); `GET /api/projects/:id` → project + repositories + last analysis status; `DELETE /api/projects/:id` cascades.
  - `useProjects()` composable (list/create/remove; typed from `shared/types.ts`).
- Consumes: `createGithubService` (Task 5), `getDB` (Task 2), auth (Task 3).

- [ ] **Step 1: Failing unit test.** `crypto.spec.ts`: encrypt→decrypt roundtrip; different plaintexts → different ciphertexts; tampered cipher throws. Run → FAIL.
- [ ] **Step 2: Implement `crypto.ts`.** Tests → PASS.
- [ ] **Step 3: Failing e2e.** `projects.spec.ts`: login; create project "Task Manager" owner `acme` repo `tasks` (stub server from Task 5 wired via `GITHUB_API_BASE` in webServer env); project card appears with `acme/tasks`; `GET /api/projects` response body does not contain `pat` anywhere (assert as string match). Run → FAIL.
- [ ] **Step 4: Implement API + UI.** UModal with UForm (name, description, owner/repo/branch, PAT optional UInput type=password); UCard grid on `/`; project page with UPageHeader. E2E → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: projects and repositories with encrypted PATs"`

### Task 7: Jobs queue on Nitro tasks

**Files:**
- Create: `server/services/jobs.service.ts`, `server/tasks/run-jobs.task.ts`, `server/api/projects/[id]/analyses/index.post.ts`, `server/api/projects/[id]/analyses/index.get.ts`
- Test: `tests/unit/jobs.spec.ts`, `tests/e2e/jobs.spec.ts`

**Interfaces:**
- Produces:
  - `enqueueJob(type: string, payload: Record<string, unknown>): number`; `processNextJobs(limit = 5): Promise<number>` — claims rows `WHERE status='queued'` with `UPDATE ... RETURNING` guard against double-claim; handler registry `registerJobHandler(type, fn)` where `fn(payload): Promise<void>`; failed job → `attempts+1`, error stored, status back to `queued` while `attempts < 3` else `error`.
  - Nitro task `jobs:run` calling `processNextJobs()`; registered in `nuxt.config.ts` (`nitro.tasks`) with `schedule` not enabled (called from API for now).
  - API: `POST /api/projects/:id/analyses` → creates `analyses` row (`type:'initial'`, `status:'queued'`) + enqueues `initial-analysis` job → returns 202 `{ analysisId }`; rejects 409 if the project already has a `queued|running` analysis. `GET /api/projects/:id/analyses` → latest analysis `{ status, progress, step, error }`.
  - Job handlers registered in `server/plugins/jobs.ts` (plugin registers `initial-analysis` → `runInitialAnalysis`, `sync` → `runSync` — both imported from Tasks 8/10; this task registers a `noop` test handler).
- Consumes: `getDB`.

- [ ] **Step 1: Failing unit tests.** `jobs.spec.ts` (memory DB): enqueue → process runs handler once; throwing handler retries up to 3 then parks as `error` with message; double-claim guard: two concurrent `processNextJobs` never run the same row (simulate by calling claim twice inside one handler). Run → FAIL.
- [ ] **Step 2: Implement jobs service + task + APIs.** Tests → PASS.
- [ ] **Step 3: Failing e2e.** `jobs.spec.ts`: POST analyses → 202; GET analyses shows `done` after polling (noop handler marks the analysis row `done` via callback — for this task the handler only updates `analyses.status`). Run → FAIL then implement plugin with noop handler → PASS.
- [ ] **Step 4: Commit.** `git commit -am "feat: durable jobs queue processed by nitro task"`

### Task 8: Initial analysis pipeline (LLM_MOCK) with progress

**Files:**
- Create: `server/services/analysis.service.ts`, `fixtures/github/tasks-tree.json` (already exists from Task 5 — extend if needed), `fixtures/llm/feature-inventory.json`, `fixtures/llm/feature-scenarios.json`
- Modify: `server/plugins/jobs.ts` (real `initial-analysis` handler), `app/pages/projects/[id].vue` (analysis progress UI)
- Test: `tests/unit/analysis.spec.ts`, `tests/e2e/analysis.spec.ts`

**Interfaces:**
- Produces: `runInitialAnalysis(payload: { analysisId: number, projectId: number }, deps?: { github?: GithubService, llm?: LlmClient }): Promise<void>`:
  1. load project + first repository → `getTree` → filter to code files (extension allowlist: ts, js, mjs, vue, json, md, css, py, go, rs, rb, java, php; skip lockfiles, `dist/`, `node_modules/`, binaries) → enforce `GITHUB_MAX_FILES` / `GITHUB_MAX_TOTAL_BYTES` (exceeding → analysis `error` with clear message, no LLM call);
  2. read blobs for the filtered tree (batched, size-capped) → compact source digest;
  3. `generate('feature-inventory', FeatureInventorySchema, digest)` → insert features (max depth 2) + `featureFiles` rows, `source='ai'`, `code` not yet assigned;
  4. per feature: `generate('feature-scenarios:' + featureSlug, FeatureScenariosSchema, feature + its files' digest)` → insert scenarios with stable `code` (`HP-1`, `ED-1`, `ER-1` counters per feature), grouped `context`;
  5. update `analyses` row: `status='running'`, `progress` 10→90 with `step` labels (`tree`, `inventory`, `scenarios (3/7)`…), final `done` with `statsJson` (`{features, scenarios, files}`), and set `repositories.lastSyncedSha` to branch head.
  Mock mode: steps 3–4 use the Task 4 fixtures (fixture inventory covers 2 features; `featureSlug` = lowercased kebab feature name, so `Authentication` → `feature-scenarios:authentication`).
- Consumes: `createGithubService` (Task 5), `createLlmClient` (Task 4), `enqueueJob`/analysis row (Task 7), `getDB` (Task 2).

- [ ] **Step 1: Failing unit tests.** `analysis.spec.ts` with `LLM_MOCK=true`, fake github service (inject fixture tree/blobs — make `runInitialAnalysis` accept `{ github?: GithubService, llm?: LlmClient }` deps for tests): asserts features + scenarios + featureFiles inserted with `source='ai'`; scenario codes sequential per category per feature; oversize tree (`GITHUB_MAX_FILES=3` env in test) → analysis row `error` mentioning the limit and zero LLM calls (mock `generate` spy not called); `lastSyncedSha` set. Run → FAIL.
- [ ] **Step 2: Implement pipeline.** Tests → PASS.
- [ ] **Step 3: Failing e2e.** `analysis.spec.ts`: with stub GitHub + `LLM_MOCK`, create project → POST analyses → UI progress appears and completes → analysis status `done`, stats visible. Run → FAIL.
- [ ] **Step 4: Progress UI on project page.** Poll `/api/projects/:id/analyses` every 2 s while `queued|running` (UProgress + step label). E2E → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: initial analysis pipeline building the spec from a repo"`

### Task 9: Spec UI — feature tree, scenarios, manual edits, annotations

**Files:**
- Create: `server/api/projects/[id]/features/index.get.ts`, `server/api/features/[featureId]/index.get.ts`, `server/api/features/[featureId]/scenarios/index.post.ts`, `server/api/scenarios/[id]/index.patch.ts`, `server/api/scenarios/[id]/index.delete.ts`, `server/api/scenarios/[id]/annotations/index.get.ts` + `index.post.ts`
- Create: `app/pages/projects/[id]/spec/index.vue`, `app/pages/projects/[id]/spec/[featureId].vue`, `app/components/spec/FeatureTree.vue`, `app/components/spec/ScenarioGroup.vue`, `app/components/spec/ScenarioForm.vue`, `app/components/spec/AnnotationList.vue`
- Modify: `app/layouts/default.vue` or project layout — project rail nav (Overview, Changes, Product spec — map/ask/digests placeholders "coming soon" linking nowhere yet)
- Test: `tests/e2e/spec.spec.ts`, `tests/unit/scenarios-api.spec.ts`

**Interfaces:**
- Produces:
  - `GET /api/projects/:id/features` → tree `FeatureNode[]` (`id, name, description, parentId, scenarioCount, children[]`).
  - `GET /api/features/:featureId` → `{ feature, groups: Array<{ context, scenarios: ScenarioDTO[] }> }` where `ScenarioDTO = { id, code, context, action, outcome, category, source }`.
  - `POST /api/features/:featureId/scenarios` `{ context, action, outcome, category }` → creates with `source='manual'`, next code in category (`HP-n+1`…).
  - `PATCH /api/scenarios/:id` (sets `source='manual'` on edit), `DELETE /api/scenarios/:id`.
  - Annotations: `GET`/`POST /api/scenarios/:id/annotations` `{ body }` (author = "operator").
- Consumes: analysis rows (Task 8).

- [ ] **Step 1: Failing unit test.** `scenarios-api.spec.ts` (memory DB, direct service-level or `@nuxt/test-utils` API tests): POST manual scenario gets `source='manual'` and correct next `HP` code; PATCH flips `source` to `manual`; DELETE removes (later sync must treat as manual territory — enforced in Task 10). Run → FAIL.
- [ ] **Step 2: Implement APIs.** Tests → PASS.
- [ ] **Step 3: Failing e2e.** `spec.spec.ts`: after Task 8 e2e state (project with analyzed spec), open Product spec → tree lists fixture features with counts; open `Authentication` → scenario groups visible ("user on the login page"); filter by category `Happy path` shows only HP rows; add a manual scenario via form → appears with a "manual" badge; add annotation → shows in list. Run → FAIL.
- [ ] **Step 4: Implement UI.** FeatureTree (recursive UNavigationMenu/UTree per `nuxt-ui` MCP guidance), ScenarioGroup (UAccordion; category chips colored: happy=green, edge=amber, error=red; AI/manual badge), ScenarioForm (UForm + UModal), AnnotationList (UChat? simple list + UInput). E2E → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: spec browsing with manual scenario editing and annotations"`

### Task 10: Sync pipeline — diff → revisions → release

**Files:**
- Create: `server/services/sync.service.ts`, `server/api/projects/[id]/sync/index.post.ts`, `fixtures/github/tasks-compare.json`, `fixtures/llm/sync-update.authentication.json`
- Modify: `server/plugins/jobs.ts` (`sync` handler), `fixtures/llm/feature-scenarios.authentication.json` untouched — sync fixtures are separate
- Test: `tests/unit/sync.spec.ts`

**Interfaces:**
- Produces:
  - `runSync(payload: { projectId: number }): Promise<{ releaseId: number | null }>`:
    1. repository → head sha via `listCommits(owner, repo, branch, 1)`; if head === `lastSyncedSha` → `{ releaseId: null }` (nothing new);
    2. `compareCommits(lastSyncedSha ?? first commit of range base, head)` → changed files with patches;
    3. affected features = features whose `featureFiles.path` intersects changed files (SQL join), plus a second pass where the LLM may name extra features from `changedFiles`;
    4. per affected feature: `generate('sync-update', SyncUpdateSchema, feature spec + its scenarios + matching patches)` → apply scenario updates: insert `new` (`source='ai'`, next code), apply `changed`/`fixed` on `source='ai'` rows only; **`source='manual'` matches → store `scenarioRevisions` with `state='proposed'` and do NOT touch the scenario**; `gone` → soft-remove (`source='ai'` rows deleted and revision `gone` recorded);
    5. one `releases` row per run: sha=head, LLM title/category/highlight/summary, `authorsJson` from compare commits, `committedAt`;
    6. set `lastSyncedSha` = head. Guard: caller (API) rejects with 409 when a `sync` job for the project is `queued|running` (Task 7 analyses table reused with `type:'sync'` or jobs-table check — use jobs table check).
  - API `POST /api/projects/:id/sync` → 202 `{ jobId }` | 409 `{ error: 'sync already in progress' }`.
- Consumes: github (5), llm (4), jobs (7), db (2).

- [ ] **Step 1: Failing unit tests.** `sync.spec.ts` (mock LLM + fake github, memory DB seeded with Task 8 result): (a) no new commits → `{releaseId: null}`, no LLM call; (b) new commits touching `src/auth/*` → only `Authentication` feature updated: revision rows `new/changed/fixed` applied, codes correct; (c) **manual scenario with matching code in LLM output → scenario row unchanged byte-for-byte, revision `state='proposed'` stored**; (d) `gone` scenario → row deleted + revision recorded; (e) release row created with title/authors/sha; (f) `lastSyncedSha` advanced; (g) second sync with same head → null release; (h) `POST /api/projects/:id/sync` while a sync job is `queued|running` → 409 (API-level test). Run → FAIL.
- [ ] **Step 2: Implement `sync.service.ts` + API.** Tests → PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat: sync pipeline with manual-edit protection and release recording"`

### Task 11: Changes + Overview UI

**Files:**
- Create: `server/api/projects/[id]/releases/index.get.ts` (grouped by day, filters: source `all|manual|ai`, feature, search q), `server/api/releases/[id]/index.get.ts` (release + revisions joined with scenario snapshots)
- Create: `app/pages/projects/[id]/changes/index.vue`, `app/pages/projects/[id]/changes/[id].vue`, `app/components/changes/ReleaseCard.vue`, `app/components/changes/RevisionSection.vue`
- Modify: `app/pages/projects/[id].vue` (overview: releases timeline newest first + highlight chips + Ask bar stub UInput disabled with tooltip "Coming in the next milestone"), `app/components/` project rail (enable Changes)
- Test: `tests/e2e/changes.spec.ts`

**Interfaces:**
- Produces: `GET /api/projects/:id/releases` → `Array<{ date, releases: ReleaseDTO[] }>`; `GET /api/releases/:id` → `ReleaseDTO` + `{ sections: { new, changed, gone, fixed: RevisionDTO[] } }` where `RevisionDTO = { kind, state, code, featureName, featureId, action, outcome, before?: {action, outcome} }`.
- Consumes: releases + revisions (Task 10).

- [ ] **Step 1: Failing e2e.** `changes.spec.ts`: continuing from Task 10 state (run a sync e2e first inside the test: create → analyze → stub returns extra commits → sync): Overview shows release card under its day heading with title + authors + "2 new · 1 changed"; Changes page filters by feature `Authentication`; release detail shows sections New/Changed/Gone/Fixed with links "View in spec" → lands on `/spec/[featureId]#scenario-[id]`. Run → FAIL.
- [ ] **Step 2: Implement APIs + UI.** ReleaseCard (UCard: title, category UBadge, avatars (UAvatar initials), counts, highlight star), RevisionSection (grouped UAccordion, each row links to spec anchor). E2E → PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat: changes timeline and release detail views"`

### Task 12: Hermetic full-flow e2e + docs hardening

**Files:**
- Create: `tests/e2e/full-flow.spec.ts`, `tests/helpers/github-stub.ts` (playwright-side stub server with mutable state: tree, commits, compare — lets a test "push" new commits between steps)
- Modify: `README.md` (quickstart without any API keys: `LLM_MOCK=true` demo flow; troubleshooting), `.github/workflows/ci.yml` (ensure e2e uses stub)
- Test: the task's deliverable is the test suite itself.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Failing test.** `full-flow.spec.ts` — one test, no keys beyond webServer env (`LLM_MOCK=true`, `GITHUB_API_BASE` → stub): login → create project → run analysis (progress → done) → browse spec → manual edit a scenario → stub "pushes" commits → Sync now → changes visible → release detail → **manual edit still intact** (assert exact text) with a "suggested change" badge on it → PAT/LLM key string absent from every network response captured (`page.on('response')` body scan for `sk-`, `ghp_`, `test-secret`). Run → FAIL (stub helper missing).
- [ ] **Step 2: Implement stub helper + fix what the test finds.** Iterate until PASS; fix product bugs the test exposes (that is the point of this task).
- [ ] **Step 3: Verify everything green.** `pnpm lint && pnpm test:unit && pnpm test:e2e` — all pass locally; CI green.
- [ ] **Step 4: Commit.** `git commit -am "test: hermetic full-flow e2e covering manual-edit protection and secret hygiene"`

---

## Post-plan (not in this plan)
- Plan 2: product map + flow diagrams (Vue Flow) + Ask (FTS5 + citations) — connections/flows columns already reserved in the schema via `flows`/`connections` tables added in Plan 2 migration.
- Plan 3: digests + SMTP, release notes editor + public page, export MD, GitHub webhook, MCP server + API keys.
- Real-LLM smoke run once the owner provides the MiniMax coding plan token (Task 4 real mode already wires it).

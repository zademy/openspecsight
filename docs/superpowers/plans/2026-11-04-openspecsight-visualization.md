# OpenSpecSight Visualization & AI (Phases 5–6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** The spec becomes visual and answerable: an interactive product map (feature graph with typed connections), per-feature flow diagrams, and Ask — natural-language questions answered strictly from the spec with numbered citations.

**Architecture:** Extends the Plan-1 core (see `docs/superpowers/plans/2026-11-03-openspecsight-core.md`, COMPLETED — its Global Constraints carry over verbatim). New tables via Drizzle migration: `connections`, `flows`, `conversations`, `messages`. Analysis pipeline gains two generation steps (connections, per-feature flows); sync refreshes them only for affected features. Ask = FTS5 retrieval (already maintained by triggers) → LLM answer with citations. UI uses Vue Flow (`@vue-flow/core`), client-only rendered.

**Tech Stack:** Plan-1 stack + `@vue-flow/core` (current version at install; read its README/types from node_modules — MCP doc servers are NOT available this session).

**Spec:** `docs/superpowers/specs/2026-11-03-openspecsight-design.md` §2 (map, flows, Ask), §6 (RAG decision), §7.4 pipeline steps 3–4, §7.5 screens.

## Global Constraints (Plan-1 constraints carry over; highlights)

- All Plan-1 conventions: layering (pages→composables→api→services→db), typed-$fetch with explicit response types, English everywhere, TS strict, conventional commits, status-code test assertions, secrets only in env, `LLM_MOCK` mode for everything testable, GitHub stub on 127.0.0.1:9876 with `POST /_admin/state` state switching + `fixtureAlias` repos.
- UI work reads `DESIGN.md` + antislop skills at `.opencode/skills/antislop-ui/SKILL.md` and `antislop-copywriting` (absolute path from repo root: `/Volumes/HIKSEMI/GitHub/openspecsight/.opencode/skills/...`) — binding. ENERGY 1; the map/flow canvas is a WORKING canvas (pan/zoom are functional), not decoration.
- Vue Flow renders client-side only (`<ClientOnly>` or `.client.vue` components) — SSR must not break.
- Ask must NEVER answer without spec citations; no-coverage → honest refusal (design anti-goal).
- Skills to load in dispatches: `nuxt`, `nuxt-ui`, `vue-best-practices`, `typescript-best-practices` (skill tool). MCP servers (nuxt, nuxt-ui, context7, codegraph) are unavailable — do not call them; read node_modules/docs instead.

## Review Focus

1. **Ask without coverage must refuse** (anti-goal in design §4) — FTS zero-results path never calls the LLM; LLM refusal surfaces honestly. Test pinned in Task 7.
2. **Map/flows are data-driven from the DB** — nothing hardcoded per-feature in UI; empty state when no connections yet (project analyzed before Plan 2) must not crash. Test pinned in Tasks 3/4.
3. **Sync refreshes flows/connections only for affected features** (design §6.5) — unaffected features' graphs unchanged after sync. Test pinned in Task 6.
4. **SSR safety** — map + flow + ask pages render server-side without Vue Flow touching document (no hydration errors). Test pinned in Task 4 (e2e covers page loads).
5. **Citations link to real anchors** — every `[n]` in an answer maps to an existing scenario; clicking lands on the expanded row (Plan-1 anchor convention). Test pinned in Task 8.

---

### Task 1: Schema migration + FTS search helper

**Files:** `server/db/schema.ts` (add tables), `server/db/migrations/` (generated), `server/db/search.ts` (new), tests `tests/unit/db-search.spec.ts`.

**Interfaces:**
- `connections (id, projectId, fromFeatureId →features, toFeatureId →features, type text)`, type ∈ {leads_to, triggers, depends_on, shares_data, authenticates, notifies, configures, embeds_in, competes_with} (TS-level union).
- `flows (id, featureId →features UNIQUE, graphJson text)` where graph = `{ nodes: Array<{ id, kind: 'start'|'step'|'decision'|'error'|'end', label, scenarioCode? }>, edges: Array<{ from, to, label? }> }` (zod schema `FlowGraphSchema` in `shared/schemas.ts`).
- `conversations (id, projectId, title text, pinned integer 0|1, createdAt text)`, `messages (id, conversationId →conversations, role 'user'|'assistant', content text, citationsJson text nullable, createdAt text)`.
- `searchScenarios(db, projectId, query, limit=8): Promise<Array<{ scenarioId, featureId, code, context, action, outcome, featureName }>>` — FTS5 MATCH over `scenarios_fts` (context/action/outcome/feature_name), sanitized query (strip FTS operators), ranked by bm25, joined to features+scenarios of the project, gracefully empty on no match.

- [ ] Step 1: Failing tests — migration roundtrip (4 tables CRUD); `searchScenarios` finds 'login' scenarios ranked, returns [] for gibberish, never throws on FTS operators input (`"AND OR (drop)"`), scope by project.
- [ ] Step 2: Implement schema + drizzle-kit generate + `search.ts` (escape query to quoted phrases). Green. Commit `feat: connections, flows, conversations tables and fts search helper`.

### Task 2: Pipeline — connections + flows generation (mock) + map API

**Files:** `server/services/analysis.service.ts` (steps), `shared/schemas.ts` (`ConnectionsSchema = { connections: Array<{ fromFeature, toFeature, type }> }`, `FlowGraphSchema`), `fixtures/llm/connections.json`, `fixtures/llm/flow.authentication.json`, `fixtures/llm/flow.tasks.json`, `server/api/projects/[id]/map/index.get.ts`, `server/services/map.service.ts`, tests.

**Interfaces:**
- Analysis step 5 (after scenarios): `generate('connections', ConnectionsSchema, features list)` → insert rows (dedupe self/duplicate pairs; unknown feature names skipped with count in statsJson). Step 6: per feature `generate('flow:' + slug, FlowGraphSchema, feature+scenarios)` → upsert `flows` row. statsJson gains `{connections, flows}`; progress labels `connections`, `flows (2/7)`. Clean-slate re-analysis wipes both tables for the project (preserve nothing — they're ai-only data).
- `GET /api/projects/:id/map` → `{ nodes: Array<{ id, featureId, name, scenarioCount, isChild }>, edges: Array<{ from, to, types: string[] }>, empty: boolean }` (empty=true when no connections — pre-Plan-2 projects).

- [ ] Step 1: Failing unit tests — pipeline (injected fake llm/github, memory DB) inserts connections+flows from fixtures; self-connections and unknown-name rows skipped + counted; re-analysis wipes; stats updated. `map.service` grouping: multiple connections between same pair collapse to one edge with `types[]`; child features appear as nodes (isChild) with their own counts.
- [ ] Step 2: Implement + fixtures ( believable: Authentication →leads_to→ Onboarding? Use the 2-feature mock world: Authentication ↔ Tasks: `shares_data`, `authenticates`, `depends_on`; flows with start/step/decision "valid credentials?"/error/end + scenarioCode refs). API thin. Green. Commit `feat: analysis generates feature connections and flow graphs`.

### Task 3: Product map page (Vue Flow)

**Files:** `app/pages/projects/[id]/map.vue` (or map/index.vue per nesting), `app/components/map/ProductMapCanvas.client.vue`, `app/composables/useMap.ts`, rail nav enable.

**Interfaces:**
- Canvas: Vue Flow with custom feature nodes (name + scenario count chip); edges labeled on hover with connection type(s) humanized ("Leads to", "Authenticates"...); controls: zoom in/out, fit-to-view, reset, fullscreen (Esc exits); search box filters — matching nodes stay raised, others dimmed (class-based); hover node → connected edges highlighted; click node → `/projects/:id/spec/:featureId`. Pan by dragging background; wheel zoom. Legend of the 9 types actually present.
- Empty state (no connections): honest copy + link to re-run analysis ("Run analysis again to build the map" — specific, per antislop copy).
- Loading + error states; responsive (canvas fills, controls collapse on small screens).

- [ ] Step 1: Failing e2e — after analysis: `/map` renders, nodes "Authentication"/"Tasks" visible, edge between them, hover shows type (assert tooltip/label text), search "auth" raises Authentication, click Authentication navigates to its spec page; fullscreen button works (class change); SSR page load has no hydration errors (console listener from Plan-1 e2e).
- [ ] Step 2: Implement (ClientOnly wrapper + skeleton). Green all gates. Commit `feat: interactive product map canvas`.

### Task 4: Flow diagram tab in feature detail

**Files:** `app/pages/projects/[id]/spec/[featureId].vue` (tabs), `app/components/spec/FlowDiagram.client.vue`, `server/api/features/[featureId]/flow/index.get.ts` (thin → spec/map service).

- [ ] Step 1: Failing e2e — feature page shows tabs "Scenarios" | "Flow diagram"; flow tab renders nodes (start/decision "…?"/end shapes distinct), decision diamond visible, node with scenarioCode shows it (mono font); no flow row → tab shows empty state with re-analysis hint; default tab remains Scenarios; anchor deep-links still work (Plan-1 behavior unchanged).
- [ ] Step 2: Implement: Vue Flow read-only (nodesDraggable=false, zoomable), node kinds visually distinct per DESIGN.md (semantic color only for `error` kind; shapes via Vue Flow node variants), legend. Green. Commit `feat: per-feature flow diagram tab`.

### Task 5: Map API test hardening + empty-predecessor migration path

**Files:** tests only (+ tiny service fixes if tests find them).

- [ ] Step 1: Unit: map endpoint for project analyzed by PRE-Plan-2 (features+scenarios but zero connections) → `empty: true`, nodes still listed; flows missing → 404 from flow endpoint handled in UI (tab hidden). e2e: fresh project on stub 'initial' state → map page shows empty state gracefully. Fix what breaks. Commit `test: map and flow degrade gracefully without plan-2 data`.

### Task 6: Sync refreshes connections + flows of affected features

**Files:** `server/services/sync.service.ts`, `shared/schemas.ts` (`SyncUpdateSchema` gains optional `connections` + `flow` fields), `fixtures/llm/sync-update.authentication.json` (extend), tests.

- [ ] Step 1: Failing unit tests — sync on 'after-auth-commit' state: Authentication's flow row updated (new fixture flow) + its connections refreshed (delete+insert for pairs touching it); **Tasks feature's flow + connections untouched (byte-for-date check)**; manual scenarios still untouched (regression). Schema-only optionality: old fixture shape still validates.
- [ ] Step 2: Implement + extend fixture. Green. Commit `feat: sync refreshes maps and flows for affected features only`.

### Task 7: Ask service — retrieval, citations, refusal

**Files:** `server/services/ask.service.ts`, `shared/schemas.ts` (`AskAnswerSchema = { covered: boolean, answer: string, citations: Array<{ index: number, scenarioId: number, quote: string }> }`), `fixtures/llm/ask-answer.json`, tests `tests/unit/ask.service.spec.ts`.

**Interfaces:**
- `ask(projectId, question, deps?): Promise<{ answer: string, citations: Array<{ index, scenarioId, code, featureId, featureName, quote }> }`
  1. `searchScenarios` top-8; **zero results → return refusal `{ answer: "The spec doesn't cover that yet.", citations: [] }` WITHOUT calling the LLM** (assert with spy).
  2. Prompt: numbered scenarios (id, code, feature, context/action/outcome); instruct: answer ONLY from these, cite `[n]`, `covered: false` if insufficient.
  3. Validate citations against the retrieval set — drop/ignore citations whose scenarioId wasn't provided (never fabricate links); ensure every `[n]` in the answer text has a matching citation entry (or strip the marker).
- Unit tests: refusal path (no LLM call); happy path maps citations to scenario rows; fake-LLM citing an unknown scenarioId → citation dropped + marker stripped; `[3]` with no citation entry → stripped.

- [ ] Step 1: Failing tests. Step 2: Implement + fixture (question about login → answer citing HP-1). Green. Commit `feat: ask service with grounded citations and honest refusal`.

### Task 8: Ask UI — bar, conversations, ⌘K

**Files:** `server/api/projects/[id]/ask/index.post.ts` (question → answer, creates conversation+messages), `server/api/projects/[id]/conversations/index.get.ts`, `.../[conversationId]/index.get.ts` + `.delete.ts` (pin/rename optional—skip), `app/pages/projects/[id]/ask/index.vue` + `[conversationId].vue`, `app/components/ask/AnswerBlock.vue` (renders `[n]` as links), `app/composables/useAsk.ts`, enable Overview bar (replace T11 stub).

**Interfaces:**
- POST `/api/projects/:id/ask` `{ question, conversationId? }` → `{ conversationId, answer, citations: [{index, scenarioId, code, action, outcome, featureId, featureName}] }` — first question creates conversation titled from the question (first 60 chars), messages stored (assistant message citationsJson). Rate: no limits (self-hosted).
- Overview bar: enabled, Enter navigates to `/ask?q=...` (page runs the ask on load); ⌘K / Ctrl+K focuses the bar globally. Ask page: input + conversation list sidebar (title + date), messages chat-style (quiet, documentation tone), citations rendered as superscript chips linking to `/projects/:id/spec/:featureId#scenario-<id>` (deep-link expansion already works from Plan 1), refusal renders the honest copy without citations.

- [ ] Step 1: Failing e2e — ask "How does sign-in work?" from Overview bar (⌘K focus → type → Enter): lands on ask page, answer visible with citation chip, click chip → spec page with the scenario row in viewport; conversation appears in sidebar; second question in same conversation appends; gibberish question ("How does the flux capacitor work?") → refusal copy, no citation chips.
- [ ] Step 2: Implement. Green all gates. Commit `feat: ask with citations, conversations and command-k bar`.

### Task 9: Full-flow e2e extension + docs

**Files:** `tests/e2e/full-flow.spec.ts` (extend), README section.

- [ ] Step 1: Extend full-flow (keep ONE test): after sync, map shows the updated flow (the refreshed Authentication flow renders — assert one new node label from the sync fixture); ask from overview with citation round-trip. Fix what breaks.
- [ ] Step 2: README: "Product map, flows and Ask" section (what they are, mock-mode note, real-key note). All gates green, one final run with counts. Commit `test: full flow covers map flows and ask; docs`.

## Post-plan (Plan 3)
Digests+SMTP, release notes editor + public page, export MD, GitHub webhook, MCP server + API keys. Parked Plan-1/2 minors live in the controller ledger + persistent memory.

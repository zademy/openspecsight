# OpenSpecSight MCP Server + API Keys (Plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Open the instance to AI agents and scripts: an MCP server (dual-era protocol) built into the Nitro app at `POST /mcp`, and `sk_sp_…` API keys that authenticate the MCP endpoint and read-only `GET` access to the existing REST API. Includes the P3 polish sweep parked in the ledger for Plan 4.

**Design authority:** `docs/superpowers/specs/2026-11-06-mcp-api-keys-design.md` (read §5 and §6 first; the protocol facts are pinned there and summarized in Task 4).

**Architecture:** One new table (`api_keys`, sha256-hashed keys) + a keys service. The auth middleware gains a session-first bearer fallback gated by a fail-closed path allowlist. A hand-rolled dual-era MCP JSON-RPC server (modern revision `2026-07-28` + legacy `initialize`) serves six read-only tools over the existing services (`spec.service`, `searchScenarios`, `ask`, releases/revisions). Zero new runtime dependencies. UI: an "API keys" section in `/settings`.

**Tech Stack:** unchanged (Nuxt 4 monolith, Nitro, better-sqlite3 + Drizzle, Nuxt UI v4, Playwright). MCP protocol implemented per the extracted 2026-07-28 spec facts (Task 4) — do NOT trust training data for MCP; the design doc's pinned facts are the source of truth.

## Global Constraints (carry over from Plan 1, verbatim intent)

- **Language:** ALL code, comments, copy, tool descriptions, generated content, and docs in English. Chat with the operator stays Spanish, but nothing committed is Spanish.
- **antislop active: during (global preference).** No em dashes in any generated copy/UI text/docs. Data delimiters in tool output (e.g. `A -->|leads to| B` Mermaid syntax) are fine. No AI-slop comments; keep existing comment style (explanatory, sparse).
- **Typecheck:** `pnpm tsc -b --force` (ALWAYS `--force`; the incremental cache once masked a real TS4115).
- **Tests:** unit via vitest (`pnpm test` or the repo's script), LLM paths under `LLM_MOCK=true` fixtures pattern already used. e2e: `pnpm build && node .output/server/index.mjs` webServer, `reuseExistingServer: false`, NEVER the dev server.
- **Secrets:** only in `.env` or generated at request time. API keys are shown once in the UI, never logged, never in test snapshots (assert on prefixes/hashes).
- **Commits:** conventional, one per task green (`feat:`, `fix:`, `test:`, `docs:`).
- **Models:** implementer and reviewer subagents use `glm-5.3-flash#high`. Prohibited models: mistral/kimi/grok/claude-opus or anything over $5/1M output tokens.
- **UI:** Nuxt UI v4 components, `DESIGN.md` energy level, dark-mode correct, accessible (labels, focus states, keyboard).

---

### Task 1: `api_keys` table + keys service

**Files:** `server/db/schema.ts` (add `apiKeys`), generated Drizzle migration (`server/db/migrations/`, same generation flow as prior tables), `server/services/keys.service.ts`, `tests/unit/keys.service.spec.ts`.

**Interfaces:**
- Table `apiKeys`: `id` text PK (crypto.randomUUID), `name` text NOT NULL, `keyHash` text NOT NULL UNIQUE (sha256 hex), `displayPrefix` text NOT NULL, `createdAt` text NOT NULL (ISO), `lastUsedAt` text, `revokedAt` text.
- `generateApiKey(): { key: string, keyHash: string, displayPrefix: string }` — `key = 'sk_sp_' + randomBytes(32).toString('base64url')`; `keyHash = createHash('sha256').update(key).digest('hex')`; `displayPrefix = `sk_sp_${key.slice(7, 11)}…${key.slice(-4)}`` (the ellipsis character here is data formatting, allowed).
- `createApiKey(db, name)` → `{ id, name, displayPrefix, createdAt, key }` (full key returned exactly once, never stored). Validates name: trimmed, 1-60 chars, else throws `ValidationError`-style error consistent with other services.
- `verifyApiKey(db, key)` → row or `null`; looks up by `keyHash`; `revokedAt != null` → `null`; on success stamps `lastUsedAt = nowISO` and persists.
- `listApiKeys(db)` → rows WITHOUT `keyHash`, ordered `createdAt DESC`.
- `revokeApiKey(db, id)` → `true` if it set `revokedAt` now, `false` if already revoked; throw not-found error if no such id (match the repo's existing not-found convention).

**Steps:**
- [ ] Schema + migration (generate, do not hand-write SQL beyond what the generator emits).
- [ ] Service with the interfaces above (reuse `getDB()` lazy-db pattern).
- [ ] Unit tests: roundtrip create→verify stamps `lastUsedAt`; wrong key → `null`; revoked → `null`; two creates produce distinct keys/hashes; `displayPrefix` format; list omits `keyHash`; name validation errors; revoke idempotence/not-found.
- [ ] Green: `pnpm test` + `pnpm tsc -b --force`. Commit `feat: api keys table and service`.

### Task 2: Bearer path in the auth middleware

**Files:** `server/utils/apiAccess.ts` (new, pure decision logic), `server/middleware/01.auth.ts` (refactor), `tests/unit/api-access.spec.ts`.

**Interfaces:**
- `export const BEARER_GET_PREFIXES: readonly string[]` = `['/api/projects', '/api/features', '/api/scenarios', '/api/scenario-revisions', '/api/releases', '/api/notes', '/api/digests']` (fail-closed: anything not listed is session-only, including future routes).
- `resolveApiAccess(input: { path: string, method: string, sessionValid: boolean, bearerKey: string | null, verify: (key: string) => boolean }): { allow: true } | { status: 401, message: string } | { status: 403, message: string }`
  Evaluation order, pinned:
  1. `sessionValid` → allow (bearer ignored, even if invalid: a stale key in the operator's browser must not break their session).
  2. No session + `bearerKey` present + `verify` false → 401.
  3. No session + valid bearer + (`GET`/`HEAD` and path starts with an allowlisted prefix) → allow.
  4. No session + valid bearer + anything else → 403, message: `API keys are read-only.`
  5. No session, no bearer → 401 (the middleware's existing session guard message).
- Middleware: keep the existing public-route exemptions (login, public release notes, GitHub webhook) and ALSO exempt `/mcp` (it does its own auth in Task 4). Otherwise call `resolveApiAccess` with the real session check (`verifySession` from `server/utils/session.ts`) and bearer extraction (`Authorization: Bearer …`). Read the current `01.auth.ts` before refactoring; preserve its behavior for every case that exists today (regression risk: the whole app).

**Steps:**
- [ ] Write `tests/unit/api-access.spec.ts` FIRST: the full matrix (session+invalid bearer GET → allow; valid bearer+GET allowlisted → allow; valid bearer+GET `/api/keys` → 403; valid bearer+POST `/api/projects` → 403; invalid bearer → 401; nothing → 401; HEAD counts as GET).
- [ ] Implement `resolveApiAccess` pure; wire the middleware.
- [ ] Full unit suite still green (auth/session specs). Commit `feat: bearer api key access for read-only GET routes`.

### Task 3: Keys REST API + Settings section

**Files:** `server/api/keys/index.get.ts`, `server/api/keys/index.post.ts`, `server/api/keys/[id].delete.ts`, `app/components/settings/ApiKeyManager.vue` (new), `app/pages/settings/index.vue` (add section), `tests/unit/keys-routes.spec.ts` (if the repo has a route-test pattern; otherwise test the service layer and cover routes in e2e Task 7 — check how existing routes are tested first and follow that pattern).

**Interfaces:**
- `GET /api/keys` (session) → `{ keys: Array<{ id, name, displayPrefix, createdAt, lastUsedAt, revokedAt }> }`.
- `POST /api/keys` (session, body `{ name }`) → 201 `{ id, name, displayPrefix, createdAt, key }` — the ONLY response that ever contains a full key.
- `DELETE /api/keys/:id` (session) → 204; 404 unknown id.
- UI section "API keys" under the existing settings sections (match their heading/badge patterns): UTable (or existing list pattern) with name, `displayPrefix` in mono font, created, last used (relative time pattern used elsewhere), Revoked badge when applicable; "New key" button → UModal with a name input → POST → reveal-once panel: full key in mono with a copy button and the copy "You will not see this key again. Store it now."; revoke → confirm modal ("Revoke key? Agents using it stop working immediately.") → DELETE → refresh list.
- Empty state: one honest line explaining what keys are for (MCP + read-only API), no marketing tone.

**Steps:**
- [ ] Routes (thin: validate, call service).
- [ ] Settings UI section (component, `useAsyncData`/`$fetch` pattern of the existing settings page; copy in English, no em dashes).
- [ ] Tests per repo pattern + manual visual check is NOT enough: e2e comes in Task 7. Commit `feat: api key management in settings`.

### Task 4: MCP endpoint, dual-era protocol core

**Files:** `server/routes/mcp.post.ts` (POST `/mcp`, outside `/api/`), plus a GET/DELETE handler returning 405 JSON `{ error }` pointing to the README section; `server/services/mcp/protocol.ts` (types + error builders + era logic), `server/services/mcp/server.service.ts` (method routing), `tests/unit/mcp-protocol.spec.ts`.

**Pinned protocol facts** (from `docs/superpowers/specs/2026-11-06-mcp-api-keys-design.md` §5, extracted 2026-11-06 from the official spec):
- JSON-RPC 2.0 envelopes; malformed body → HTTP 200-compatible JSON-RPC error `-32700` (transport may use 400; pick one, pin it in tests, document in a comment).
- **Era detection is by request shape:** `params._meta['io.modelcontextprotocol/protocolVersion']` present OR `MCP-Protocol-Version` header present → modern; else legacy.
- **Modern:** `MCP-Protocol-Version` header MUST be present AND equal `_meta`'s version (when both present) else HTTP 400 + code `-32020` (HeaderMismatch); `Mcp-Method` header MUST equal the body `method` (same failure); `Mcp-Name` MUST equal `params.name` when the method has one. Only accepted version: `2026-07-28`; any other → HTTP 400 + `UnsupportedProtocolVersionError` code `-32022` with `data.supported: ['2026-07-28']` (copy the error's exact `data` shape from https://modelcontextprotocol.io/specification/2026-07-28/schema#unsupportedprotocolversionerror and pin in a test). Methods: `server/discover` (copy `DiscoverResult` fields verbatim from https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult and pin; advertise capabilities `{ tools: {} }` and supported version), `tools/list`, `tools/call`. `ping` was REMOVED in 2026-07-28 → modern `ping` is an unknown method. Unknown modern method → HTTP 404 + `-32601`. Every modern result includes `_meta['io.modelcontextprotocol/serverInfo'] = { name: 'openspecsight', version: <from package.json via runtime config or constant> }`.
- **Legacy:** `initialize` (no version header/meta) → result `{ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: {...} }`; then `tools/list`, `tools/call`, `ping` → `{}` work without headers; unknown legacy method → JSON-RPC `-32601` (HTTP 200).
- **Both:** notifications (no `id`) → HTTP 202 empty body. Auth BEFORE protocol: require operator session OR valid bearer key (`verifyApiKey`, stamps `lastUsedAt`); otherwise 401 `{ error }`. Never issue `Mcp-Session-Id`; never SSE.
- `tools/list` result (modern): `{ tools: [...], ttlMs: 60000, cacheScope: 'private', _meta: { serverInfo } }`, tools sorted by name (deterministic). Tool def: `{ name, title, description, inputSchema }`.
- `tools/call` result: `{ content: [{ type: 'text', text }], isError?: true }`. Handler failures (bad args, unknown project) are TOOL errors (`isError: true` with a helpful text), never transport errors.

**Interfaces:**
- `type McpTool = { name: string, title: string, description: string, inputSchema: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown> }`
- `handleMcpRequest(input: { body: unknown, headers: { protocolVersion?: string, method?: string, name?: string }, tools: McpTool[] }): { status: number, body?: unknown }` — pure-ish core; the route does auth + body read + delegate. Tool registry injected (Task 5 fills it; Task 4 tests use fake tools).

**Steps:**
- [ ] Tests first with fake tools: era detection both ways; modern header validation matrix; version gate `-32022`; discover (pinned shape); tools/list (ttlMs/cacheScope/serverInfo/order); tools/call success + tool error; unknown methods per era; notifications 202; `-32700`; `ping` both eras.
- [ ] Implement protocol + server service + route; commit `feat: mcp endpoint with dual-era protocol core`.

### Task 5: MCP tools over the living spec

**Files:** `server/services/mcp/tools.ts`, maybe `server/services/mcp/projectRef.ts` (resolution helper), `tests/unit/mcp-tools.spec.ts`.

**Interfaces** (all handlers resolve the project first via `resolveProjectRef(ref)` matching `owner/repo` from `repositories` join, falling back to exact project `name`; unknown/ambiguous → tool error listing valid refs):
- `list_projects` → `[{ id, name, ownerRepo, branch, description }]` (values agents pass back as `project`).
- `list_features(project)` → the `getFeatureTree(projectId)` shape (id, name, description, scenarioCount, children).
- `get_feature(project, feature)` — `feature` accepts feature name (exact, case-insensitive) or numeric id; returns description, scenarios (code, given/when/then fields as stored: context/action/outcome, category, source; flag `manual: source === 'manual'`), and the feature's flow as Mermaid text via a new pure helper `flowToMermaid(graph: FlowGraph): string` (`graphJson` from `flows`; node `id[label]`, edge `a -->|type| b`; omit the section with a `"No flow diagram recorded for this feature."` note when absent).
- `search_spec(project, query, limit? = 10)` → `searchScenarios(db, projectId, query, limit)` hits (scenario text + featureName + scenarioId) plus features whose name LIKE-matches the query; merged, labeled by kind.
- `recent_changes(project, limit? = 20)` → `scenarioRevisions` with `state = 'applied'` joined to their release (title, sha, committedAt), feature name, `kind` (new/changed/gone/fixed), ordered committedAt DESC.
- `ask(project, question)` → `ask(projectId, question)` from `server/services/ask.service.ts` (verify while implementing: if the base `ask()` persists conversations, route MCP through a non-persisting path; from current source it does not persist, the API route layer does). Returns `{ answer, refused, citations }`.
- Tool `inputSchema`s: plain JSON Schema objects with `type: 'object'`, typed properties, `required` arrays. Validate args manually with clear tool errors.

**Steps:**
- [ ] Tests with the standard in-memory DB fixtures (projects + features + scenarios + revision/release rows): each tool happy path; unknown project error lists refs; unknown feature error; `flowToMermaid` shape; `ask` under the mocked-LLM fixture pattern; manual scenario flagged.
- [ ] Implement; register tools in the `/mcp` route from Task 4. Commit `feat: read-only mcp tools over the living spec`.

### Task 6: README documentation

**Files:** `README.md`.

- New "API keys and MCP" section after the existing feature sections: what keys are (read-only, instance-wide); how to create one in Settings; curl example `curl -H "Authorization: Bearer sk_sp_…" http://localhost:3000/api/projects`; MCP client config JSON (Claude Code / Cursor style): `{ "mcpServers": { "openspecsight": { "url": "http://localhost:3000/mcp", "headers": { "Authorization": "Bearer sk_sp_…" } } } }`; the six tools with one-line descriptions; a security note (read-only, revocable, hash-stored).
- English, no em dashes, no marketing tone. `tests/unit/env-example.spec.ts` must stay green (no `.env` changes — zero new env vars by design).

**Steps:** [ ] Write section, self-check antislop copy rules, `pnpm test` still green. Commit `docs: api keys and mcp server usage`.

### Task 7: e2e, keys + MCP

**Files:** `tests/e2e/keys-mcp.spec.ts`.

**Flow (LLM_MOCK via existing global-setup):**
- [ ] Login → Settings → create key ("e2e key") → reveal-once panel visible with `sk_sp_` prefix + copy button → close → list shows name + `displayPrefix`, NOT the full key anywhere in DOM.
- [ ] Playwright `request` context (no cookies): `GET /api/projects` with bearer → 200; without → 401; `POST /api/projects` with bearer → 403; `GET /api/keys` with bearer → 403.
- [ ] `POST /mcp` without key → 401. Modern `tools/list` (headers `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: tools/list`, `_meta` version) → 200, six tools, `ttlMs` present. `tools/call` `list_projects` → the seeded project. Legacy `initialize` → `2025-06-18` result, then legacy `tools/list` (no headers) → 200. Missing `Mcp-Method` header on a modern request → 400 `-32020`.
- [ ] Revoke the key via UI → `GET /api/projects` with it → 401.
- [ ] WebServer: production build, `reuseExistingServer: false`. Commit `test: e2e for api keys and mcp`.

### Task 8: P3 polish sweep (parked items)

**Files:** wherever each item lives; the ledger names them (`docs/superpowers/ledgers/controller-ledgers.md` "Parked for Plan 4 / polish"). Items:
1. `/api/notes/public/` empty-slug 302 + router warnings.
2. Loud 404 logs.
3. Annotation bodies with quotes/markdown break the export format.
4. Voices manager SSR wasted fetch.
5. Double-Enter job race in modals.
6. "N of M published" summary copy.
7. `emailedAt` client-fabricated (refetch after send).
8. Stub aliases 4→10 (reuse policy).
9. Saved-label relative-time flake candidate (re-triage: prefer pinning the clock over changing copy; only act if the fix is clearly safe).
10. README:47/64 pre-existing em dashes (authored pre-Plan-3; fix now under antislop).

**Steps:**
- [ ] Reproduce each in a test or by inspection FIRST (no blind fixes); fix the mechanical ones with a test each where feasible; any item that turns out risky or not-a-bug gets a one-line ruling in the task report instead of a change.
- [ ] Green: unit + e2e + tsc. Commit `fix: polish sweep of parked plan-3 items` (or split commits if cleaner).

---

## Review Focus (per task, beyond the standard checklist)

- T2 is the highest-regression task: EVERY pre-existing auth behavior must be unchanged (public routes, session guard, webhook HMAC path). The reviewer must diff the middleware against main mentally and confirm.
- T4: protocol compliance is only "done" if every pinned fact has a test asserting it; no extra protocol surface beyond the pins (no sessions, no SSE, no sampling).
- T5: tools must be read-only — reviewer greps for INSERT/UPDATE/DELETE outside `verifyApiKey`'s `lastUsedAt` stamp.
- Copy review: antislop rules, English, no em dashes, honest states.

## Definition of Done (plan level)

`pnpm lint` clean, `pnpm tsc -b --force` clean, all unit tests green, all e2e green (production webServer), README updated, ledger updated with rulings, no new runtime dependencies.

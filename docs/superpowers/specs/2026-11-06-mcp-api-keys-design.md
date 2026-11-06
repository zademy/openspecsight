# OpenSpecSight — MCP Server + API Keys (Plan 4) — Design

**Date:** 2026-11-06
**Status:** decided (owner delegated the design calls on 2026-11-06 with "sigue tú"; every call below is the controller's, marked where it matters)
**Parent spec:** `2026-11-03-openspecsight-design.md` (this is the detailed design for its §8 "Extras: MCP server + API keys")

## 1. Intent and why

OpenSpecSight holds a living spec that only a browser session can read today. The people who most need it while working are AI coding agents: an agent implementing a feature should be able to check what the product does, read a feature's scenarios, see what changed recently, and ask questions answered from the spec. Plan 4 opens the instance to those clients two ways:

1. An **MCP server** built into the Nitro app, so tools like Claude Code or Cursor can query the living spec directly.
2. **API keys** (`sk_sp_…`) that authenticate both the MCP endpoint and read-only `GET` requests on the existing REST API for scripts and curl.

## 2. Goals

- Agents and scripts can read every project's spec: features, scenarios, flows, recent changes, plain-word search, and LLM answers with citations (Ask).
- Keys are created/revoked by the operator in Settings, stored hashed, shown once, and stamp `last_used_at`.
- The MCP endpoint speaks the current MCP Streamable HTTP transport (JSON-RPC 2.0, POST) with a tools-only surface, and works with standard clients (Claude Code, Cursor) via a documented URL + bearer header config.
- Unit tests pin the protocol behavior; e2e covers key creation in the UI and one real MCP round trip under `LLM_MOCK=true`.

## 3. Non-goals

- Write scopes of any kind (keys are read-only forever in v1).
- MCP resources, prompts, sampling, notifications, or stdio transport.
- Per-project keys, key expiry, rate limiting (documented instead; keys are revocable).
- Multi-operator accounts.

## 4. Anti-goals

- Any path where an external key mutates the spec, scenarios, releases, digests, or triggers syncs. Manual edits stay protected by the existing byte-exact rules; automated writes are exactly what this plan must not introduce.
- A second process to deploy or configure. The MCP server is part of the same Nuxt app; zero new env vars.

## 5. Approaches considered

**MCP transport and implementation.**
(a) Official `@modelcontextprotocol/sdk` bridged into h3. Full protocol surface, but it drags Node req/res bridging and a heavy dependency for a server that only serves tools.
(b) Hand-rolled **dual-era** JSON-RPC implementation inside a Nitro route, pinned to the published spec: modern revision `2026-07-28` (stateless, `_meta` versioning, `server/discover`) plus the legacy `initialize` handshake for older clients. Plain `application/json` responses (allowed: the server MAY answer each POST with a single JSON object), no SSE, no sessions, no new deps.
**Chosen: (b)**, matching the project's style of small owned implementations (queue, HMAC webhook, LLM shape-hint repair). The protocol facts below were extracted from the current spec pages on 2026-11-06 and must be pinned by unit tests:

- **Era detection:** a request carrying `params._meta["io.modelcontextprotocol/protocolVersion"]` or the `MCP-Protocol-Version` header is modern; `initialize` without either is legacy. Era determination is by request shape.
- **Modern requests:** `MCP-Protocol-Version` header MUST be present and match `_meta`'s version; `Mcp-Method` header MUST match the body method; `Mcp-Name` MUST match `params.name` where the method has one (`tools/call`). Any failure → HTTP 400 + JSON-RPC code `-32020` (`HeaderMismatch`). Version we implement: exactly `2026-07-28`; anything else → HTTP 400 + `UnsupportedProtocolVersionError` listing `["2026-07-28", "legacy"]` (exact code and shape pinned from the schema page).
- **Modern methods:** `server/discover` (MUST: identity, capabilities, supported versions), `tools/list`, `tools/call`. `ping` was REMOVED in `2026-07-28`: modern `ping` → HTTP 404 + `-32601`. Any other modern method → HTTP 404 + `-32601`.
- **Modern results:** every result carries `_meta["io.modelcontextprotocol/serverInfo"]`; `tools/list` is a `CacheableResult` with `ttlMs` (we use `60000`: the spec is living data) and `cacheScope: "private"` (responses are Authorization-protected; shared caches must not store them), tools in deterministic (alphabetical) order.
- **Legacy requests:** `initialize` (capabilities `{ tools: {} }` + serverInfo), `tools/list`, `tools/call`, `ping` → `{}`; unknown legacy method → JSON-RPC `-32601` on HTTP 200; malformed JSON → `-32700`.
- **Both eras:** notifications (no `id`) → HTTP 202, empty body; JSON-RPC 2.0 envelope; `-32700` for unparseable bodies; a valid key used where keys are not allowed → `403` "API keys are read-only".
- **Auth:** the MCP endpoint accepts the operator session or a valid bearer key; every authenticated bearer use stamps `last_used_at`. `GET`/`DELETE` on `/mcp` → 405 (GET streaming and sessions are optional/removed; we serve neither).

**API keys.** Instance-level (single operator owns every project) vs per-project binding. **Chosen: instance-level**: one operator deploys the app, and scoping keys to projects adds management UI for no security boundary. Keys authenticate the MCP endpoint and `GET /api/**` only; every non-GET and every mutating route keeps requiring the operator session.

**Where keys live in the UI.** A new "API keys" section in the existing `/settings` page: table (name, `sk_sp_…abcd` display prefix, created, last used), create dialog with reveal-once + copy button, revoke with confirm.

## 6. Design

### 6.1 API keys

- Format: `sk_sp_` + 32 random bytes, base64url (~49 chars total). Generated server-side with `node:crypto`.
- Storage: sha256 hex of the full key as the unique lookup column; a short display prefix (first 4 + last 4 chars after `sk_sp_`) for the list view. The full key is never persisted or logged.
- Table `api_keys`: `id` (uuid), `name`, `key_hash` (unique), `display_prefix`, `created_at`, `last_used_at` (nullable), `revoked_at` (nullable). Drizzle migration, same pattern as the existing tables.
- Lifecycle: create (session-authed `POST`), list, revoke (soft: set `revoked_at`; verify rejects revoked). `last_used_at` is stamped on every authenticated bearer use.
- Lookup is by hash equality, so there is no timing side channel and no plaintext anywhere.

### 6.2 Bearer auth on the REST API

`server/middleware/01.auth.ts` already exempts public surfaces and enforces the session elsewhere. Plan 4 adds a bearer path with two pinned rulings:

**Allowlist, fail-closed.** A bearer-authenticated request passes the guard **only** when the method is `GET`/`HEAD` **and** the path starts with one of: `/api/projects`, `/api/features`, `/api/scenarios`, `/api/scenario-revisions`, `/api/releases`, `/api/notes`, `/api/digests`. Operator-management surfaces stay session-only on purpose: `/api/keys` (a leaked key must not scout sibling keys' prefixes or `last_used_at`), `/api/mail-status`, `/api/webhook-status`, `/api/webhooks`, `/api/auth`. Routes added later are bearer-blocked by default until listed.

**Session-first precedence.** When a valid session cookie is present, it wins and any `Authorization` header is ignored (a stale bearer in the operator's browser tooling must not break their session). The bearer is evaluated only when there is no valid session: valid + allowlisted GET passes and stamps `last_used_at`; a valid key used anywhere it is not allowed (non-GET, or a session-only route) gets `403` with an honest message ("API keys are read-only"); an invalid or missing credential gets `401`. The public release-notes and webhook routes keep their existing behavior.

### 6.3 MCP endpoint

- Single route: `POST /mcp` (+ `GET`/`DELETE` → `405` with a short JSON pointer to the docs; no SSE stream, no session).
- Auth: operator session or bearer key (see §6.2); missing/invalid → `401`.
- JSON-RPC 2.0 dual-era handling exactly as pinned in §5. The two exact shapes still to copy verbatim from the spec while implementing (task T4): the `DiscoverResult` fields and the `UnsupportedProtocolVersionError` code/`data`. Tests assert them.
- Every tool result is text content (JSON stringified for structured payloads). Tool errors are returned as MCP tool errors (`isError: true`), not transport errors, so agents see them inline.

### 6.4 Tools (all read-only, all take a `project` reference except the first)

| Tool | Returns |
|---|---|
| `list_projects` | id, name, `owner/repo`, description (the values agents pass as `project`) |
| `list_features(project)` | the two-level feature tree with scenario counts |
| `get_feature(project, feature)` | description, all scenarios (manual ones flagged), source, and the feature's flow diagram as Mermaid text |
| `search_spec(project, query)` | ranked FTS5 hits across features and scenarios (reuses the Ask search core) |
| `recent_changes(project, since?)` | latest applied changes with their plain-word summaries |
| `ask(project, question)` | an answer with citations, reusing `ask.service` in ephemeral mode: no conversation rows are written for MCP calls |

`project` is accepted as `owner/repo` (or the project name as fallback); ambiguous or unknown values return a tool error naming the known projects.

### 6.5 Documentation

README gains an "API keys and MCP" section: how to create a key, a curl example for `GET /api/...`, and client config JSON (Claude Code / Cursor style) pointing at `/mcp` with the bearer header. English throughout, no em dashes in copy (antislop).

### 6.6 P3 polish sweep

The ledger parked ten minors "for Plan 4 / polish" (`controller-ledgers.md`). The plan carries them as one final polish task: fix the mechanical ones (empty-slug 302, loud 404 logs, stub aliases 4→10, double-Enter in modals, emailedAt refetch, "N of M published" copy, annotation quoting in export, voices SSR fetch), and re-triage the flake candidates (Saved-label relative time) rather than blindly changing them.

## 7. Constraints

- Stack unchanged: Nuxt 4 monolith, Nitro, better-sqlite3 + Drizzle, Nuxt UI v4. No new runtime dependencies.
- All copy, tool descriptions, and docs in English. Tests under `LLM_MOCK=true`; e2e builds and runs the production server (`reuseExistingServer: false`), never the dev server.
- Secrets only ever in `.env` or generated at request time; keys are shown once in the UI, never in logs, never in test snapshots.

## 8. Left to the builder

- Exact MCP protocol version string and field spellings (settle from the current spec during planning; pin in tests).
- Nitro route shape for raw-body JSON-RPC handling and the exact auth-guard refactor in `01.auth.ts`.
- How the ephemeral `ask` reuses `ask.service` internals (extract vs parameterize; prefer the smaller diff).
- Settings section layout details within Nuxt UI v4 patterns and DESIGN.md's energy level.

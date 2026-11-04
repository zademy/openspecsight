# OpenSpecSight Communication (Phase 7–8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** The spec reaches people: weekly/on-demand email digests (SMTP), AI-drafted release notes with a block editor and a public page, Markdown export, and a GitHub webhook that syncs automatically on push.

**Architecture:** Extends the merged Plan-1/2 core (conventions carry over — see `docs/superpowers/plans/2026-11-03-openspecsight-core.md` Global Constraints + ledgers). New tables: `digests`, `releaseNotes`, `voices`. New services: `mail.service.ts` (nodemailer behind an injectable transport), `digests.service.ts`, `releaseNotes.service.ts`, `export.service.ts`, `webhook.service.ts`. Public content mounts at `/notes/[slug]` (auth-exempt, read-only). Webhook at `/api/webhooks/github` (HMAC-signed, auth-exempt by necessity).

**Tech Stack:** existing + `nodemailer` (no other deps). LLM mock fixtures for digest-draft, note-draft, note-enhance.

**Spec:** `docs/superpowers/specs/2026-11-03-openspecsight-design.md` §2 (digests, release notes, export, webhook), §6 (SMTP config), §7.2 env, §7.4 step 4.

**Out of scope (Plan 4, optional):** MCP server + API keys.

## Global Constraints (carry over + new)

- All Plan-1/2 conventions: layering, typed-$fetch, English, TS strict, conventional commits, status-code asserts, DESIGN.md + antislop-ui/copywriting binding (`.opencode/skills/antislop*`), skills via skill tool, context7 available for docs, LLM mock colon-slug fixtures, stub on 9876 with `/_admin/state`, login helper in `tests/e2e/helpers/login.ts`, e2e = production build via `node .output/server/index.mjs`, `reuseExistingServer: false`.
- **Secrets:** SMTP creds + `GITHUB_WEBHOOK_SECRET` only via env; webhook secret NEVER shown in API responses after set (show masked hint in settings UI); public note pages must not leak PATs/revisions' beforeJson internals.
- **Auth exemptions (surgical):** server middleware exempts exactly `/api/notes/public/` and `/api/webhooks/github`; page middleware allows `/notes/`. Everything else stays behind auth.
- **No email without explicit config:** SMTP unset → digests generate but record `emailedAt: null` + status note "SMTP not configured" (never crash, never silently claim sent).
- Webhook: validate `x-hub-signature-256` HMAC against `GITHUB_WEBHOOK_SECRET`; reject 401 on bad/missing signature; only `push` events on a watched repo+branch enqueue a sync (one job, deduped by the existing 409 guard).
- Real-mode smoke lessons already in main: shape hint + repair are automatic for every new generate call; prompts must ask for complete sets.

## Review Focus

1. **Public page isolation** — `/notes/[slug]` renders ONLY published notes (404 for drafts), no auth-gated data leaks. Test pinned in Task 6.
2. **SMTP-off honesty** — no fake "sent" states anywhere. Test pinned in Task 4.
3. **Webhook security** — unsigned/wrong-signature requests never enqueue anything; correct signature + matching repo/branch enqueues exactly one sync. Test pinned in Task 9.
4. **Editor autosave cannot lose user edits** — PATCH is field-level; concurrent enhance + manual edit must not clobber (last-write-wins per block is acceptable, documented). Test pinned in Task 7.
5. **Export is complete** — the Markdown contains every feature + scenario + connection of the project (counts asserted vs DB). Test pinned in Task 8.

---

### Task 1: Schema + migration (digests, releaseNotes, voices)

**Files:** `server/db/schema.ts`, `server/db/migrations/` (generated), `shared/schemas.ts` + `shared/types.ts`, tests.

**Interfaces:**
- `digests (id, projectId→projects, rangeFrom text ISO date, rangeTo text, title text, blocksJson text, emailedAt text nullable, createdAt text)` — blocks = `Array<DigestBlock>` where `DigestBlock = { type: 'heading'|'paragraph'|'list', text?: string, items?: string[] }` (zod `ContentBlocksSchema`).
- `releaseNotes (id, projectId→projects, title text, rangeFrom text, rangeTo text, voiceId integer nullable→voices, blocksJson text, slug text UNIQUE, published integer 0|1, createdAt text, publishedAt text nullable)`.
- `voices (id, projectId→projects, name text, description text, isDefault integer 0|1)` — max 3 per project, exactly ≤1 default (enforced in service).
- deleteProject cascade extended to the three tables (transactional, existing pattern).
- zod: `DigestDraftSchema = { title: string, blocks: ContentBlocks }`; `NoteDraftSchema = { title: string, blocks: ContentBlocks }`; `NoteEnhanceSchema = { text: string }`.

- [ ] Step 1: Failing tests — CRUD roundtrips, unique slug collision behavior (service-level, Task 5), cascade delete covers 3 new tables. Step 2: Implement + drizzle-kit generate. Green. Commit `feat: digests, release notes and voices tables`.

### Task 2: Mail service (SMTP, injectable transport)

**Files:** `server/services/mail.service.ts`, `server/utils/mailRenderer.ts` (blocks → text + minimal inline HTML), tests.

**Interfaces:**
- `createMailService(deps?: { transport?: MailTransport }): MailService` with `isConfigured(): boolean` (SMTP_HOST+SMTP_USER+SMTP_PASS set) and `send(opts: { to: string[], subject: string, text: string, html: string }): Promise<{ messageId: string }>`; `MailTransport = { sendMail(o): Promise<{ messageId: string }> }`; default transport = nodemailer with env SMTP_HOST/PORT/USER/PASS/FROM (Gmail: 587 + app password; no TLS special-casing beyond nodemailer defaults).
- Renderer: heading → `## text` / `<h2>`, paragraph → text/`<p>`, list → bullets/`<ul>`; plain, no styling beyond minimal (ENERGY 1, emails are content).
- Unit tests with a fake transport (assert to/subject/body shape; isConfigured false when env partial). NO network in tests.

- [ ] Failing tests → implement → green. Commit `feat: smtp mail service with injectable transport`.

### Task 3: Digest generation + scheduling

**Files:** `server/services/digests.service.ts`, `server/api/projects/[id]/digests/index.get.ts` + `index.post.ts`, `server/tasks/weekly-digest.task.ts`, `nuxt.config.ts` (nitro scheduled task), fixtures `digest-draft.json`, `app/pages/projects/[id]/digests/index.vue` + `[digestId].vue`, rail "Digests" enabled, tests.

**Interfaces:**
- `generateDigest(projectId, rangeFrom, rangeTo, deps?): Promise<digestId>` — aggregates releases+revisions in range (counts + per-feature highlights), LLM `generate('digest-draft', DigestDraftSchema)` → title + blocks (fixture: believable weekly summary of the mock world), stores with emailedAt null.
- `POST /api/projects/:id/digests { rangeFrom?, rangeTo? }` → 202 `{ digestId }` (defaults: last 7 days); 409 if a digest generation job is queued|running for the project (reuse jobs table, type `digest`); kicks processing.
- `GET /api/projects/:id/digests` → list `{id, title, rangeFrom, rangeTo, emailedAt, createdAt}` newest first. `GET /api/digests/:id` → full blocks (+email status).
- Weekly: nitro task `digests:weekly` with schedule (env-independent config in nuxt.config; runtime check: `DIGEST_WEEKLY_ENABLED=true` else no-op) → for each project with releases in the past week, generate (+ send via Task 4's `deliverDigest` if SMTP configured). Boot-registered, does not block startup.
- UI: list + "New digest" (date range picker or defaults) + detail page rendering blocks (reuse a shared `ContentBlocks.vue` component — build it here, Task 6 reuses); progress states from the analyses-style job pattern (poll while generating).

- [ ] Failing unit tests (aggregation correctness, defaults, fixture draft stored, 409 guard) → implement → failing e2e (create → generate → detail renders title+blocks; "Digests" rail) → green. Commit `feat: weekly and on-demand digests`.

### Task 4: Digest email delivery

**Files:** `server/services/digests.service.ts` (`deliverDigest`), `server/api/digests/[id]/send.post.ts`, tests.

**Interfaces:**
- `deliverDigest(digestId, deps?): Promise<{ sent: boolean, reason?: string }>` — renders blocks via mailRenderer; SMTP configured → `mail.send` to `DIGEST_RECIPIENTS` (comma-split), set emailedAt; NOT configured → `{ sent:false, reason:'SMTP is not configured' }`, emailedAt stays null. Refuses to re-send an already-emailed digest (409) unless `?force=true`.
- `POST /api/digests/:id/send` → `{ sent, reason? }`. UI: "Email to recipients" button on detail with honest state ("SMTP not configured — set SMTP_* to enable" when isConfigured false).

- [ ] Failing unit tests (fake transport: sent→emailedAt set; unconfigured → not sent + reason; double-send 409) → implement → e2e asserts the honest unconfigured state (real e2e has no SMTP) → green. Commit `feat: digest email delivery with honest smtp-off state`.

### Task 5: Voices + release-note drafting

**Files:** `server/services/releaseNotes.service.ts`, `server/api/projects/[id]/voices/` (GET/POST/DELETE + set-default PATCH), `server/api/projects/[id]/release-notes/index.post.ts` (draft) + `index.get.ts`, fixtures `note-draft.json`, tests.

**Interfaces:**
- Voices CRUD: max 3 per project (4th → 409 with message), delete default → another becomes default? No: delete default → notes fall back to "Default voice" (project keeps ≤1 default: creating first voice marks it default; explicit PATCH sets default).
- `draftNote(projectId, { releaseId?, rangeFrom?, rangeTo?, voiceId?, revisionIds? }, deps?)` — scope: one release OR date range (xor, zod-refined); selection = revisions in scope (optionally filtered by revisionIds; default all); LLM `generate('note-draft', NoteDraftSchema)` with the voice description + selected revisions → title + blocks; slug = kebab(title) + short suffix (unique); published 0.
- `POST /api/projects/:id/release-notes` → 202 `{ noteId }` (job, 409 guard per project). `GET .../release-notes` → list `{id, title, slug, range, published, createdAt}`.

- [ ] Failing unit tests (voice limits/default logic; draft stores fixture blocks + unique slug; xor scope; revision filter) → implement → green. Commit `feat: voices and ai-drafted release notes`.

### Task 6: Public note page + blocks renderer + publish

**Files:** `app/pages/notes/[slug].vue` (+ auth exemptions), `app/pages/projects/[id]/release-notes/index.vue` + `[noteId].vue` (editor comes Task 7 — this task: read-only draft view + Publish button + copy-link), `server/api/notes/public/[slug].get.ts` (exempt), `server/api/release-notes/[id]/index.get.ts` + `publish.post.ts` (or PATCH), `app/components/content/ContentBlocks.vue` (shared with digests), rail "Release notes" enabled, tests.

**Interfaces:**
- Public GET returns ONLY published notes: `{ title, publishedAt, blocks }` — 404 drafts/unknown. Server middleware exempts exactly `/api/notes/public/`; page middleware allows `/notes/`.
- Publish: sets published=1 + publishedAt (idempotent → 200). Unpublish (drafts back) → optional, include (published=0) for editability.
- UI: list (title, range, published badge, view/edit); draft detail: rendered blocks + "Publish" + "Copy public link" (appears when published); public page: quiet, no app chrome beyond wordmark + "Powered by OpenSpecSight" footer line (antislop: honest, no marketing).

- [ ] Failing e2e — draft → publish → visit `/notes/<slug>` logged-OUT (fresh context) renders; draft slug → 404 before publish; authenticated app pages unchanged. Unit: public endpoint 404s drafts; exemptions exact (an unrelated `/api/notes/...` path still 401s). Commit `feat: publish release notes to a public page`.

### Task 7: Block editor + enhance

**Files:** `app/pages/projects/[id]/release-notes/[noteId].vue` (editor), `server/api/release-notes/[id]/index.patch.ts` (field-level blocks/title autosave), `.../blocks/[index]/enhance.post.ts`, fixtures `note-enhance.json`, tests.

**Interfaces:**
- PATCH `{ title? blocks? }` — zod-validated, saves what's sent (autosave on 800ms debounce after edits; "Saved" quiet indicator).
- Editor: block list — click to edit textarea (heading/paragraph), list items one-per-line; add block (type picker), delete, move up/down; no drag-drop (keep it calm); block chips show type.
- `POST .../blocks/:index/enhance { instruction? }` → LLM `generate('note-enhance:<noteSlug?>' → base fixture 'note-enhance')` returns `{ text }` rewriting THAT block only in the note's voice; heading blocks are not enhancable (UI hides it); response replaces the block content + autosave — concurrent manual edit: PATCH last-write-wins per whole blocks array (documented in code comment; Review Focus #4: debounce flushes before enhance, then enhance result applied).
- e2e: edit title + block → autosaved (reload keeps), enhance a paragraph (mock returns fixed text) → replaced, publish flow intact, manual edit after enhance not clobbered by stale response (sequential UI flow).

- [ ] Failing unit (PATCH field-level; enhance stores returned text only for the block) → implement → e2e → green. Commit `feat: release note block editor with per-block enhance`.

### Task 8: Markdown export

**Files:** `server/services/export.service.ts`, `server/api/projects/[id]/export/markdown.get.ts`, button in spec page header, tests.

**Interfaces:**
- `exportProjectMarkdown(projectId): string` — H1 project name; per top-level feature H2 (+children H3): description + grouped scenarios (`HP-1 · action → outcome` per context group); connections appendix (`A —leads to→ B` humanized types); generated header line with date + stats. `GET` → `Content-Disposition: attachment; filename="<project>.md"`.
- Unit: seeded project → exported string contains every feature name + every scenario code + every connection pair (counts vs DB); e2e: download from spec page → file contains the fixture codes.

- [ ] TDD → green. Commit `feat: project spec markdown export`.

### Task 9: GitHub webhook

**Files:** `server/api/webhooks/github.post.ts`, `server/services/webhook.service.ts`, `.env.example` (+`GITHUB_WEBHOOK_SECRET=`), settings UI section (webhook URL + "secret configured" state, masked), README section, tests.

**Interfaces:**
- `POST /api/webhooks/github`: raw body read; verify `x-hub-signature-256` = HMAC-SHA256(body, GITHUB_WEBHOOK_SECRET) timing-safe; 401 bad/missing; secret unset → 503 "Webhook secret not configured". Event `push`: payload repo.full_name + ref `refs/heads/<branch>` match a repository row → enqueue ONE `sync` job (project dedupe via existing guard) + kick; other events → 200 noop; ping → 200 `{ ok: true }`.
- Settings page: shows `POST {PUBLIC_APP_URL}/api/webhooks/github` + masked secret state + link to README setup.
- Unit: correct signature+repo+branch → job enqueued once; wrong signature → 401 + no job; right repo wrong branch → no job; unset secret → 503. e2e: extend the stub? No — e2e posts directly to the endpoint with a computed signature (crypto in test) against the built server, after `/_admin/state` push → sync runs to completion.

- [ ] Failing unit → implement → e2e → green. Commit `feat: github push webhook triggers sync`.

### Task 10: Full-flow extension + docs + final sweep

**Files:** `tests/e2e/full-flow.spec.ts` (extend the ONE test), README, `.env.example` review.

- [ ] Extend full-flow after the ask leg: generate digest (mock) → detail renders; draft release note from the release → edit a block → enhance → publish → logged-out public page renders; export MD download contains the release title; webhook signed push → sync completes. Fix what breaks (product bugs, not test weakening).
- [ ] README: "Digests and email" (SMTP/Gmail app-password, DIGEST_RECIPIENTS, weekly toggle), "Release notes" (draft→edit→publish, public link, voices), "Export", "Automatic syncs (webhook)" (setup steps, secret). All honest English per antislop-copywriting.
- [ ] All gates green in one final run; report counts. Commit `test: full flow covers communication; docs`.

## Post-plan (Plan 4, optional — ask the owner)
MCP server + API keys (design marks optional). Parked minors live in `docs/superpowers/ledgers/controller-ledgers.md` + persistent memory.

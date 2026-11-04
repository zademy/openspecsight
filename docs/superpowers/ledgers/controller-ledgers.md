# Plan 1 (Core) — Controller Ledger (durable record)

> Restored from the controller session after workspace deletion (2026-11-04). Branch `feat/core` merged to `main` (fast-forward to f0082cc, then 2509cbd fresh-clone fix). 12/12 tasks approved; final whole-branch review: Ready to merge after one fix wave.

## Identity
Controller: GLM-5.3 session. Implementers + reviewers: `zai-coding-plan/glm-5.3-flash#high` (claude-haiku reviewer unstable — invalid thinking-signature, 3 attempts; glm-5.3-highspeed not in subscription).

## Rulings (order taken)
1. Vitest config sets no `DATABASE_PATH`; tests set it per-test.
2. Global GitHub stub on fixed port 9876 + Playwright globalSetup + `GITHUB_API_BASE` in webServer env; unit tests spawn ephemeral stubs.
3. Scenario rows render `id="scenario-<id>"` anchors; deep links expand the group (later: watch `[hash, tab]` flush post).
4. Repo pre-initialized — implementers skipped `git init`.
5. Reviewer model switched to glm-5.3-flash#high (provider instability).
6. Nullability deviations on analyses/jobs/scenarioRevisions accepted.
7. Migrations-under-build resolved at Task 6 (nitro compiled hook + ancestor-walk resolver).
8. "No engines field" finding = false positive (verified).
9. Stale-job guard centralized in `processNextJobs` (ratified) + boot sweep (crash recovery) adjudicated load-bearing.
10. `PRAGMA foreign_keys` NOT toggled mid-plan; later probe proved better-sqlite3 13 defaults it ON (reviewer's OFF claim false). Plan-1 parked item re-scoped: real `ON DELETE CASCADE` migrations to REPLACE explicit deletes, not to "enable" FK.
11. Sync records an `analyses` row (type 'sync') for UI polling.
12. Ask-bar stub honest; later replaced in Plan 2.
13. `source` filter semantics: manual = any proposal or live manual row; ai = rest (zero-revision releases count as ai).
14. Apply/discard proposals implemented in Plan-1 final wave (design §6.3 promise) — apply keeps `source='manual'`.
15. LLM mock fixture resolution: `name with ':'→'.'` maps to `fixtures/llm/<name>.json`.
16. e2e runs the production build (dev-server POST-body race on the dev machine).
17. Typed-$fetch convention (explicit response types) — Nuxt 4.6 tsc bug workaround.
18. better-sqlite3 postinstall skipped (v13 ships prebuilds; fresh clones lack node-gyp).

## Parked minors at merge (input for Plan 3 / final polish)
Rate-limit login; spec empty-state copy precision; Changes filters in URL + debounce; overview timeline day cap; copy only `fixtures/llm` into `.output`; digest bytes UTF-16 comment; `committedAt` committer-first; `GithubError` code/subclass; `getBlob` encoding guard; blob reads stop at digest budget; poison-job drain slots; `startInitialAnalysis` not one transaction; session token strict two-segment + `//evil.com` guard + login 500 discrimination (FIXED in P1 final wave); project delete duplicate repo; `not.toContain('pat')` tripwire brittleness; cookie forwarding consistency; statusMessage ASCII; Transaction alias dedupe; conversations pin/rename (skipped by P2 ruling 6).

# Plan 2 (Visualization & AI) — Controller Ledger (durable record)

Branch `feat/visualization` from 60d2c40; HEAD 06efd0a. 9/9 tasks approved; final whole-branch review: **Ready to merge — Yes**; fix wave resolved (36f79eb, e4e1089, 06efd0a). Gates at HEAD: lint ✓ typecheck ✓ unit 240/240 e2e 21/21 (+repeat-each 2× on ask/full-flow).

## Rulings (order taken)
1. connections/flows are ai-only data (no manual variants) — wiped on re-analysis.
2. conversations pin/rename skipped (parked).
3. Edges are direction-collapsed (min/max pair, merged types) — rendered UNDIRECTED.
4. Extended refusal copy ratified (brief sentence stays as prefix).
5. No stopword strip in FTS (bm25 idf-clamp rationale, documented); OR-fallback added on zero AND rows.
6. Per-project ask fixtures (`ask-answer-<projectId>.json`) via `GenerateOpts.projectId` — ends the fullyParallel race; real mode ignores opts.
7. Map/spec agreement documented (relations re-derived per analysis; manual survivors may lack edges until re-analysis).
8. Maps writes atomic: LLM generation outside, one transaction for connections+flows.
9. auth.spec/login hydration: shared helper `tests/e2e/helpers/login.ts`, wait-before-fill; 8 specs migrated.

## Parked minors at merge (input for Plan 3 / final polish)
P2-T1: CRUD roundtrip partial; rowid=scenario.id comment; connections composite index; pinned 0|1 TS guard. P2-T2: stats pre-Plan2 indistinguishable; MapEdge per-type direction (reopen if arrows ever needed). P2-T3: canvas keyboard-focus/a11y pass; vue-flow CSS chunk flash; hover doesn't dim non-adjacent nodes; `h-[60vh]` landscape. P2-T4: `Number.isInteger` vs zod (consistent w/ siblings); corrupt graphJson → 500 swallowed; wheel-zoom over canvas; projects.spec exact-text race (alias-mitigated). P2-T6: real-LLM partial payload silent drops (prompt now demands full set — REOPEN FIRST when real-mode smoke begins, Plan 3 prerequisite); `idsByName` pre-tx staleness; two-affected-features last-writer-wins (self-heals). P2-T7: corpus-pinned operator-soup test; OR-pass precision tail (min-idf someday). P2-T8: failed-question resubmit no-op; touch-invisible conversation delete; `runAsk` nav-failure reset; follow-up loses typed question; ⌘K glyph on Ctrl platforms; GET conversations `200 []` on unknown project; citation tooltips doc drift. Final wave: `deleteProjectsByName` JSDoc lost in sweep (cosmetic).

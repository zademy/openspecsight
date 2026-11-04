import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { analyses, annotations, connections, features, flows, jobs, projects, releases, repositories, scenarioRevisions, scenarios } from '../../server/db/schema'
import { connectionTypes } from '../../shared/schemas'
import { runInitialAnalysis } from '../../server/services/analysis.service'
import { enqueueJob } from '../../server/services/jobs.service'
import { runSync, startSync, SyncInProgressError } from '../../server/services/sync.service'
import { fakeDeps, fakeGithub, fakeLlm, type FakeDepsOptions, type FakeGithub, type FakeLlm } from './helpers/analysis-fakes'

/**
 * Sync pipeline tests run against a :memory: database seeded by the real
 * initial-analysis pipeline (Task 8 fakes), then sync with a fake github that
 * reports new commits and a fake llm scripted with the Task 10 fixture — the
 * same file LLM_MOCK serves, so unit tests and e2e exercise identical data.
 */

const OLD_HEAD = {
  sha: 'head-sha-aaa',
  message: 'feat: seed the demo repo',
  authorName: 'Ada Lovelace',
  committedAt: '2026-11-01T10:00:00Z',
}

const NEW_HEAD = {
  sha: 'head-sha-bbb',
  message: 'feat: tighten sign-in checks',
  authorName: 'Grace Hopper',
  committedAt: '2026-11-02T09:30:00Z',
}

const COMPARE_FILES = [
  { filename: 'server/api/auth/login.post.ts', patch: '@@ -12,6 +12,14 @@\n+throttle()' },
  { filename: 'server/utils/session.ts', patch: '@@ -30,9 +30,11 @@\n-sliding()' },
]

let SYNC_UPDATE: unknown

beforeAll(async () => {
  const file = path.resolve(process.cwd(), 'fixtures', 'llm', 'sync-update.authentication.json')
  SYNC_UPDATE = JSON.parse(await readFile(file, 'utf8'))
})

/** Sync-shaped deps: the commit list starts at NEW_HEAD, compare returns the auth changes. */
function syncDeps(options: FakeDepsOptions = {}): { github: FakeGithub, llm: FakeLlm } {
  return fakeDeps({
    commits: [NEW_HEAD, OLD_HEAD],
    comparison: { commits: [OLD_HEAD, NEW_HEAD], files: COMPARE_FILES },
    responses: { 'sync-update:authentication': SYNC_UPDATE },
    ...options,
  })
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
})

/** Seeds a project whose spec was built by the initial pipeline (lastSyncedSha = OLD_HEAD). */
async function seedAnalyzedProject(): Promise<number> {
  const db = getDB()
  const project = db.insert(projects).values({
    name: 'Sync Fixture',
    description: 'Pins the sync pipeline',
    createdAt: '2026-11-03T00:00:00.000Z',
  }).returning().get()
  db.insert(repositories).values({
    projectId: project.id,
    owner: 'acme',
    repo: 'tasks',
    branch: 'main',
    patEncrypted: null,
    lastSyncedSha: null,
  }).run()
  const analysis = db.insert(analyses).values({
    projectId: project.id,
    type: 'initial',
    status: 'queued',
    progress: 0,
    step: 'queued',
    statsJson: '{}',
    error: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    finishedAt: null,
  }).returning().get()
  await runInitialAnalysis({ analysisId: analysis.id, projectId: project.id }, fakeDeps())
  return project.id
}

function featureByName(projectId: number, name: string) {
  return getDB().select().from(features)
    .where(eq(features.projectId, projectId))
    .all()
    .find((row) => row.name === name)
}

function authScenarioRows(projectId: number) {
  const auth = featureByName(projectId, 'Authentication')
  return getDB().select().from(scenarios)
    .where(eq(scenarios.featureId, auth!.id))
    .all()
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

function latestAnalysis(projectId: number) {
  return getDB().select().from(analyses)
    .where(eq(analyses.projectId, projectId))
    .orderBy(desc(analyses.id))
    .get()
}

/** Every stored connection of the project as sorted (from, to, type) name triples. */
function connectionTriples(projectId: number) {
  const names = new Map(
    getDB().select().from(features).where(eq(features.projectId, projectId)).all().map((row) => [row.id, row.name]),
  )
  return getDB().select().from(connections)
    .where(eq(connections.projectId, projectId))
    .all()
    .map((row) => ({ from: names.get(row.fromFeatureId), to: names.get(row.toFeatureId), type: row.type }))
    .sort((a, b) => `${a.from}|${a.to}|${a.type}`.localeCompare(`${b.from}|${b.to}|${b.type}`))
}

function untouchedConnectionRows(projectId: number, authId: number) {
  return getDB().select().from(connections)
    .where(eq(connections.projectId, projectId))
    .all()
    .filter((row) => row.fromFeatureId !== authId && row.toFeatureId !== authId)
}

describe('runSync', () => {
  test('(a) no new commits → releaseId null, zero llm calls, analyses row reports up-to-date', async () => {
    const projectId = await seedAnalyzedProject()
    const github = fakeGithub({ commits: [OLD_HEAD] })
    const llm = fakeLlm({})

    const result = await runSync({ projectId }, { github, llm })

    expect(result).toEqual({ releaseId: null })
    expect(llm.generateCalls).toEqual([])
    expect(github.compareCalls).toEqual([])
    expect(getDB().select().from(releases).all()).toHaveLength(0)
    const row = latestAnalysis(projectId)!
    expect(row).toMatchObject({ type: 'sync', status: 'done', step: 'up-to-date', progress: 100, error: null })
    expect(JSON.parse(row.statsJson)).toEqual({ features: 0, scenarios: 0, files: 0, connections: 0, connectionsSkipped: 0, flows: 0 })
  })

  test('(b) new auth commits update only Authentication: new/changed/fixed applied, gone deleted, codes correct', async () => {
    const projectId = await seedAnalyzedProject()
    const deps = syncDeps()

    const result = await runSync({ projectId }, deps)

    expect(result.releaseId).toBeGreaterThan(0)
    expect(deps.llm.generateCalls.map((call) => call.name)).toEqual(['sync-update:authentication'])

    const authRows = authScenarioRows(projectId)
    expect(authRows.map((row) => row.code)).toEqual(['HP-1', 'ER-1', 'ER-2', 'HP-2', 'ED-1', 'HP-3'])
    expect(authRows.find((row) => row.code === 'HP-1')?.outcome)
      .toBe('the user lands on the tasks page, the session cookie is set, and its expiry slides forward on each authenticated request')
    const fixed = authRows.find((row) => row.code === 'ED-1')!
    expect(fixed).toMatchObject({ category: 'error', outcome: 'the session is rejected server-side and the user is redirected to the login page' })
    expect(authRows.find((row) => row.code === 'HP-3')).toMatchObject({
      context: 'org admin signing in',
      action: 'sign in with a valid password when two-factor authentication is enforced for admins',
      category: 'happy',
      source: 'ai',
    })
    expect(authRows.some((row) => row.code === 'ER-3')).toBe(false)

    // Tasks is untouched by the auth-only diff.
    const tasksRows = getDB().select().from(scenarios)
      .where(eq(scenarios.featureId, featureByName(projectId, 'Tasks')!.id))
      .all()
    expect(tasksRows).toHaveLength(6)
    expect(tasksRows.every((row) => row.source === 'ai')).toBe(true)

    const revisionKinds = getDB().select().from(scenarioRevisions).all().map((row) => row.kind).sort()
    expect(revisionKinds).toEqual(['changed', 'fixed', 'gone', 'new'])
    for (const revision of getDB().select().from(scenarioRevisions).all()) {
      expect(revision).toMatchObject({ releaseId: result.releaseId, state: 'applied' })
    }

    const row = latestAnalysis(projectId)!
    expect(row).toMatchObject({ type: 'sync', status: 'done', step: 'done' })
    expect(JSON.parse(row.statsJson)).toEqual({ features: 1, scenarios: 4, files: 2, connections: 2, connectionsSkipped: 3, flows: 1 })
  })

  describe('map and flow refresh (Task 6)', () => {
    test('the sync payload refreshes the affected feature\'s flow graph and its connection set', async () => {
      const projectId = await seedAnalyzedProject()
      const auth = featureByName(projectId, 'Authentication')!

      await runSync({ projectId }, syncDeps())

      // Flow: the payload's redrawn graph replaced the analysis graph — the new error node is in.
      const flowRow = getDB().select().from(flows).where(eq(flows.featureId, auth.id)).get()
      const graph = JSON.parse(flowRow?.graphJson ?? '{}') as { nodes: Array<{ label: string }> }
      expect(graph.nodes.map((node) => node.label)).toContain('Account locked')

      // Connections: every stored row touching Authentication equals the payload's refreshed set
      // (shares_data and the no-longer-flagged depends_on are gone, notifies is new).
      expect(connectionTriples(projectId).filter((triple) => triple.from === 'Authentication' || triple.to === 'Authentication'))
        .toEqual([
          { from: 'Authentication', to: 'Tasks', type: 'authenticates' },
          { from: 'Authentication', to: 'Tasks', type: 'notifies' },
        ])
    })

    test('flows and connections of unaffected features stay byte-for-byte identical', async () => {
      const projectId = await seedAnalyzedProject()
      const auth = featureByName(projectId, 'Authentication')!
      const tasks = featureByName(projectId, 'Tasks')!
      const beforeAuthFlow = getDB().select().from(flows).where(eq(flows.featureId, auth.id)).get()
      const beforeTasksFlow = getDB().select().from(flows).where(eq(flows.featureId, tasks.id)).get()
      const beforeUntouched = untouchedConnectionRows(projectId, auth.id)
      // The Login → Task list edge must exist, or this test proves nothing.
      expect(beforeUntouched.length).toBeGreaterThan(0)

      await runSync({ projectId }, syncDeps())

      // Review Focus #3: only the affected feature's maps may move.
      expect(getDB().select().from(flows).where(eq(flows.featureId, tasks.id)).get()).toEqual(beforeTasksFlow)
      expect(untouchedConnectionRows(projectId, auth.id)).toEqual(beforeUntouched)
      // Authentication's flow actually moved, so the untouched row can't have been swapped either.
      expect(getDB().select().from(flows).where(eq(flows.featureId, auth.id)).get()?.graphJson)
        .not.toBe(beforeAuthFlow?.graphJson)
      expect(getDB().select().from(flows).all()).toHaveLength(2)
    })

    test('a payload without connections/flow (the old fixture shape) writes nothing to the maps', async () => {
      const projectId = await seedAnalyzedProject()
      const legacy = JSON.parse(JSON.stringify(SYNC_UPDATE))
      delete legacy.featureUpdates[0].connections
      delete legacy.featureUpdates[0].flow
      const beforeFlows = getDB().select().from(flows).all()
      const beforeConnections = getDB().select().from(connections).all()

      await runSync({ projectId }, syncDeps({ responses: { 'sync-update:authentication': legacy } }))

      expect(getDB().select().from(flows).all()).toEqual(beforeFlows)
      expect(getDB().select().from(connections).all()).toEqual(beforeConnections)
      expect(JSON.parse(latestAnalysis(projectId)!.statsJson)).toEqual({
        features: 1,
        scenarios: 4,
        files: 2,
        connections: 0,
        connectionsSkipped: 0,
        flows: 0,
      })
    })

    test('the payload\'s self-links, unknown names and duplicates are skipped and counted', async () => {
      const projectId = await seedAnalyzedProject()

      await runSync({ projectId }, syncDeps())

      expect(JSON.parse(latestAnalysis(projectId)!.statsJson)).toMatchObject({ connections: 2, connectionsSkipped: 3, flows: 1 })
      const triples = connectionTriples(projectId)
      expect(triples.some((triple) => triple.from === 'Authentication' && triple.to === 'Authentication')).toBe(false)
      expect(triples.some((triple) => triple.from === 'Notifications' || triple.to === 'Notifications')).toBe(false)
    })

    test('the sync prompt asks for refreshed connections and the updated flow (real-mode grounding)', async () => {
      const projectId = await seedAnalyzedProject()
      const deps = syncDeps()

      await runSync({ projectId }, deps)

      const prompt = deps.llm.generateCalls[0]!.prompt
      expect(prompt).toContain('connections')
      expect(prompt).toContain('flow')
      for (const type of connectionTypes) {
        expect(prompt, `connection type ${type} must be named in the sync prompt`).toContain(type)
      }
    })
  })

  test('(c) a manual scenario matched by a changed entry stays byte-for-byte and gets a proposed revision', async () => {
    const projectId = await seedAnalyzedProject()
    const hp1 = authScenarioRows(projectId).find((row) => row.code === 'HP-1')!
    getDB().update(scenarios).set({ source: 'manual' }).where(eq(scenarios.id, hp1.id)).run()
    const before = getDB().select().from(scenarios).where(eq(scenarios.id, hp1.id)).get()

    const result = await runSync({ projectId }, syncDeps())

    const after = getDB().select().from(scenarios).where(eq(scenarios.id, hp1.id)).get()
    expect(after).toEqual(before)
    expect(after?.source).toBe('manual')

    const revision = getDB().select().from(scenarioRevisions)
      .where(eq(scenarioRevisions.scenarioId, hp1.id))
      .get()
    expect(revision).toMatchObject({ releaseId: result.releaseId, kind: 'changed', state: 'proposed' })
    expect(JSON.parse(revision?.beforeJson ?? 'null')).toMatchObject({ code: 'HP-1', outcome: before?.outcome })
    expect(JSON.parse(revision?.afterJson ?? 'null')).toMatchObject({
      outcome: 'the user lands on the tasks page, the session cookie is set, and its expiry slides forward on each authenticated request',
    })
  })

  test('(d) gone deletes the ai scenario with its annotations and records the revision', async () => {
    const projectId = await seedAnalyzedProject()
    const er3 = authScenarioRows(projectId).find((row) => row.code === 'ER-3')!
    getDB().insert(annotations).values({ scenarioId: er3.id, body: 'reviewed', author: 'operator', createdAt: '2026-11-03T00:00:00.000Z' }).run()

    const result = await runSync({ projectId }, syncDeps())

    expect(getDB().select().from(scenarios).where(eq(scenarios.id, er3.id)).get()).toBeUndefined()
    expect(getDB().select().from(annotations).where(eq(annotations.scenarioId, er3.id)).all()).toHaveLength(0)
    const revision = getDB().select().from(scenarioRevisions)
      .where(eq(scenarioRevisions.kind, 'gone'))
      .get()
    expect(revision).toMatchObject({ releaseId: result.releaseId, state: 'applied' })
    expect(JSON.parse(revision?.beforeJson ?? 'null')).toMatchObject({ code: 'ER-3' })
  })

  test('gone against a manual scenario only proposes the removal', async () => {
    const projectId = await seedAnalyzedProject()
    const er3 = authScenarioRows(projectId).find((row) => row.code === 'ER-3')!
    getDB().update(scenarios).set({ source: 'manual' }).where(eq(scenarios.id, er3.id)).run()

    await runSync({ projectId }, syncDeps())

    const after = getDB().select().from(scenarios).where(eq(scenarios.id, er3.id)).get()
    expect(after).toMatchObject({ code: 'ER-3', source: 'manual' })
    const revision = getDB().select().from(scenarioRevisions)
      .where(eq(scenarioRevisions.scenarioId, er3.id))
      .get()
    expect(revision).toMatchObject({ kind: 'gone', state: 'proposed' })
  })

  test('(e) records one release row with llm title/category, compare authors and the head commit', async () => {
    const projectId = await seedAnalyzedProject()

    const result = await runSync({ projectId }, syncDeps())

    const rows = getDB().select().from(releases).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: result.releaseId,
      projectId,
      sha: 'head-sha-bbb',
      title: 'Tighter sign-in checks',
      category: 'security',
      highlight: 1,
      summary: 'Sign-in now asks org admins for a second factor before any session is granted, session cookies slide their expiry on activity, and the legacy token endpoint is gone.',
      authorsJson: JSON.stringify(['Ada Lovelace', 'Grace Hopper']),
      message: 'feat: tighten sign-in checks',
      committedAt: '2026-11-02T09:30:00Z',
    })
  })

  test('(f) advances repositories.lastSyncedSha to the synced head', async () => {
    const projectId = await seedAnalyzedProject()

    await runSync({ projectId }, syncDeps())

    const repo = getDB().select().from(repositories).where(eq(repositories.projectId, projectId)).get()
    expect(repo?.lastSyncedSha).toBe('head-sha-bbb')
  })

  test('(g) a second sync at the same head is a no-op: null release, no new llm call, no new release', async () => {
    const projectId = await seedAnalyzedProject()
    const deps = syncDeps()

    const first = await runSync({ projectId }, deps)
    const callsAfterFirst = deps.llm.generateCalls.length
    const second = await runSync({ projectId }, deps)

    expect(first.releaseId).toBeGreaterThan(0)
    expect(second).toEqual({ releaseId: null })
    expect(deps.llm.generateCalls).toHaveLength(callsAfterFirst)
    expect(getDB().select().from(releases).all()).toHaveLength(1)
  })

  test('first-ever sync (lastSyncedSha null) compares from the earliest available commit', async () => {
    const projectId = await seedAnalyzedProject()
    getDB().update(repositories).set({ lastSyncedSha: null }).where(eq(repositories.projectId, projectId)).run()
    const deps = syncDeps()

    const result = await runSync({ projectId }, deps)

    expect(result.releaseId).toBeGreaterThan(0)
    expect(deps.github.compareCalls).toEqual([{ base: 'head-sha-aaa', head: 'head-sha-bbb' }])
  })

  test('a diff that touches no known feature still records a release and advances the sha', async () => {
    const projectId = await seedAnalyzedProject()
    const deps = syncDeps({ comparison: { commits: [OLD_HEAD, NEW_HEAD], files: [{ filename: 'README.md', patch: '@@ -1 +1,2 @@\n+note' }] } })

    const result = await runSync({ projectId }, deps)

    expect(result.releaseId).toBeGreaterThan(0)
    expect(deps.llm.generateCalls).toEqual([])
    const release = getDB().select().from(releases).where(eq(releases.id, result.releaseId!)).get()
    expect(release).toMatchObject({
      sha: 'head-sha-bbb',
      title: 'feat: tighten sign-in checks',
      category: 'maintenance',
      highlight: 0,
      message: 'feat: tighten sign-in checks',
    })
    expect(getDB().select().from(scenarioRevisions).all()).toHaveLength(0)
    expect(latestAnalysis(projectId)).toMatchObject({ type: 'sync', status: 'done', step: 'done' })
  })

  test('changed entries whose matchCode is unknown are skipped without failing the sync', async () => {
    const projectId = await seedAnalyzedProject()
    const broken = JSON.parse(JSON.stringify(SYNC_UPDATE)) as { featureUpdates: Array<{ scenarios: Array<Record<string, unknown>> }> }
    broken.featureUpdates[0]!.scenarios.splice(1, 1) // drop the HP-1 changed entry, keep the rest
    broken.featureUpdates[0]!.scenarios.push({ kind: 'changed', matchCode: 'ZZ-99', context: 'ghost', action: 'ghost action', outcome: 'ghost outcome', category: 'edge' })

    const result = await runSync({ projectId }, syncDeps({ responses: { 'sync-update:authentication': broken } }))

    expect(result.releaseId).toBeGreaterThan(0)
    expect(authScenarioRows(projectId).map((row) => row.code)).toEqual(['HP-1', 'ER-1', 'ER-2', 'HP-2', 'ED-1', 'HP-3'])
    expect(latestAnalysis(projectId)).toMatchObject({ status: 'done', error: null })
  })
})

describe('startSync', () => {
  test('(h) refuses while a sync job is queued or running for the project', async () => {
    const projectId = await seedAnalyzedProject()
    const jobId = enqueueJob('sync', { projectId })

    expect(() => startSync(projectId)).toThrow(SyncInProgressError)
    getDB().update(jobs).set({ status: 'running' }).where(eq(jobs.id, jobId)).run()
    expect(() => startSync(projectId)).toThrow(SyncInProgressError)

    getDB().update(jobs).set({ status: 'done' }).where(eq(jobs.id, jobId)).run()
    const started = startSync(projectId)
    expect(started).toBeGreaterThan(0)
  })

  test('a failed sync is startable again — the errored sync analyses row does not block', async () => {
    const projectId = await seedAnalyzedProject()
    const firstJobId = startSync(projectId)!
    // The queue parked the job and the pipeline errored its analyses row.
    getDB().update(jobs).set({ status: 'error', finishedAt: '2026-11-03T00:02:00.000Z' }).where(eq(jobs.id, firstJobId)).run()
    getDB().update(analyses).set({ status: 'error', error: 'provider exploded', finishedAt: '2026-11-03T00:02:00.000Z' })
      .where(and(eq(analyses.projectId, projectId), eq(analyses.type, 'sync'))).run()
    expect(latestAnalysis(projectId)).toMatchObject({ type: 'sync', status: 'error' })

    // Retry: diff data is intact, lastSyncedSha untouched, sync is transactional.
    const secondJobId = startSync(projectId)

    expect(secondJobId).toBeGreaterThan(0)
    expect(latestAnalysis(projectId)).toMatchObject({ type: 'sync', status: 'queued', step: 'queued' })
  })

  test('a queued sync job from another project does not block', async () => {
    const projectId = await seedAnalyzedProject()
    const other = getDB().insert(projects).values({
      name: 'Other Project',
      description: 'Different project',
      createdAt: '2026-11-03T00:00:00.000Z',
    }).returning().get()
    enqueueJob('sync', { projectId: other.id })

    expect(startSync(projectId)).toBeGreaterThan(0)
  })

  test('unknown project → null', () => {
    expect(startSync(9999)).toBeNull()
  })

  test('starting a sync creates the queued sync analyses row and enqueues the job', async () => {
    const projectId = await seedAnalyzedProject()

    const jobId = startSync(projectId)!

    const job = getDB().select().from(jobs).where(eq(jobs.id, jobId)).get()
    expect(job).toMatchObject({ type: 'sync', status: 'queued', payloadJson: JSON.stringify({ projectId }) })
    expect(latestAnalysis(projectId)).toMatchObject({ type: 'sync', status: 'queued', step: 'queued' })
  })
})

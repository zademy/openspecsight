import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import {
  digests,
  features,
  jobs,
  projects,
  releases,
  repositories,
  scenarioRevisions,
} from '../../server/db/schema'
import type { ContentBlocks } from '../../shared/types'
import {
  aggregateDigest,
  defaultDigestRange,
  deliverDigest,
  DigestInProgressError,
  DigestRangeEmptyError,
  generateDigest,
  getDigest,
  listDigests,
  projectsWithReleasesInRange,
  runDigest,
  runWeeklyDigests,
  startDigest,
} from '../../server/services/digests.service'
import type { LlmClient } from '../../server/services/llm.service'

/**
 * Digest tests run against a :memory: database seeded with the rows a sync
 * pipeline leaves behind (releases with scenario revisions). The LLM stays
 * out of the picture except where stated: the fixture test lets
 * generateDigest build its default client under LLM_MOCK=true, so the real
 * `fixtures/llm/digest-draft.json` must parse against DigestDraftSchema for
 * the test to pass; everything else scripts a fake.
 */

let projectId: number
let emptyProjectId: number
let repositoryId: number
let authId: number
let tasksId: number

/** Scripts one draft for every generate call; asserts nothing about prompts. */
function scriptedLlm(draft: { title: string, blocks: ContentBlocks }): LlmClient {
  return {
    async generate(_name, schema) {
      return schema.parse(draft) as never
    },
  }
}

function seedRelease(over: { title: string, committedAt: string, category?: string, projectId?: number }): number {
  return getDB().insert(releases).values({
    projectId: over.projectId ?? projectId,
    repositoryId,
    sha: `sha-${Math.random().toString(36).slice(2, 10)}`,
    title: over.title,
    category: over.category ?? 'feat',
    highlight: 0,
    summary: `${over.title} summary`,
    authorsJson: JSON.stringify(['Ada Lovelace']),
    message: over.title,
    committedAt: over.committedAt,
  }).run().lastInsertRowid as number
}

function seedRevision(releaseId: number, featureId: number, kind: 'new' | 'changed' | 'gone' | 'fixed'): void {
  getDB().insert(scenarioRevisions).values({
    releaseId,
    scenarioId: null,
    featureId,
    kind,
    state: 'applied',
    beforeJson: null,
    afterJson: null,
  }).run()
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Digest Fixture',
    description: 'Exercises the digest pipeline',
    createdAt: '2026-11-04T00:00:00Z',
  }).run().lastInsertRowid as number
  emptyProjectId = db.insert(projects).values({
    name: 'Quiet Fixture',
    description: 'Has releases outside every tested range',
    createdAt: '2026-11-04T00:00:00Z',
  }).run().lastInsertRowid as number
  repositoryId = db.insert(repositories).values({
    projectId,
    owner: 'acme',
    repo: 'tasks',
    branch: 'main',
    patEncrypted: null,
    lastSyncedSha: null,
  }).run().lastInsertRowid as number
  authId = db.insert(features).values({
    projectId,
    name: 'Authentication',
    description: 'Email and password login.',
    sortOrder: 0,
    source: 'ai',
  }).run().lastInsertRowid as number
  tasksId = db.insert(features).values({
    projectId,
    name: 'Tasks',
    description: 'Task lists and their items.',
    sortOrder: 1,
    source: 'ai',
  }).run().lastInsertRowid as number
})

afterAll(() => {
  delete process.env.LLM_MOCK
})

describe('digest defaults', () => {
  test('the default range is the last seven days, as UTC dates', () => {
    expect(defaultDigestRange(new Date('2026-11-04T15:30:00Z'))).toEqual({
      rangeFrom: '2026-10-28',
      rangeTo: '2026-11-04',
    })
  })
})

describe('aggregation', () => {
  test('counts releases whose committedAt date falls inside the range, boundaries inclusive', () => {
    seedRelease({ title: 'First of the range', committedAt: '2026-10-28T09:15:00Z' })
    seedRelease({ title: 'Last of the range', committedAt: '2026-11-04T18:40:00Z' })
    seedRelease({ title: 'Day before', committedAt: '2026-10-27T23:59:00Z' })
    seedRelease({ title: 'Day after', committedAt: '2026-11-05T00:00:00Z' })

    const agg = aggregateDigest(projectId, '2026-10-28', '2026-11-04')
    expect(agg.releaseCount).toBe(2)
    expect(agg.releases.map((release) => release.title)).toEqual(['First of the range', 'Last of the range'])
  })

  test('counts revision kinds and groups release titles by feature', () => {
    const inRange = seedRelease({ title: 'Tighter sign-in checks', committedAt: '2026-11-02T09:30:00Z' })
    seedRevision(inRange, authId, 'new')
    seedRevision(inRange, authId, 'changed')
    const other = seedRelease({ title: 'Add tasks module', committedAt: '2026-11-03T10:00:00Z' })
    seedRevision(other, tasksId, 'new')
    seedRevision(other, tasksId, 'gone')
    seedRelease({ title: 'Out of range work', committedAt: '2026-10-01T10:00:00Z' })

    const agg = aggregateDigest(projectId, '2026-10-28', '2026-11-04')
    expect(agg.kinds).toEqual({ new: 2, changed: 1, gone: 1, fixed: 0 })
    expect(agg.features).toEqual([
      { name: 'Authentication', titles: ['Tighter sign-in checks'] },
      { name: 'Tasks', titles: ['Add tasks module'] },
    ])
  })

  test('a range without releases throws DigestRangeEmptyError', () => {
    seedRelease({ title: 'Old work', committedAt: '2026-10-01T10:00:00Z' })
    expect(() => aggregateDigest(projectId, '2026-10-28', '2026-11-04')).toThrow(DigestRangeEmptyError)
    try {
      aggregateDigest(projectId, '2026-10-28', '2026-11-04')
    } catch (error) {
      expect((error as Error).message).toBe('No releases in that range; nothing to digest')
    }
  })
})

describe('generateDigest', () => {
  test('stores the digest-draft fixture verbatim with emailedAt null (mock mode)', async () => {
    process.env.LLM_MOCK = 'true'
    seedRelease({ title: 'Tighter sign-in checks', committedAt: '2026-11-02T09:30:00Z' })

    const digestId = await generateDigest(projectId, '2026-10-28', '2026-11-04')
    const fixture = JSON.parse(await readFile(path.resolve(process.cwd(), 'fixtures', 'llm', 'digest-draft.json'), 'utf8')) as { title: string, blocks: ContentBlocks }

    const row = getDB().select().from(digests).where(eq(digests.id, digestId)).get()
    expect(row).toBeTruthy()
    expect(row!.title).toBe(fixture.title)
    expect(JSON.parse(row!.blocksJson)).toEqual(fixture.blocks)
    expect(row!.emailedAt).toBeNull()
    expect(row!.rangeFrom).toBe('2026-10-28')
    expect(row!.rangeTo).toBe('2026-11-04')
  })

  test('returns the stored digest id through runDigest, the job handler entry', async () => {
    seedRelease({ title: 'Add tasks module', committedAt: '2026-11-03T10:00:00Z' })
    const digestId = await runDigest(
      { projectId, rangeFrom: '2026-10-28', rangeTo: '2026-11-04' },
      { llm: scriptedLlm({ title: 'Week in review', blocks: [{ type: 'heading', text: 'What changed' }] }) },
    )
    expect(getDigest(digestId)?.title).toBe('Week in review')
  })
})

describe('startDigest', () => {
  test('answers null for an unknown project', () => {
    expect(startDigest(99999)).toBeNull()
  })

  test('enqueues a digest job and falls back to the default range', () => {
    seedRelease({ title: 'Tighter sign-in checks', committedAt: '2026-11-02T09:30:00Z' })

    const jobId = startDigest(projectId)
    expect(jobId).not.toBeNull()
    const row = getDB().select().from(jobs).where(eq(jobs.id, jobId!)).get()
    const payload = JSON.parse(row!.payloadJson) as { projectId: number, rangeFrom: string, rangeTo: string }
    expect(payload.projectId).toBe(projectId)
    expect(payload).toEqual({ projectId, ...defaultDigestRange(new Date()) })
  })

  test('rejects a second digest while one is queued, and allows it again once done', () => {
    seedRelease({ title: 'Tighter sign-in checks', committedAt: '2026-11-02T09:30:00Z' })
    startDigest(projectId, '2026-10-28', '2026-11-04')

    expect(() => startDigest(projectId, '2026-10-28', '2026-11-04')).toThrow(DigestInProgressError)

    getDB().update(jobs).set({ status: 'done' }).where(eq(jobs.type, 'digest')).run()
    expect(startDigest(projectId, '2026-10-28', '2026-11-04')).not.toBeNull()
  })

  test('a range without releases throws DigestRangeEmptyError before any job is enqueued', () => {
    const jobsBefore = getDB().select().from(jobs).where(eq(jobs.type, 'digest')).all().length
    expect(() => startDigest(emptyProjectId, '2026-10-28', '2026-11-04')).toThrow(DigestRangeEmptyError)
    expect(getDB().select().from(jobs).where(eq(jobs.type, 'digest')).all().length).toBe(jobsBefore)
  })
})

describe('list and detail', () => {
  test('listDigests is project-scoped and newest first', async () => {
    const llm = scriptedLlm({ title: 'A digest', blocks: [{ type: 'paragraph', text: 'One release shipped.' }] })
    seedRelease({ title: 'First release', committedAt: '2026-11-02T09:30:00Z' })
    seedRelease({ title: 'Second release', committedAt: '2026-11-03T09:30:00Z' })

    await generateDigest(projectId, '2026-10-28', '2026-11-04', { llm })
    await generateDigest(projectId, '2026-10-28', '2026-11-04', { llm })
    // A second project's digest must never leak into the first project's list.
    seedRelease({ title: 'Only release', committedAt: '2026-11-02T09:30:00Z', projectId: emptyProjectId })
    await generateDigest(emptyProjectId, '2026-10-28', '2026-11-04', { llm })

    const rows = listDigests(projectId)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.title).toBe('A digest')
    expect(rows[0]!.emailedAt).toBeNull()
    expect(rows[0]!.rangeFrom).toBe('2026-10-28')
    expect(Number(rows[0]!.id)).toBeGreaterThan(Number(rows[1]!.id))
  })

  test('getDigest parses the stored blocks; unknown ids answer null', async () => {
    const llm = scriptedLlm({
      title: 'A digest',
      blocks: [
        { type: 'heading', text: 'What changed' },
        { type: 'list', items: ['Tighter sign-in checks'] },
      ],
    })
    seedRelease({ title: 'First release', committedAt: '2026-11-02T09:30:00Z' })
    const digestId = await generateDigest(projectId, '2026-10-28', '2026-11-04', { llm })

    const detail = getDigest(digestId)
    expect(detail?.projectId).toBe(projectId)
    expect(detail?.blocks).toEqual([
      { type: 'heading', text: 'What changed' },
      { type: 'list', items: ['Tighter sign-in checks'] },
    ])
    expect(getDigest(424242)).toBeNull()
  })
})

describe('weekly digests', () => {
  test('projectsWithReleasesInRange lists only projects with in-range releases', () => {
    seedRelease({ title: 'In range', committedAt: '2026-11-02T09:30:00Z' })
    seedRelease({ title: 'Only old work', committedAt: '2026-10-01T10:00:00Z', projectId: emptyProjectId })

    expect(projectsWithReleasesInRange('2026-10-28', '2026-11-04')).toEqual([projectId])
  })

  test('runWeeklyDigests no-ops when disabled', async () => {
    seedRelease({ title: 'In range', committedAt: '2026-11-02T09:30:00Z' })

    const run = await runWeeklyDigests({ enabled: false, llm: scriptedLlm({ title: 'X', blocks: [{ type: 'paragraph', text: 'x' }] }) })
    expect(run.enabled).toBe(false)
    expect(run.outcomes).toHaveLength(0)
    expect(listDigests(projectId)).toHaveLength(0)
  })

  test('runWeeklyDigests generates one digest per active project and reports the delivery stub', async () => {
    seedRelease({ title: 'In range', committedAt: '2026-11-02T09:30:00Z' })
    seedRelease({ title: 'Only old work', committedAt: '2026-10-01T10:00:00Z', projectId: emptyProjectId })
    const llm = scriptedLlm({ title: 'Weekly digest', blocks: [{ type: 'paragraph', text: 'One release shipped.' }] })

    const run = await runWeeklyDigests({ enabled: true, llm })
    expect(run.enabled).toBe(true)
    expect(run.rangeFrom).toBe('2026-10-28')
    expect(run.outcomes).toHaveLength(1)
    expect(run.outcomes[0]!.projectId).toBe(projectId)
    expect(run.outcomes[0]!.sent).toBe(false)
    expect(run.outcomes[0]!.reason).toBe('delivery lands in task 4')
    expect(listDigests(projectId)).toHaveLength(1)
    expect(listDigests(emptyProjectId)).toHaveLength(0)
  })

  test('a project that fails mid-run does not stop the others', async () => {
    seedRelease({ title: 'In range', committedAt: '2026-11-02T09:30:00Z' })
    const otherProject = getDB().insert(projects).values({
      name: 'Third Fixture',
      description: 'Releases in range but a broken llm run',
      createdAt: '2026-11-04T00:00:00Z',
    }).run().lastInsertRowid as number
    const otherRepository = getDB().insert(repositories).values({
      projectId: otherProject,
      owner: 'acme',
      repo: 'other',
      branch: 'main',
      patEncrypted: null,
      lastSyncedSha: null,
    }).run().lastInsertRowid as number
    getDB().insert(releases).values({
      projectId: otherProject,
      repositoryId: otherRepository,
      sha: 'sha-third',
      title: 'Third project release',
      category: 'feat',
      highlight: 0,
      summary: 'summary',
      authorsJson: '[]',
      message: 'message',
      committedAt: '2026-11-02T09:30:00Z',
    }).run()

    let calls = 0
    const flakyLlm: LlmClient = {
      async generate(_name, schema) {
        calls += 1
        if (calls === 1) {
          throw new Error('provider down')
        }
        return schema.parse({ title: 'Weekly digest', blocks: [{ type: 'paragraph', text: 'Shipped.' }] }) as never
      },
    }

    const run = await runWeeklyDigests({ enabled: true, llm: flakyLlm })
    expect(run.outcomes).toHaveLength(2)
    expect(run.outcomes.some((outcome) => outcome.error === 'provider down')).toBe(true)
    // Projects process in ascending id order, so the first (projectId) hit the
    // broken first call and the third project still got its digest.
    expect(listDigests(projectId)).toHaveLength(0)
    expect(listDigests(otherProject)).toHaveLength(1)
  })
})

describe('deliverDigest stub', () => {
  test('reports that delivery is not wired yet and sends nothing', async () => {
    const result = await deliverDigest(1)
    expect(result).toEqual({ sent: false, reason: 'delivery lands in task 4' })
  })
})

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { analyses, jobs, projects } from '../../server/db/schema'
import {
  AnalysisInProgressError,
  getLatestAnalysis,
  startInitialAnalysis,
} from '../../server/services/analyses.service'
import { enqueueJob, kickJobProcessing, processNextJobs, registerJobHandler } from '../../server/services/jobs.service'

/**
 * Jobs queue tests run against a :memory: database with no plugin registered,
 * so the handler registry only holds what each test puts into it (each test
 * uses its own job type to stay isolated from the others).
 */
beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
})

function insertProject(name: string): number {
  const db = getDB()
  const project = db.insert(projects).values({
    name,
    description: `${name} project`,
    createdAt: '2026-11-03T00:00:00.000Z',
  }).returning().get()
  return project.id
}

function getJob(id: number) {
  return getDB().select().from(jobs).where(eq(jobs.id, id)).get()
}

describe('enqueueJob', () => {
  test('stores a queued row with the serialized payload and returns its id', () => {
    const jobId = enqueueJob('t-echo', { analysisId: 7, projectId: 1 })

    expect(getJob(jobId)).toMatchObject({
      id: jobId,
      type: 't-echo',
      payloadJson: JSON.stringify({ analysisId: 7, projectId: 1 }),
      status: 'queued',
      attempts: 0,
      error: null,
      finishedAt: null,
    })
  })
})

describe('processNextJobs', () => {
  test('claims the oldest queued job and runs its handler once with the parsed payload', async () => {
    const seen: Array<Record<string, unknown>> = []
    registerJobHandler('t-echo', async (payload) => {
      seen.push(payload)
    })
    const projectId = insertProject('Echo Target')
    const jobId = enqueueJob('t-echo', { analysisId: 7, projectId })

    const processed = await processNextJobs(5)

    expect(processed).toBe(1)
    expect(seen).toEqual([{ analysisId: 7, projectId }])
    expect(getJob(jobId)).toMatchObject({ status: 'done', attempts: 0, error: null })
    expect(getJob(jobId)?.finishedAt).toBeTypeOf('string')
  })

  test('claims nothing once the queue is empty', async () => {
    registerJobHandler('t-empty', async () => {})

    expect(await processNextJobs(5)).toBe(0)
  })

  test('a handler that keeps throwing retries until 3 attempts, then parks as error with the message', async () => {
    let calls = 0
    registerJobHandler('t-flaky', async () => {
      calls += 1
      throw new Error('boom')
    })
    const jobId = enqueueJob('t-flaky', {})

    const processed = await processNextJobs(5)

    expect(calls).toBe(3)
    expect(processed).toBe(3)
    const job = getJob(jobId)
    expect(job).toMatchObject({ status: 'error', attempts: 3, error: 'boom' })
    expect(job?.finishedAt).toBeTypeOf('string')
  })

  test('a first failure requeues the job with the stored error instead of parking it', async () => {
    let calls = 0
    registerJobHandler('t-once', async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('transient')
      }
    })
    const jobId = enqueueJob('t-once', {})

    const processed = await processNextJobs(5)

    expect(processed).toBe(2)
    expect(calls).toBe(2)
    // attempts counts failures only: one transient failure, then success.
    expect(getJob(jobId)).toMatchObject({ status: 'done', attempts: 1, error: null })
  })

  test('a job type without a registered handler parks as error instead of stalling the queue', async () => {
    const jobId = enqueueJob('t-no-handler', {})

    await processNextJobs(5)

    const job = getJob(jobId)
    expect(job?.status).toBe('error')
    expect(job?.error).toBe('No job handler registered for "t-no-handler"')
  })

  test('claims a running row never twice: processing triggered inside a handler cannot re-claim it', async () => {
    const handled: number[] = []
    let nestedRun = false
    registerJobHandler('t-nested', async (payload) => {
      handled.push(Number(payload.index))
      if (!nestedRun) {
        // Simulate a concurrent worker: while this job is claimed (status
        // running), a second processNextJobs may only pick up OTHER rows.
        nestedRun = true
        await processNextJobs(5)
      }
    })
    enqueueJob('t-nested', { index: 1 })
    enqueueJob('t-nested', { index: 2 })

    await processNextJobs(5)

    expect([...handled].sort((a, b) => a - b)).toEqual([1, 2])
    expect(new Set(handled).size).toBe(handled.length)
    for (const job of getDB().select().from(jobs).all()) {
      expect(job).toMatchObject({ status: 'done', attempts: 0 })
    }
  })

  test('a job whose payload projectId no longer exists is marked done with a note and skips the handler', async () => {
    registerJobHandler('t-orphan', async () => {
      throw new Error('handler must not run for a deleted project')
    })
    const jobId = enqueueJob('t-orphan', { projectId: 4242 })

    const processed = await processNextJobs(5)

    expect(processed).toBe(1)
    const job = getJob(jobId)
    expect(job).toMatchObject({ status: 'done', error: 'project deleted' })
    expect(job?.finishedAt).toBeTypeOf('string')
  })

  test('a job without a projectId in its payload runs its handler normally', async () => {
    const seen: Array<Record<string, unknown>> = []
    registerJobHandler('t-free', async (payload) => {
      seen.push(payload)
    })
    const jobId = enqueueJob('t-free', { anything: true })

    await processNextJobs(5)

    expect(seen).toEqual([{ anything: true }])
    expect(getJob(jobId)).toMatchObject({ status: 'done' })
  })
})

describe('startInitialAnalysis', () => {
  test('creates a queued initial analysis row and enqueues its job with both ids', () => {
    const projectId = insertProject('Queue Me')

    const analysisId = startInitialAnalysis(projectId)

    expect(analysisId).toBeTypeOf('number')
    expect(getDB().select().from(analyses).where(eq(analyses.id, analysisId!)).get()).toMatchObject({
      projectId,
      type: 'initial',
      status: 'queued',
      progress: 0,
      finishedAt: null,
    })
    const job = getDB().select().from(jobs).all().at(0)
    expect(job).toMatchObject({
      type: 'initial-analysis',
      status: 'queued',
      payloadJson: JSON.stringify({ analysisId, projectId }),
    })
  })

  test('rejects a second analysis while the first is queued or running', () => {
    const projectId = insertProject('Single Flight')
    startInitialAnalysis(projectId)

    expect(() => startInitialAnalysis(projectId)).toThrow(AnalysisInProgressError)
  })

  test('rejects a second analysis while the first is running', () => {
    const projectId = insertProject('Single Flight Running')
    startInitialAnalysis(projectId)
    const db = getDB()
    db.update(analyses).set({ status: 'running', progress: 10 }).where(eq(analyses.projectId, projectId)).run()

    expect(() => startInitialAnalysis(projectId)).toThrow(AnalysisInProgressError)
  })

  test('allows a new analysis once the previous one is done', () => {
    const projectId = insertProject('After Done')
    const first = startInitialAnalysis(projectId)!
    const db = getDB()
    db.update(analyses).set({ status: 'done', progress: 100 }).where(eq(analyses.id, first)).run()

    const second = startInitialAnalysis(projectId)

    expect(second).toBeTypeOf('number')
    expect(second).not.toBe(first)
  })

  test('returns null for an unknown project', () => {
    expect(startInitialAnalysis(9999)).toBeNull()
  })
})

describe('getLatestAnalysis', () => {
  test('returns status, progress, step and error of the newest analysis', () => {
    const projectId = insertProject('Latest Wins')
    const db = getDB()
    db.insert(analyses).values({
      projectId, type: 'initial', status: 'error', progress: 40, step: 'scanning', statsJson: '{}',
      error: 'older failure', createdAt: '2026-11-03T00:00:00.000Z', finishedAt: '2026-11-03T00:01:00.000Z',
    }).run()
    const newest = db.insert(analyses).values({
      projectId, type: 'initial', status: 'running', progress: 55, step: 'generating', statsJson: '{}',
      error: null, createdAt: '2026-11-03T00:02:00.000Z', finishedAt: null,
    }).returning().get()

    expect(getLatestAnalysis(projectId)).toEqual({
      status: 'running',
      progress: 55,
      step: 'generating',
      error: null,
    })
    expect(newest.id).toBeTypeOf('number')
  })

  test('returns null when the project has no analyses', () => {
    const projectId = insertProject('No Analyses')

    expect(getLatestAnalysis(projectId)).toBeNull()
  })
})

describe('kickJobProcessing', () => {
  test('runs the jobs:run task once, in-process, with an empty payload', () => {
    const runs: Array<{ name: string, payload: Record<string, unknown> }> = []
    const result = kickJobProcessing(async (name, options) => {
      runs.push({ name, payload: options?.payload ?? {} })
    })

    expect(result).toBeUndefined()
    expect(runs).toEqual([{ name: 'jobs:run', payload: {} }])
  })

  test('swallows a rejected runner so the rejection never surfaces', async () => {
    kickJobProcessing(async () => {
      throw new Error('task runner exploded')
    })

    // The kick handles the rejection internally; flushing the microtask queue
    // would fail this test through vitest's unhandled-rejection detection if
    // the rejected promise had been left dangling.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

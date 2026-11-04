import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { analyses, features, projects, repositories, scenarios } from '../../server/db/schema'
import { searchScenarios } from '../../server/db/search'
import { runInitialAnalysis } from '../../server/services/analysis.service'
import { ask, EMPTY_QUESTION_ANSWER, NO_COVERAGE_ANSWER } from '../../server/services/ask.service'
import { fakeDeps, fakeLlm } from './helpers/analysis-fakes'

/**
 * Retrieval spy: the search module keeps its real implementation but each
 * export becomes a vi.fn, so tests can assert how often (and with what) the
 * ask service searches. The fake llm doubles as the generate spy through its
 * generateCalls log — the zero-coverage refusal must show zero entries.
 */
vi.mock('../../server/db/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/db/search')>()
  return { ...actual, searchScenarios: vi.fn(actual.searchScenarios) }
})

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
  vi.mocked(searchScenarios).mockClear()
})

/** Runs the real analysis pipeline over the shared fixtures, so the DB holds Authentication + Tasks rows. */
async function seedProject(): Promise<number> {
  const db = getDB()
  const project = db.insert(projects).values({
    name: 'Ask Fixture',
    description: 'Pins the ask service',
    createdAt: '2026-11-04T00:00:00.000Z',
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
    createdAt: '2026-11-04T00:00:00.000Z',
    finishedAt: null,
  }).returning().get()

  await runInitialAnalysis({ analysisId: analysis.id, projectId: project.id }, fakeDeps())
  return project.id
}

/** Live scenario row by code; codes repeat per feature, so the feature name disambiguates. */
function scenarioRowByCode(code: string, featureName: string) {
  return getDB().select({
    id: scenarios.id,
    code: scenarios.code,
    featureId: scenarios.featureId,
    featureName: features.name,
  }).from(scenarios)
    .innerJoin(features, eq(features.id, scenarios.featureId))
    .where(and(eq(scenarios.code, code), eq(features.name, featureName)))
    .get()
}

describe('ask', () => {
  test('answers with citations mapped to live scenario rows', async () => {
    const projectId = await seedProject()
    const db = getDB()
    const hp1 = scenarioRowByCode('HP-1', 'Authentication')
    const hits = await searchScenarios(db, projectId, 'login form')
    expect(hits.length).toBeGreaterThan(1)
    expect(hits.some((hit) => hit.scenarioId === hp1?.id)).toBe(true)

    const llm = fakeLlm({
      'ask-answer': {
        covered: true,
        answer: 'Signing in works through the login form [1].',
        citations: [{
          index: 1,
          scenarioId: hits[0]!.scenarioId,
          quote: 'submit the login form with a registered email and the correct password',
        }],
      },
    })

    // Forget the direct searchScenarios call above, so the assertions below
    // describe exactly what ask() itself did.
    vi.mocked(searchScenarios).mockClear()
    const result = await ask(projectId, '  login form  ', { db, llm })

    expect(result.refused).toBe(false)
    expect(result.answer).toBe('Signing in works through the login form [1].')
    expect(result.citations).toEqual([{
      index: 1,
      scenarioId: hits[0]!.scenarioId,
      code: hits[0]!.code,
      featureId: hits[0]!.featureId,
      featureName: hits[0]!.featureName,
      quote: 'submit the login form with a registered email and the correct password',
    }])

    // The question is trimmed before retrieval, and the top-8 limit is fixed.
    expect(vi.mocked(searchScenarios).mock.calls[0]).toEqual([db, projectId, 'login form', 8])
    // The prompt numbers the retrieved scenarios and carries the question.
    expect(llm.generateCalls).toHaveLength(1)
    expect(llm.generateCalls[0]!.name).toBe('ask-answer')
    expect(llm.generateCalls[0]!.prompt).toContain(`1. [${hits[0]!.code}]`)
    expect(llm.generateCalls[0]!.prompt).toContain('Question: login form')
  })

  test('refuses with zero llm calls when retrieval finds nothing', async () => {
    const projectId = await seedProject()
    // A scripted would-be answer: if the refusal path ever called the llm, it would leak through.
    const llm = fakeLlm({
      'ask-answer': { covered: true, answer: 'fabricated', citations: [] },
    })

    const result = await ask(projectId, 'invoice refunds', { llm })

    expect(result).toEqual({ answer: NO_COVERAGE_ANSWER, refused: true, citations: [] })
    expect(vi.mocked(searchScenarios).mock.calls).toHaveLength(1)
    expect(llm.generateCalls).toEqual([])
  })

  test('refuses an empty question without retrieval or llm calls', async () => {
    const projectId = await seedProject()
    const llm = fakeLlm({
      'ask-answer': { covered: true, answer: 'fabricated', citations: [] },
    })

    const result = await ask(projectId, '   ', { llm })

    expect(result).toEqual({ answer: EMPTY_QUESTION_ANSWER, refused: true, citations: [] })
    expect(vi.mocked(searchScenarios).mock.calls).toHaveLength(0)
    expect(llm.generateCalls).toEqual([])
  })

  test('drops citations for unknown scenario ids and strips their markers', async () => {
    const projectId = await seedProject()
    const hits = await searchScenarios(getDB(), projectId, 'login form')
    const llm = fakeLlm({
      'ask-answer': {
        covered: true,
        answer: 'Signing in uses the login form [1]. Sessions stay server-side [2].',
        citations: [
          { index: 1, scenarioId: hits[0]!.scenarioId, quote: 'submit the login form' },
          { index: 2, scenarioId: 999999, quote: 'fabricated' },
        ],
      },
    })

    const result = await ask(projectId, 'login form', { llm })

    expect(result.refused).toBe(false)
    expect(result.answer).toBe('Signing in uses the login form [1]. Sessions stay server-side.')
    expect(result.citations).toHaveLength(1)
    expect(result.citations[0]!.scenarioId).toBe(hits[0]!.scenarioId)
    expect(result.citations[0]!.index).toBe(1)
  })

  test('strips markers that have no citation entry', async () => {
    const projectId = await seedProject()
    const hits = await searchScenarios(getDB(), projectId, 'login form')
    const llm = fakeLlm({
      'ask-answer': {
        covered: true,
        answer: 'The login form rejects bad credentials [3] and errors show one message [1].',
        citations: [
          { index: 1, scenarioId: hits[0]!.scenarioId, quote: 'the form shows one message' },
        ],
      },
    })

    const result = await ask(projectId, 'login form', { llm })

    expect(result.answer).toBe('The login form rejects bad credentials and errors show one message [1].')
    expect(result.citations).toHaveLength(1)
  })

  test('re-indexes citations in display order and remaps markers by original index', async () => {
    const projectId = await seedProject()
    const hits = await searchScenarios(getDB(), projectId, 'login form')
    const llm = fakeLlm({
      'ask-answer': {
        covered: true,
        answer: 'The second scenario applies [2] before the first [1] does.',
        citations: [
          { index: 1, scenarioId: hits[0]!.scenarioId, quote: 'first quote' },
          { index: 2, scenarioId: hits[1]!.scenarioId, quote: 'second quote' },
        ],
      },
    })

    const result = await ask(projectId, 'login form', { llm })

    expect(result.answer).toBe('The second scenario applies [1] before the first [2] does.')
    expect(result.citations).toEqual([
      { index: 1, scenarioId: hits[1]!.scenarioId, code: hits[1]!.code, featureId: hits[1]!.featureId, featureName: hits[1]!.featureName, quote: 'second quote' },
      { index: 2, scenarioId: hits[0]!.scenarioId, code: hits[0]!.code, featureId: hits[0]!.featureId, featureName: hits[0]!.featureName, quote: 'first quote' },
    ])
  })

  test('keeps citations no marker references, after the cited ones, in prompt order', async () => {
    const projectId = await seedProject()
    const hits = await searchScenarios(getDB(), projectId, 'login form')
    expect(hits.length).toBeGreaterThan(2)
    const llm = fakeLlm({
      'ask-answer': {
        covered: true,
        answer: 'The second scenario matters here [2].',
        citations: [
          { index: 2, scenarioId: hits[1]!.scenarioId, quote: 'cited quote' },
          { index: 3, scenarioId: hits[2]!.scenarioId, quote: 'unreferenced quote' },
        ],
      },
    })

    const result = await ask(projectId, 'login form', { llm })

    expect(result.answer).toBe('The second scenario matters here [1].')
    expect(result.citations).toEqual([
      { index: 1, scenarioId: hits[1]!.scenarioId, code: hits[1]!.code, featureId: hits[1]!.featureId, featureName: hits[1]!.featureName, quote: 'cited quote' },
      { index: 2, scenarioId: hits[2]!.scenarioId, code: hits[2]!.code, featureId: hits[2]!.featureId, featureName: hits[2]!.featureName, quote: 'unreferenced quote' },
    ])
  })

  test('surfaces a covered:false verdict as a refusal with the llm one-liner', async () => {
    const projectId = await seedProject()
    const llm = fakeLlm({
      'ask-answer': { covered: false, answer: 'The spec has nothing about password resets.', citations: [] },
    })

    const result = await ask(projectId, 'login form', { llm })

    expect(result).toEqual({ answer: 'The spec has nothing about password resets.', refused: true, citations: [] })
    expect(llm.generateCalls).toHaveLength(1)
  })
})

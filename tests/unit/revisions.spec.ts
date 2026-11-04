import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { annotations, features, projects, releases, repositories, scenarioRevisions, scenarios } from '../../server/db/schema'
import { applyScenarioRevision, discardScenarioRevision } from '../../server/services/revisions.service'

/**
 * Proposal-decision tests run against a :memory: database seeded the way the
 * sync leaves it after parking a proposal on a manual scenario: a release,
 * an Authentication feature with a manual HP-1 row, and a `proposed` revision
 * whose afterJson snapshot carries the suggested text.
 */

let projectId: number
let featureId: number
let releaseId: number

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Revisions', description: 'seed project', createdAt: '2026-11-03T00:00:00.000Z',
  }).returning().get().id
  const repository = db.insert(repositories).values({
    projectId, owner: 'acme', repo: 'tasks', branch: 'main',
  }).returning().get()
  releaseId = db.insert(releases).values({
    projectId, repositoryId: repository.id, sha: 'abc123', title: 'Sync', category: 'feature',
    highlight: 0, summary: 'sync summary', authorsJson: '[]', message: 'sync message',
    committedAt: '2026-11-03T01:00:00.000Z',
  }).returning().get().id
  featureId = db.insert(features).values({
    projectId, parentId: null, name: 'Authentication', description: 'auth flows',
    sortOrder: 0, source: 'ai',
  }).returning().get().id
})

/** Seeds a manual scenario and returns its id. */
function seedManualScenario(patch: Partial<typeof scenarios.$inferInsert> = {}): number {
  const row = getDB().insert(scenarios).values({
    featureId,
    context: 'user on the login page',
    action: 'sign in with a valid password',
    outcome: 'the user lands on the tasks page',
    category: 'happy',
    code: 'HP-1',
    sortOrder: 0,
    source: 'manual',
    ...patch,
  }).returning().get()
  return row.id
}

/** Seeds a proposed revision over a scenario, with the sync's snapshot shape. */
function seedProposal(scenarioId: number | null, patch: Partial<typeof scenarioRevisions.$inferInsert> = {}): number {
  const row = getDB().insert(scenarioRevisions).values({
    releaseId,
    scenarioId,
    featureId,
    kind: 'changed',
    state: 'proposed',
    beforeJson: JSON.stringify({ code: 'HP-1', action: 'sign in with a valid password', outcome: 'the user lands on the tasks page' }),
    afterJson: JSON.stringify({
      code: 'HP-1',
      context: 'user on the login page',
      action: 'sign in with SSO instead of a password',
      outcome: 'the IdP callback lands the user on the tasks page',
      category: 'happy',
    }),
    ...patch,
  }).returning().get()
  return row.id
}

describe('applyScenarioRevision', () => {
  test('overwrites the scenario from afterJson, keeps it manual, parks the revision as applied', () => {
    const scenarioId = seedManualScenario()
    const revisionId = seedProposal(scenarioId)

    expect(applyScenarioRevision(revisionId)).toBe('ok')

    expect(getDB().select().from(scenarios).where(eq(scenarios.id, scenarioId)).get()).toMatchObject({
      context: 'user on the login page',
      action: 'sign in with SSO instead of a password',
      outcome: 'the IdP callback lands the user on the tasks page',
      category: 'happy',
      code: 'HP-1',
      source: 'manual',
    })
    expect(getDB().select().from(scenarioRevisions).where(eq(scenarioRevisions.id, revisionId)).get())
      .toMatchObject({ state: 'applied', scenarioId })
  })

  test('a second apply is rejected — the decision is not double-applied', () => {
    const scenarioId = seedManualScenario()
    const revisionId = seedProposal(scenarioId)

    expect(applyScenarioRevision(revisionId)).toBe('ok')
    expect(applyScenarioRevision(revisionId)).toBe('not_proposed')
    expect(getDB().select().from(scenarios).where(eq(scenarios.id, scenarioId)).get())
      .toMatchObject({ action: 'sign in with SSO instead of a password' })
  })

  test('applying a removal deletes the scenario with its annotations and detaches the revision', () => {
    const scenarioId = seedManualScenario({ code: 'ER-1', category: 'error' })
    getDB().insert(annotations).values({ scenarioId, body: 'support note', author: 'operator', createdAt: '2026-11-03T00:00:00.000Z' }).run()
    const revisionId = seedProposal(scenarioId, {
      kind: 'gone',
      beforeJson: JSON.stringify({ code: 'ER-1', action: 'sign in with a valid password', outcome: 'the user lands on the tasks page' }),
      afterJson: null,
    })

    expect(applyScenarioRevision(revisionId)).toBe('ok')

    expect(getDB().select().from(scenarios).where(eq(scenarios.id, scenarioId)).get()).toBeUndefined()
    expect(getDB().select().from(annotations).where(eq(annotations.scenarioId, scenarioId)).all()).toEqual([])
    expect(getDB().select().from(scenarioRevisions).where(eq(scenarioRevisions.id, revisionId)).get())
      .toMatchObject({ state: 'applied', scenarioId: null })
  })

  test('unknown revision → not_found', () => {
    expect(applyScenarioRevision(99_999)).toBe('not_found')
  })
})

describe('discardScenarioRevision', () => {
  test('parks the revision as discarded and leaves the scenario untouched', () => {
    const scenarioId = seedManualScenario()
    const before = getDB().select().from(scenarios).where(eq(scenarios.id, scenarioId)).get()
    const revisionId = seedProposal(scenarioId)

    expect(discardScenarioRevision(revisionId)).toBe('ok')

    expect(getDB().select().from(scenarios).where(eq(scenarios.id, scenarioId)).get()).toEqual(before)
    expect(getDB().select().from(scenarioRevisions).where(eq(scenarioRevisions.id, revisionId)).get())
      .toMatchObject({ state: 'discarded', scenarioId })
  })

  test('discarding after applying, or twice, is rejected', () => {
    const scenarioId = seedManualScenario()
    const revisionId = seedProposal(scenarioId)

    expect(applyScenarioRevision(revisionId)).toBe('ok')
    expect(discardScenarioRevision(revisionId)).toBe('not_proposed')

    const second = seedProposal(scenarioId)
    expect(discardScenarioRevision(second)).toBe('ok')
    expect(discardScenarioRevision(second)).toBe('not_proposed')
  })

  test('unknown revision → not_found', () => {
    expect(discardScenarioRevision(99_999)).toBe('not_found')
  })
})

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { annotations, features, projects, scenarios } from '../../server/db/schema'
import {
  addAnnotation,
  createManualScenario,
  deleteScenario,
  getFeatureDetail,
  getFeatureTree,
  listAnnotations,
  updateScenario,
} from '../../server/services/spec.service'

/**
 * Spec-service tests run against a :memory: database seeded with one project,
 * an Authentication feature and a few AI scenarios, mirroring the rows the
 * Task 8 pipeline produces (codes HP-1/ER-1…, source 'ai'). The manual-edit
 * rules under test are the ones Task 10's sync will rely on: anything touched
 * by an operator becomes manual territory.
 */

let projectId: number
let featureId: number

function seedScenario(patch: Partial<typeof scenarios.$inferInsert> = {}): number {
  const row = getDB().insert(scenarios).values({
    featureId,
    context: 'user on the login page',
    action: 'submit the login form',
    outcome: 'the session cookie is set',
    category: 'happy',
    code: 'HP-1',
    sortOrder: 0,
    source: 'ai',
    ...patch,
  }).run()
  return row.lastInsertRowid as number
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Spec Fixture',
    description: 'Exercises the spec browsing APIs',
    createdAt: new Date().toISOString(),
  }).run().lastInsertRowid as number
  featureId = db.insert(features).values({
    projectId,
    name: 'Authentication',
    description: 'Email and password login with signed session cookies.',
    sortOrder: 0,
    source: 'ai',
  }).run().lastInsertRowid as number
})

describe('createManualScenario', () => {
  test('stores the scenario with source manual and the next happy code', () => {
    seedScenario()

    const created = createManualScenario(featureId, {
      context: 'user on the login page',
      action: 'submit the login form with a magic link',
      outcome: 'the session cookie is set without a password',
      category: 'happy',
    })

    expect(created).toMatchObject({ code: 'HP-2', source: 'manual', category: 'happy', context: 'user on the login page' })
  })

  test('takes the next code per category, based on the highest existing suffix', () => {
    seedScenario({ category: 'error', code: 'ER-1' })
    seedScenario({ category: 'error', code: 'ER-2', sortOrder: 1 })

    const created = createManualScenario(featureId, {
      context: 'user on the login page',
      action: 'submit the login form with an unregistered email',
      outcome: 'the form shows an error and no cookie is set',
      category: 'error',
    })

    expect(created?.code).toBe('ER-3')
  })

  test('a feature without scenarios starts at -1 in every category', () => {
    const created = createManualScenario(featureId, {
      context: 'user on the login page',
      action: 'submit the login form correctly',
      outcome: 'the user lands on the tasks page',
      category: 'happy',
    })

    expect(created?.code).toBe('HP-1')
  })

  test('returns null when the feature does not exist', () => {
    expect(createManualScenario(99_999, {
      context: 'user on the login page',
      action: 'submit the login form',
      outcome: 'the session cookie is set',
      category: 'happy',
    })).toBeNull()
  })
})

describe('updateScenario', () => {
  test('flips the source to manual and updates only the edited fields', () => {
    const id = seedScenario({ category: 'error', code: 'ER-1', action: 'submit the login form with the wrong password' })

    const updated = updateScenario(id, { outcome: 'the login form shows a warning before locking the account' })

    expect(updated).toMatchObject({
      source: 'manual',
      outcome: 'the login form shows a warning before locking the account',
      action: 'submit the login form with the wrong password',
      category: 'error',
    })
  })

  test('an empty patch is not an edit: the row keeps its source', () => {
    const id = seedScenario()

    const updated = updateScenario(id, {})

    expect(updated).toMatchObject({ source: 'ai', action: 'submit the login form', outcome: 'the session cookie is set' })
    expect(getDB().select().from(scenarios).where(eq(scenarios.id, id)).get()).toMatchObject({ source: 'ai' })
  })

  test('a category change regenerates the code for the new category', () => {
    const id = seedScenario({ category: 'happy', code: 'HP-1' })
    seedScenario({ category: 'error', code: 'ER-1', sortOrder: 1 })

    const updated = updateScenario(id, { category: 'error' })

    expect(updated).toMatchObject({
      source: 'manual',
      category: 'error',
      code: 'ER-2',
    })
  })

  test('a no-op patch with a field set to its current value keeps the source and code', () => {
    const id = seedScenario({ category: 'happy', code: 'HP-1' })

    const updated = updateScenario(id, { action: 'submit the login form' })

    expect(updated).toMatchObject({ source: 'ai', code: 'HP-1', action: 'submit the login form' })
  })

  test('returns null for unknown ids', () => {
    expect(updateScenario(99_999, { outcome: 'does not matter' })).toBeNull()
  })
})

describe('deleteScenario', () => {
  test('removes the scenario and reports the deletion', () => {
    const id = seedScenario()
    expect(deleteScenario(id)).toBe(true)
    expect(deleteScenario(id)).toBe(false)
  })

  test('removes the scenario together with its annotations', () => {
    const db = getDB()
    const scenarioId = seedScenario()
    addAnnotation(scenarioId, { body: 'Support asked about this case' })
    addAnnotation(scenarioId, { body: 'Also relevant for SSO' })

    expect(deleteScenario(scenarioId)).toBe(true)

    // annotations.scenarioId has no DB-level cascade, so the service must
    // clean them up itself — Task 10's sync deletes scenarios too.
    expect(db.select({ id: scenarios.id }).from(scenarios).where(eq(scenarios.id, scenarioId)).all()).toEqual([])
    expect(db.select().from(annotations).all()).toEqual([])
  })

  test('frees its code: the next manual scenario reuses the number', () => {
    seedScenario({ category: 'happy', code: 'HP-1' })
    const second = seedScenario({ category: 'happy', code: 'HP-2', sortOrder: 1 })
    deleteScenario(second)

    const created = createManualScenario(featureId, {
      context: 'user on the login page',
      action: 'submit the login form again',
      outcome: 'the session cookie is set',
      category: 'happy',
    })

    expect(created?.code).toBe('HP-2')
  })
})

describe('getFeatureTree', () => {
  test('lists features with scenario counts and nests children', () => {
    const db = getDB()
    seedScenario()
    seedScenario({ category: 'error', code: 'ER-1', sortOrder: 1 })
    const childId = db.insert(features).values({
      projectId,
      parentId: featureId,
      name: 'Login',
      description: 'Validates credentials.',
      sortOrder: 1,
      source: 'ai',
    }).run().lastInsertRowid as number

    const tree = getFeatureTree(projectId)

    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ id: featureId, name: 'Authentication', scenarioCount: 2 })
    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[0]?.children[0]).toMatchObject({ id: childId, name: 'Login', scenarioCount: 0, children: [] })
  })

  test('returns an empty array for a project without features', () => {
    const emptyId = getDB().insert(projects).values({
      name: 'Empty Project',
      description: 'No analysis has run here',
      createdAt: new Date().toISOString(),
    }).run().lastInsertRowid as number

    expect(getFeatureTree(emptyId)).toEqual([])
  })
})

describe('getFeatureDetail', () => {
  test('groups scenarios by context in first-seen order', () => {
    seedScenario({ context: 'user on the login page' })
    seedScenario({ context: 'user with an active session', code: 'HP-2', sortOrder: 1 })
    seedScenario({ context: 'user on the login page', code: 'ER-1', category: 'error', sortOrder: 2 })

    const detail = getFeatureDetail(featureId)

    expect(detail?.feature).toMatchObject({ id: featureId, name: 'Authentication' })
    expect(detail?.groups.map((group) => group.context)).toEqual(['user on the login page', 'user with an active session'])
    expect(detail?.groups[0]?.scenarios.map((scenario) => scenario.code)).toEqual(['HP-1', 'ER-1'])
    expect(detail?.groups[0]?.scenarios[0]).toMatchObject({ source: 'ai', category: 'happy' })
  })

  test('returns null for unknown features', () => {
    expect(getFeatureDetail(99_999)).toBeNull()
  })
})

describe('annotations', () => {
  test('stores a note with the operator author and lists them oldest first', () => {
    const scenarioId = seedScenario()

    const first = addAnnotation(scenarioId, { body: 'Support asked about this case' })
    addAnnotation(scenarioId, { body: 'Also relevant for SSO' })

    expect(first).toMatchObject({ body: 'Support asked about this case', author: 'operator', scenarioId })
    expect(listAnnotations(scenarioId).map((note) => note.body)).toEqual([
      'Support asked about this case',
      'Also relevant for SSO',
    ])
  })

  test('returns null when the scenario does not exist', () => {
    expect(addAnnotation(99_999, { body: 'orphan note' })).toBeNull()
    expect(listAnnotations(99_999)).toEqual([])
  })
})

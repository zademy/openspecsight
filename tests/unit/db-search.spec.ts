import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { features, projects, scenarios } from '../../server/db/schema'
import { searchScenarios } from '../../server/db/search'

/**
 * The client is a singleton that reads DATABASE_PATH lazily on the first
 * getDB() call, so setting the env var here (before any getDB() call) is
 * enough. vitest.config.ts sets no env on purpose: each suite owns its env.
 * resetDB() drops the singleton so every test gets a fresh in-memory DB.
 */
beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
})

/**
 * One project with two login scenarios of different match strength (three
 * 'login' mentions vs one) plus an unrelated scenario, so ranking has a
 * deterministic expected order.
 */
function seedLoginScenarios(projectName: string) {
  const db = getDB()

  const project = db.insert(projects).values({
    name: projectName,
    description: `The ${projectName} product spec`,
    createdAt: '2026-11-04T00:00:00.000Z',
  }).returning().get()

  const loginFeature = db.insert(features).values({
    projectId: project.id,
    parentId: null,
    name: 'Login',
    description: 'Authentication flows for the login page',
    sortOrder: 1,
    source: 'ai',
  }).returning().get()

  const strongLoginScenario = db.insert(scenarios).values({
    featureId: loginFeature.id,
    context: 'a registered user on the login page',
    action: 'submits login credentials',
    outcome: 'login succeeds',
    category: 'happy',
    code: 'SC-001',
    sortOrder: 0,
    source: 'ai',
  }).returning().get()

  const profileFeature = db.insert(features).values({
    projectId: project.id,
    parentId: null,
    name: 'Profile',
    description: 'The user profile page',
    sortOrder: 2,
    source: 'ai',
  }).returning().get()

  const weakLoginScenario = db.insert(scenarios).values({
    featureId: profileFeature.id,
    context: 'a signed-in user opens their profile',
    action: 'views the session history',
    outcome: 'the profile shows past login activity',
    category: 'happy',
    code: 'SC-002',
    sortOrder: 0,
    source: 'ai',
  }).returning().get()

  db.insert(scenarios).values({
    featureId: profileFeature.id,
    context: 'a signed-in user opens their profile',
    action: 'changes the display name',
    outcome: 'the profile shows the new name',
    category: 'happy',
    code: 'SC-003',
    sortOrder: 1,
    source: 'ai',
  }).run()

  return {
    db,
    projectId: project.id,
    loginFeatureId: loginFeature.id,
    strongLoginScenarioId: strongLoginScenario.id,
    weakLoginScenarioId: weakLoginScenario.id,
  }
}

describe('searchScenarios()', () => {
  test('finds login scenarios ranked by match strength', async () => {
    const seeded = seedLoginScenarios('Widget Platform')

    const hits = await searchScenarios(seeded.db, seeded.projectId, 'login')

    expect(hits).toHaveLength(2)
    expect(hits[0]).toEqual({
      scenarioId: seeded.strongLoginScenarioId,
      featureId: seeded.loginFeatureId,
      code: 'SC-001',
      context: 'a registered user on the login page',
      action: 'submits login credentials',
      outcome: 'login succeeds',
      featureName: 'Login',
    })
    expect(hits[1]?.scenarioId).toBe(seeded.weakLoginScenarioId)
  })

  test('matches word prefixes', async () => {
    const seeded = seedLoginScenarios('Widget Platform')

    const hits = await searchScenarios(seeded.db, seeded.projectId, 'log')

    expect(hits.map((hit) => hit.scenarioId)).toEqual([seeded.strongLoginScenarioId, seeded.weakLoginScenarioId])
  })

  test('returns scenarios only from the given project', async () => {
    const seeded = seedLoginScenarios('Widget Platform')
    seedLoginScenarios('Other Platform')

    const hits = await searchScenarios(seeded.db, seeded.projectId, 'login')

    expect(hits).toHaveLength(2)
    expect(hits.every((hit) => hit.scenarioId === seeded.strongLoginScenarioId || hit.scenarioId === seeded.weakLoginScenarioId)).toBe(true)
  })

  test('returns [] when nothing matches', async () => {
    const seeded = seedLoginScenarios('Widget Platform')

    expect(await searchScenarios(seeded.db, seeded.projectId, 'zzqxjv')).toEqual([])
  })

  test('never throws on FTS operator soup', async () => {
    const seeded = seedLoginScenarios('Widget Platform')

    expect(await searchScenarios(seeded.db, seeded.projectId, 'AND OR (drop)')).toEqual([])
  })

  test('returns [] for empty or whitespace-only queries', async () => {
    const seeded = seedLoginScenarios('Widget Platform')

    expect(await searchScenarios(seeded.db, seeded.projectId, '')).toEqual([])
    expect(await searchScenarios(seeded.db, seeded.projectId, '   ')).toEqual([])
  })

  test('respects the limit', async () => {
    const seeded = seedLoginScenarios('Widget Platform')
    seeded.db.insert(scenarios).values({
      featureId: seeded.loginFeatureId,
      context: 'a locked-out user on the login page',
      action: 'submits login credentials three times',
      outcome: 'the login attempt is rate limited',
      category: 'error',
      code: 'SC-004',
      sortOrder: 2,
      source: 'ai',
    }).run()

    expect(await searchScenarios(seeded.db, seeded.projectId, 'login')).toHaveLength(3)
    expect(await searchScenarios(seeded.db, seeded.projectId, 'login', 2)).toHaveLength(2)
  })
})

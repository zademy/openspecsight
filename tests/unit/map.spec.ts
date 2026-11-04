import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { connections, features, projects, scenarios } from '../../server/db/schema'
import type { ConnectionType } from '../../shared/types'
import { getMap } from '../../server/services/map.service'

/**
 * Map-service tests run against a :memory: database seeded with a small
 * hand-built row set mirroring the analysis fixture world (Authentication
 * with a Login child, Tasks with a Task list child), so pair collapsing,
 * node counts and project scoping can be asserted exactly.
 */

let projectId: number
let authId: number
let loginId: number
let tasksId: number
let taskListId: number

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Map Fixture',
    description: '',
    createdAt: '2026-11-04T00:00:00.000Z',
  }).returning().get().id

  authId = seedFeature({ name: 'Authentication', sortOrder: 0 })
  loginId = seedFeature({ name: 'Login', parentId: authId, sortOrder: 0 })
  tasksId = seedFeature({ name: 'Tasks', sortOrder: 1 })
  taskListId = seedFeature({ name: 'Task list', parentId: tasksId, sortOrder: 0 })

  seedScenario(authId, 'HP-1')
  seedScenario(authId, 'ER-1')
  seedScenario(loginId, 'HP-1')
  seedScenario(tasksId, 'HP-1')
  seedScenario(tasksId, 'HP-2')
  seedScenario(tasksId, 'ER-1')
})

function seedFeature(patch: Partial<typeof features.$inferInsert> & { name: string }): number {
  return getDB().insert(features).values({
    projectId,
    parentId: null,
    description: '',
    sortOrder: 0,
    source: 'ai',
    ...patch,
  }).returning().get().id
}

function seedScenario(featureId: number, code: string, source: 'ai' | 'manual' = 'ai'): void {
  getDB().insert(scenarios).values({
    featureId,
    context: 'context',
    action: 'action',
    outcome: 'outcome',
    category: 'happy',
    code,
    sortOrder: 0,
    source,
  }).run()
}

function seedConnection(fromFeatureId: number, toFeatureId: number, type: ConnectionType): void {
  getDB().insert(connections).values({ projectId, fromFeatureId, toFeatureId, type }).run()
}

describe('getMap', () => {
  test('collapses all connections of a pair into one edge with sorted types', () => {
    seedConnection(authId, tasksId, 'authenticates')
    seedConnection(authId, tasksId, 'shares_data')
    seedConnection(tasksId, authId, 'depends_on')
    seedConnection(loginId, taskListId, 'leads_to')

    const map = getMap(projectId)

    expect(map?.edges).toEqual([
      { from: authId, to: tasksId, types: ['authenticates', 'depends_on', 'shares_data'] },
      { from: loginId, to: taskListId, types: ['leads_to'] },
    ])
    expect(map?.empty).toBe(false)
  })

  test('lists every feature as a node, children flagged, counting only own scenarios', () => {
    seedConnection(authId, tasksId, 'authenticates')

    const map = getMap(projectId)

    const byName = new Map(map?.nodes.map((node) => [node.name, node]))
    expect(byName.get('Authentication')).toMatchObject({ id: authId, featureId: authId, scenarioCount: 2, isChild: false })
    expect(byName.get('Login')).toMatchObject({ id: loginId, featureId: loginId, scenarioCount: 1, isChild: true })
    expect(byName.get('Tasks')).toMatchObject({ id: tasksId, scenarioCount: 3, isChild: false })
    expect(byName.get('Task list')).toMatchObject({ id: taskListId, scenarioCount: 0, isChild: true })
  })

  test('reports empty while the project has no connections', () => {
    const map = getMap(projectId)

    expect(map?.nodes).toHaveLength(4)
    expect(map?.edges).toEqual([])
    expect(map?.empty).toBe(true)
  })

  test('scopes nodes and edges to the requested project', () => {
    seedConnection(authId, tasksId, 'authenticates')

    const db = getDB()
    const otherId = db.insert(projects).values({
      name: 'Other Fixture',
      description: '',
      createdAt: '2026-11-04T00:00:00.000Z',
    }).returning().get().id
    const billingId = db.insert(features).values({
      projectId: otherId,
      parentId: null,
      name: 'Billing',
      description: '',
      sortOrder: 0,
      source: 'ai',
    }).returning().get().id
    const invoicesId = db.insert(features).values({
      projectId: otherId,
      parentId: null,
      name: 'Invoices',
      description: '',
      sortOrder: 1,
      source: 'ai',
    }).returning().get().id
    db.insert(connections).values({ projectId: otherId, fromFeatureId: billingId, toFeatureId: invoicesId, type: 'leads_to' }).run()

    const map = getMap(projectId)
    expect(map?.nodes.map((node) => node.name)).toEqual(['Authentication', 'Login', 'Task list', 'Tasks'])
    expect(map?.edges).toEqual([{ from: authId, to: tasksId, types: ['authenticates'] }])

    const otherMap = getMap(otherId)
    expect(otherMap?.nodes.map((node) => node.name)).toEqual(['Billing', 'Invoices'])
    expect(otherMap?.edges).toEqual([{ from: billingId, to: invoicesId, types: ['leads_to'] }])
  })

  test('returns null for an unknown project', () => {
    expect(getMap(999)).toBeNull()
  })
})

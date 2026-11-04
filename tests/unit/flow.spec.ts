import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { features, flows, projects, scenarios } from '../../server/db/schema'
import type { FlowGraph } from '../../shared/types'
import { getFeatureFlow } from '../../server/services/spec.service'

/**
 * Flow-endpoint tests run against a :memory: database seeded the way the
 * analysis pipeline leaves it: one project, an Authentication feature with
 * live scenarios (codes HP-1/ER-2…), and one flows row carrying graphJson.
 * Under test is the read mapping: the graph parses through FlowGraphSchema
 * and every node scenarioCode resolves to a live scenario of THIS feature —
 * a code with no matching row is dropped from the links, never fatal.
 */

let projectId: number
let featureId: number
let tasksId: number

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

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'start', kind: 'start', label: 'User opens the login page' },
    { id: 'submit', kind: 'step', label: 'Submit email and password', scenarioCode: 'HP-1' },
    { id: 'credentials', kind: 'decision', label: 'Valid credentials?' },
    { id: 'invalid', kind: 'error', label: "Show 'Invalid email or password'", scenarioCode: 'ER-2' },
    { id: 'end', kind: 'end', label: 'Back on the login page' },
  ],
  edges: [
    { from: 'start', to: 'submit' },
    { from: 'submit', to: 'credentials' },
    { from: 'credentials', to: 'invalid', label: 'no' },
    { from: 'invalid', to: 'end' },
  ],
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Flow Fixture',
    description: 'Exercises the flow API',
    createdAt: new Date().toISOString(),
  }).run().lastInsertRowid as number
  featureId = db.insert(features).values({
    projectId,
    name: 'Authentication',
    description: 'Email and password login with signed session cookies.',
    sortOrder: 0,
    source: 'ai',
  }).run().lastInsertRowid as number
  tasksId = db.insert(features).values({
    projectId,
    name: 'Tasks',
    description: 'Create, complete, and filter personal tasks with due dates.',
    sortOrder: 1,
    source: 'ai',
  }).run().lastInsertRowid as number
})

describe('getFeatureFlow', () => {
  test('parses graphJson through FlowGraphSchema and links node codes to live scenarios', () => {
    const hp1 = seedScenario({ code: 'HP-1', sortOrder: 0 })
    const er2 = seedScenario({
      code: 'ER-2',
      category: 'error',
      action: "shows 'Invalid email or password'",
      outcome: 'no cookie is set',
      sortOrder: 1,
    })
    getDB().insert(flows).values({ featureId, graphJson: JSON.stringify(GRAPH) }).run()

    const flow = getFeatureFlow(featureId)
    expect(flow?.graph).toEqual(GRAPH)
    // Links follow node order, not scenario sort order.
    expect(flow?.scenarioLinks).toEqual([
      { scenarioCode: 'HP-1', scenarioId: hp1 },
      { scenarioCode: 'ER-2', scenarioId: er2 },
    ])
  })

  test('returns null when the feature exists but has no flow row', () => {
    seedScenario()

    expect(getFeatureFlow(featureId)).toBeNull()
  })

  test('returns null for an unknown feature', () => {
    expect(getFeatureFlow(999)).toBeNull()
  })

  test('drops node codes with no live scenario instead of failing', () => {
    seedScenario({ code: 'HP-1' })
    const stale = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((node) => node.id === 'invalid' ? { ...node, scenarioCode: 'ER-9' } : node),
    }
    getDB().insert(flows).values({ featureId, graphJson: JSON.stringify(stale) }).run()

    const flow = getFeatureFlow(featureId)
    expect(flow?.graph).toEqual(stale)
    expect(flow?.scenarioLinks).toEqual([{ scenarioCode: 'HP-1', scenarioId: expect.any(Number) }])
  })

  test('does not resolve a code against another feature\'s scenario', () => {
    const authHp1 = seedScenario({ code: 'HP-1' })
    // Tasks owns its own HP-1; the Authentication graph must not see it.
    getDB().insert(scenarios).values({
      featureId: tasksId,
      context: 'user creating a task',
      action: 'create a task with a title and a due date',
      outcome: 'the task appears in the list',
      category: 'happy',
      code: 'HP-1',
      sortOrder: 0,
      source: 'ai',
    }).run()
    getDB().insert(flows).values({ featureId, graphJson: JSON.stringify(GRAPH) }).run()

    const flow = getFeatureFlow(featureId)
    expect(flow?.scenarioLinks.find((link) => link.scenarioCode === 'HP-1'))
      .toEqual({ scenarioCode: 'HP-1', scenarioId: authHp1 })
  })
})

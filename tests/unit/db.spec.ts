import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { features, projects, repositories, scenarios } from '../../server/db/schema'

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

describe('getDB()', () => {
  test('returns the same instance on repeated calls', () => {
    const first = getDB()
    const second = getDB()

    expect(second).toBe(first)
  })
})

describe('schema roundtrip', () => {
  test('inserts project → repository → feature → scenario and reads back all fields', () => {
    const db = getDB()

    const project = db.insert(projects).values({
      name: 'Widget Platform',
      description: 'The widget platform product spec',
      createdAt: '2026-11-03T00:00:00.000Z',
    }).returning().get()

    const repository = db.insert(repositories).values({
      projectId: project.id,
      owner: 'acme',
      repo: 'widget',
      branch: 'main',
      patEncrypted: null,
      lastSyncedSha: null,
    }).returning().get()

    const feature = db.insert(features).values({
      projectId: project.id,
      parentId: null,
      name: 'Login',
      description: 'Authentication flows for the login page',
      sortOrder: 1,
      source: 'ai',
    }).returning().get()

    const scenario = db.insert(scenarios).values({
      featureId: feature.id,
      context: 'a registered user on the login page',
      action: 'submits correct credentials',
      outcome: 'the user is signed in',
      category: 'happy',
      code: 'SC-001',
      sortOrder: 0,
      source: 'ai',
    }).returning().get()

    expect(project).toEqual({
      id: expect.any(Number),
      name: 'Widget Platform',
      description: 'The widget platform product spec',
      createdAt: '2026-11-03T00:00:00.000Z',
    })
    expect(repository).toEqual({
      id: expect.any(Number),
      projectId: project.id,
      owner: 'acme',
      repo: 'widget',
      branch: 'main',
      patEncrypted: null,
      lastSyncedSha: null,
    })
    expect(feature).toEqual({
      id: expect.any(Number),
      projectId: project.id,
      parentId: null,
      name: 'Login',
      description: 'Authentication flows for the login page',
      sortOrder: 1,
      source: 'ai',
    })
    expect(scenario).toEqual({
      id: expect.any(Number),
      featureId: feature.id,
      context: 'a registered user on the login page',
      action: 'submits correct credentials',
      outcome: 'the user is signed in',
      category: 'happy',
      code: 'SC-001',
      sortOrder: 0,
      source: 'ai',
    })
  })
})

describe('scenarios_fts sync', () => {
  test('insert, update and delete on scenarios are reflected in the FTS index', () => {
    const db = getDB()

    const project = db.insert(projects).values({
      name: 'Widget Platform',
      description: 'The widget platform product spec',
      createdAt: '2026-11-03T00:00:00.000Z',
    }).returning().get()

    const feature = db.insert(features).values({
      projectId: project.id,
      parentId: null,
      name: 'Login',
      description: 'Authentication flows for the login page',
      sortOrder: 1,
      source: 'ai',
    }).returning().get()

    const scenario = db.insert(scenarios).values({
      featureId: feature.id,
      context: 'a registered user on the login page',
      action: 'submits correct credentials',
      outcome: 'the user is signed in',
      category: 'happy',
      code: 'SC-001',
      sortOrder: 0,
      source: 'ai',
    }).returning().get()

    const found = db.all(sql`
      SELECT rowid, context, action, outcome, feature_name
      FROM scenarios_fts
      WHERE scenarios_fts MATCH ${'login'}
    `)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      rowid: scenario.id,
      context: 'a registered user on the login page',
      action: 'submits correct credentials',
      outcome: 'the user is signed in',
      feature_name: 'Login',
    })

    db.update(scenarios)
      .set({ action: 'submits a valid SSO token' })
      .where(eq(scenarios.id, scenario.id))
      .run()

    expect(db.all(sql`SELECT rowid FROM scenarios_fts WHERE scenarios_fts MATCH ${'credentials'}`)).toHaveLength(0)
    const updated = db.all(sql`SELECT rowid FROM scenarios_fts WHERE scenarios_fts MATCH ${'sso'}`)
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ rowid: scenario.id })

    db.delete(scenarios).where(eq(scenarios.id, scenario.id)).run()

    expect(db.all(sql`SELECT rowid FROM scenarios_fts`)).toHaveLength(0)
  })
})

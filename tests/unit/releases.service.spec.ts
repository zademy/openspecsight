import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { features, projects, releases, repositories, scenarioRevisions, scenarios } from '../../server/db/schema'
import { getReleaseDetail, listReleaseDays } from '../../server/services/releases.service'

/**
 * Releases-service tests run against a :memory: database seeded with the
 * rows a sync leaves behind: releases with applied/proposed scenario
 * revisions whose beforeJson/afterJson carry the scenario snapshots. The
 * fixtures mirror the Task 10 e2e outcome (new/changed/fixed/gone on
 * Authentication) plus manual and fallback shapes the sync pipeline also
 * produces.
 */

let projectId: number
let authId: number
let tasksId: number

/** Same JSON shape the sync pipeline stores in beforeJson/afterJson. */
function snap(code: string, action: string, outcome: string): string {
  return JSON.stringify({ code, context: 'user on the login page', action, outcome, category: 'happy', source: 'ai' })
}

function seedScenario(patch: Partial<typeof scenarios.$inferInsert> = {}): number {
  const row = getDB().insert(scenarios).values({
    featureId: authId,
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

function seedRelease(patch: Partial<typeof releases.$inferInsert> = {}): number {
  const row = getDB().insert(releases).values({
    projectId,
    repositoryId: 1,
    sha: 'd4e5f6a708192a3b4c5d6e7f8091a2b3c4d5e6f7',
    title: 'Tighter sign-in checks',
    category: 'security',
    highlight: 1,
    summary: 'Sign-in now asks org admins for a second factor before any session is granted.',
    authorsJson: JSON.stringify(['Grace Hopper']),
    message: 'feat: tighten sign-in checks',
    committedAt: '2026-11-02T09:30:00Z',
    ...patch,
  }).run()
  return row.lastInsertRowid as number
}

function seedRevision(releaseId: number, patch: Partial<typeof scenarioRevisions.$inferInsert>): number {
  const row = getDB().insert(scenarioRevisions).values({
    releaseId,
    scenarioId: null,
    featureId: authId,
    kind: 'new',
    state: 'applied',
    beforeJson: null,
    afterJson: null,
    ...patch,
  }).run()
  return row.lastInsertRowid as number
}

/** The Task 10 sync outcome: one ai-only release with all four kinds. */
function seedAuthRelease(committedAt = '2026-11-02T09:30:00Z'): number {
  const releaseId = seedRelease({ committedAt })
  const hp4 = seedScenario({ code: 'HP-4', action: 'sign in with two-factor enforced', outcome: 'a second factor is asked for', sortOrder: 3 })
  const hp1 = seedScenario({ code: 'HP-1', sortOrder: 0 })
  seedRevision(releaseId, {
    kind: 'new',
    scenarioId: hp4,
    afterJson: snap('HP-4', 'sign in with two-factor enforced', 'a second factor is asked for'),
  })
  seedRevision(releaseId, {
    kind: 'changed',
    scenarioId: hp1,
    beforeJson: snap('HP-1', 'submit the login form', 'the session cookie is set'),
    afterJson: snap('HP-1', 'submit the login form', 'the session cookie slides its expiry forward'),
  })
  seedRevision(releaseId, {
    kind: 'fixed',
    scenarioId: hp1,
    beforeJson: snap('HP-1', 'open a protected page with an expired cookie', 'the expired cookie is accepted'),
    afterJson: snap('HP-1', 'open a protected page with an expired cookie', 'the session is rejected and login re-asked'),
  })
  seedRevision(releaseId, {
    kind: 'gone',
    scenarioId: null,
    beforeJson: snap('ER-3', 'open a protected page with a foreign-key cookie', 'the cookie is rejected'),
    afterJson: null,
  })
  return releaseId
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Changes Fixture',
    description: 'Exercises the releases APIs',
    createdAt: new Date().toISOString(),
  }).run().lastInsertRowid as number
  authId = db.insert(features).values({
    projectId,
    name: 'Authentication',
    description: 'Email and password login with signed session cookies.',
    sortOrder: 0,
    source: 'ai',
  }).run().lastInsertRowid as number
  tasksId = db.insert(features).values({
    projectId,
    name: 'Tasks',
    description: 'Creating and completing tasks.',
    sortOrder: 1,
    source: 'ai',
  }).run().lastInsertRowid as number
  db.insert(scenarios).values({
    featureId: tasksId,
    context: 'user on the tasks page',
    action: 'create a task',
    outcome: 'the task appears in the list',
    category: 'happy',
    code: 'HP-1',
    sortOrder: 0,
    source: 'ai',
  }).run()
  db.insert(repositories).values({
    projectId,
    owner: 'acme',
    repo: 'tasks',
    branch: 'main',
  }).run()
})

describe('listReleaseDays', () => {
  test('groups by UTC calendar day, newest day first, releases within a day newest first', () => {
    const morning = seedAuthRelease('2026-11-02T09:30:00Z')
    const evening = seedRelease({ committedAt: '2026-11-02T18:00:00Z', title: 'Later commit', highlight: 0 })
    seedRelease({ committedAt: '2026-10-30T08:00:00Z', title: 'Older commit', highlight: 0 })

    const days = listReleaseDays(projectId)

    expect(days.map((day) => day.date)).toEqual(['2026-11-02', '2026-10-30'])
    expect(days[0].releases.map((release) => release.id)).toEqual([evening, morning])
    expect(days[0].releases[0].counts).toEqual({ new: 0, changed: 0, gone: 0, fixed: 0 })
  })

  test('returns releases as DTOs with parsed authors and boolean highlight', () => {
    seedAuthRelease()

    const [day] = listReleaseDays(projectId)

    expect(day.releases[0]).toMatchObject({
      title: 'Tighter sign-in checks',
      category: 'security',
      highlight: true,
      authors: ['Grace Hopper'],
      committedAt: '2026-11-02T09:30:00Z',
    })
    expect(day.releases[0].counts).toEqual({ new: 1, changed: 1, gone: 1, fixed: 1 })
  })

  test('source=ai keeps releases whose revisions only involve ai rows (incl. applied gone without a live row and releases without revisions)', () => {
    const aiRelease = seedAuthRelease()
    // Applied `gone` rows have a null scenarioId (the row was deleted); the
    // sync only ever hard-deletes ai scenarios, so they classify as ai.
    const goneOnly = seedRelease({ committedAt: '2026-11-01T10:00:00Z', title: 'Gone only', highlight: 0 })
    seedRevision(goneOnly, { kind: 'gone', scenarioId: null, beforeJson: snap('ER-3', 'open a page', 'rejected') })
    const fallback = seedRelease({ committedAt: '2026-10-31T10:00:00Z', title: 'chore: bump deps', category: 'maintenance', highlight: 0, summary: 'chore: bump deps' })

    const days = listReleaseDays(projectId, { source: 'ai' })

    const ids = days.flatMap((day) => day.releases.map((release) => release.id))
    expect(ids).toEqual([aiRelease, goneOnly, fallback])
  })

  test('source=manual keeps releases that touch a manual scenario or carry a proposed revision', () => {
    seedAuthRelease()
    const manualTouch = seedRelease({ committedAt: '2026-11-01T10:00:00Z', title: 'Manual touch', highlight: 0 })
    const manualId = seedScenario({ code: 'HP-3', source: 'manual', sortOrder: 2 })
    seedRevision(manualTouch, {
      kind: 'fixed',
      scenarioId: manualId,
      beforeJson: snap('HP-3', 'reset a forgotten password', 'a reset email arrives'),
      afterJson: snap('HP-3', 'reset a forgotten password from the login page', 'the password form accepts the new one'),
    })
    // A proposed revision targets a manual scenario and changes nothing in
    // the spec — manual involvement by definition.
    const proposed = seedRelease({ committedAt: '2026-10-31T10:00:00Z', title: 'Proposal', highlight: 0 })
    seedRevision(proposed, {
      kind: 'changed',
      state: 'proposed',
      scenarioId: manualId,
      beforeJson: snap('HP-3', 'reset a forgotten password', 'a reset email arrives'),
      afterJson: snap('HP-3', 'reset a forgotten password', 'the reset email names the requesting device'),
    })

    const days = listReleaseDays(projectId, { source: 'manual' })

    const ids = days.flatMap((day) => day.releases.map((release) => release.id))
    expect(ids).toEqual([manualTouch, proposed])
  })

  test('feature filter keeps only releases with a revision on that feature', () => {
    const authRelease = seedAuthRelease()
    const tasksRelease = seedRelease({ committedAt: '2026-11-01T10:00:00Z', title: 'Tasks change', highlight: 0 })
    const taskScenario = getDB().select().from(scenarios).all().find((scenario) => scenario.featureId === tasksId)
    seedRevision(tasksRelease, {
      featureId: tasksId,
      kind: 'changed',
      scenarioId: taskScenario!.id,
      beforeJson: snap('HP-1', 'create a task', 'the task appears'),
      afterJson: snap('HP-1', 'create a task with a due date', 'the task appears with its due date'),
    })

    expect(listReleaseDays(projectId, { featureId: authId }).flatMap((day) => day.releases.map((release) => release.id)))
      .toEqual([authRelease])
    expect(listReleaseDays(projectId, { featureId: tasksId }).flatMap((day) => day.releases.map((release) => release.id)))
      .toEqual([tasksRelease])
  })

  test('q searches title and summary case-insensitively', () => {
    seedAuthRelease()
    seedRelease({
      committedAt: '2026-11-01T10:00:00Z',
      title: 'Tasks change',
      summary: 'The legacy TOKEN endpoint is gone.',
      highlight: 0,
    })

    expect(listReleaseDays(projectId, { q: 'tighter' }).flatMap((day) => day.releases.map((release) => release.title)))
      .toEqual(['Tighter sign-in checks'])
    expect(listReleaseDays(projectId, { q: 'TOKEN' }).flatMap((day) => day.releases.map((release) => release.title)))
      .toEqual(['Tasks change'])
    expect(listReleaseDays(projectId, { q: 'nothing-matches-this' })).toEqual([])
  })

  test('filters combine and stay scoped to the requested project', () => {
    seedAuthRelease()
    const otherProject = getDB().insert(projects).values({
      name: 'Other',
      description: 'Another project',
      createdAt: new Date().toISOString(),
    }).run().lastInsertRowid as number
    seedRelease({ projectId: otherProject, committedAt: '2026-11-03T10:00:00Z', title: 'Not this project', highlight: 0 })

    const days = listReleaseDays(projectId, { source: 'ai', q: 'sign-in' })

    expect(days.map((day) => day.date)).toEqual(['2026-11-02'])
    expect(days[0].releases).toHaveLength(1)
  })
})

describe('getReleaseDetail', () => {
  test('maps sections from the snapshots: new/fixed read afterJson, gone reads beforeJson, changed carries before', () => {
    const releaseId = seedAuthRelease()

    const detail = getReleaseDetail(releaseId)

    expect(detail).not.toBeNull()
    expect(detail!.title).toBe('Tighter sign-in checks')
    expect(detail!.sections.new).toEqual([{
      kind: 'new',
      state: 'applied',
      scenarioId: expect.any(Number),
      code: 'HP-4',
      featureName: 'Authentication',
      featureId: authId,
      action: 'sign in with two-factor enforced',
      outcome: 'a second factor is asked for',
    }])
    expect(detail!.sections.changed).toEqual([{
      kind: 'changed',
      state: 'applied',
      scenarioId: expect.any(Number),
      code: 'HP-1',
      featureName: 'Authentication',
      featureId: authId,
      action: 'submit the login form',
      outcome: 'the session cookie slides its expiry forward',
      before: { action: 'submit the login form', outcome: 'the session cookie is set' },
    }])
    expect(detail!.sections.fixed).toEqual([{
      kind: 'fixed',
      state: 'applied',
      scenarioId: expect.any(Number),
      code: 'HP-1',
      featureName: 'Authentication',
      featureId: authId,
      action: 'open a protected page with an expired cookie',
      outcome: 'the session is rejected and login re-asked',
      before: { action: 'open a protected page with an expired cookie', outcome: 'the expired cookie is accepted' },
    }])
    expect(detail!.sections.gone).toEqual([{
      kind: 'gone',
      state: 'applied',
      scenarioId: null,
      code: 'ER-3',
      featureName: 'Authentication',
      featureId: authId,
      action: 'open a protected page with a foreign-key cookie',
      outcome: 'the cookie is rejected',
    }])
  })

  test('serves a proposed revision with its proposal snapshot and the previous state', () => {
    const releaseId = seedRelease({ title: 'Proposal', highlight: 0 })
    const manualId = seedScenario({ code: 'HP-3', source: 'manual', sortOrder: 2 })
    seedRevision(releaseId, {
      kind: 'changed',
      state: 'proposed',
      scenarioId: manualId,
      beforeJson: snap('HP-3', 'reset a forgotten password', 'a reset email arrives'),
      afterJson: snap('HP-3', 'reset a forgotten password', 'the reset email names the requesting device'),
    })

    const detail = getReleaseDetail(releaseId)

    expect(detail!.sections.changed).toEqual([{
      kind: 'changed',
      state: 'proposed',
      scenarioId: manualId,
      code: 'HP-3',
      featureName: 'Authentication',
      featureId: authId,
      action: 'reset a forgotten password',
      outcome: 'the reset email names the requesting device',
      before: { action: 'reset a forgotten password', outcome: 'a reset email arrives' },
    }])
  })

  test('fallback release without revisions has empty sections', () => {
    const releaseId = seedRelease({
      title: 'chore: bump deps',
      category: 'maintenance',
      highlight: 0,
      summary: 'chore: bump deps',
    })

    const detail = getReleaseDetail(releaseId)

    expect(detail).toMatchObject({ title: 'chore: bump deps', category: 'maintenance', highlight: false })
    expect(detail!.sections).toEqual({ new: [], changed: [], gone: [], fixed: [] })
  })

  test('skips revision rows whose snapshots are missing (nothing renderable)', () => {
    const releaseId = seedRelease({ highlight: 0 })
    seedRevision(releaseId, { kind: 'new', scenarioId: 1, afterJson: null })

    const detail = getReleaseDetail(releaseId)

    expect(detail!.sections.new).toEqual([])
  })

  test('returns null for an unknown release id', () => {
    expect(getReleaseDetail(999999)).toBeNull()
  })
})

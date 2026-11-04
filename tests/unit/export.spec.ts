import { and, asc, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { analyses, connections, features, projects, releases, repositories, scenarios } from '../../server/db/schema'
import { runInitialAnalysis } from '../../server/services/analysis.service'
import { exportProjectMarkdown } from '../../server/services/export.service'
import { createManualScenario } from '../../server/services/spec.service'
import { fakeDeps } from './helpers/analysis-fakes'

/**
 * Export tests run the analysis pipeline on a :memory: database with the
 * shared analysis fakes, so the exported document is checked against the
 * same fixture world the spec UI and the map render: every feature heading,
 * every scenario line and every connection pair must survive the export.
 */

let projectId: number

beforeEach(async () => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Analysis Fixture',
    description: 'Pins the markdown export',
    createdAt: '2026-11-04T00:00:00.000Z',
  }).returning().get().id
  db.insert(repositories).values({
    projectId,
    owner: 'acme',
    repo: 'tasks',
    branch: 'main',
    patEncrypted: null,
    lastSyncedSha: null,
  }).run()
  const analysis = db.insert(analyses).values({
    projectId,
    type: 'initial',
    status: 'queued',
    progress: 0,
    step: 'queued',
    statsJson: '{}',
    error: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    finishedAt: null,
  }).returning().get()

  await runInitialAnalysis({ analysisId: analysis.id, projectId }, fakeDeps())
})

describe('exportProjectMarkdown', () => {
  test('covers every feature name, scenario code and connection pair of the stored project', async () => {
    const db = getDB()
    const featureRows = db.select().from(features).where(eq(features.projectId, projectId)).orderBy(asc(features.sortOrder)).all()
    const scenarioRows = db.select({ code: scenarios.code }).from(scenarios)
      .innerJoin(features, eq(scenarios.featureId, features.id))
      .where(eq(features.projectId, projectId)).all()
    const connectionRows = db.select().from(connections).where(eq(connections.projectId, projectId)).all()
    expect(featureRows).toHaveLength(6)
    expect(scenarioRows).toHaveLength(12)
    expect(connectionRows).toHaveLength(4)

    const { markdown, filename } = await exportProjectMarkdown(projectId)
    expect(filename).toBe('analysis-fixture.md')

    for (const feature of featureRows) {
      expect(markdown).toContain(feature.name)
    }
    // Every code, quoted the way the export renders them (the fixture's
    // short codes would substring-match otherwise).
    const missingCodes = scenarioRows.map((row) => row.code).filter((code) => !markdown.includes(`\`${code}\``))
    expect(missingCodes).toEqual([])

    // No releases exist in this fixture world, so the connections
    // appendix closes the document ('## Releases' renders only when the
    // project has any).
    expect(markdown).not.toContain('## Releases')
    const appendix = markdown.slice(markdown.indexOf('## How features connect'))
    const connectionLines = appendix.split('\n').filter((line) => line.startsWith('- '))
    expect(connectionLines).toEqual([
      '- Authentication — Authenticates → Tasks',
      '- Authentication — Shares data → Tasks',
      '- Login — Leads to → Task list',
      '- Tasks — Depends on → Authentication',
    ])
  })

  test('the release history appendix lists every release, newest first', async () => {
    const db = getDB()
    db.insert(releases).values([
      {
        projectId,
        repositoryId: db.select({ id: repositories.id }).from(repositories).get()!.id,
        sha: 'aaa111',
        title: 'Tighter sign-in checks',
        category: 'feature',
        highlight: 1,
        summary: 'Admin sign-in wants a second factor.',
        authorsJson: '["acme"]',
        message: 'Tighter sign-in checks',
        committedAt: '2026-11-02T10:00:00.000Z',
      },
      {
        projectId,
        repositoryId: db.select({ id: repositories.id }).from(repositories).get()!.id,
        sha: 'bbb222',
        title: 'Add tasks module',
        category: 'feature',
        highlight: 0,
        summary: 'The task list reached its first stable shape.',
        authorsJson: '["acme"]',
        message: 'Add tasks module',
        committedAt: '2026-11-03T09:00:00.000Z',
      },
    ]).run()

    const { markdown } = await exportProjectMarkdown(projectId)

    const releasesSection = markdown.slice(markdown.indexOf('## Releases'))
    expect(releasesSection).toContain('- Tighter sign-in checks (2026-11-02)')
    expect(releasesSection).toContain('- Add tasks module (2026-11-03)')
    // Newest first, so the latest release reads first.
    expect(releasesSection.indexOf('Add tasks module')).toBeLessThan(releasesSection.indexOf('Tighter sign-in checks'))
  })

  test('headings nest: project H1, top-level features H2, children H3, in spec order', async () => {
    const { markdown } = await exportProjectMarkdown(projectId)

    expect(markdown.startsWith('# Analysis Fixture\n')).toBe(true)
    expect(markdown).toMatch(
      /^_Generated by OpenSpecSight on \d{4}-\d{2}-\d{2}: 6 features · 12 scenarios · 4 connections\._$/m,
    )

    const positions = [
      markdown.indexOf('## Authentication'),
      markdown.indexOf('### Login'),
      markdown.indexOf('### Logout'),
      markdown.indexOf('## Tasks'),
      markdown.indexOf('### Task list'),
      markdown.indexOf('### Task lifecycle'),
    ]
    expect(positions.every((position) => position > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test('scenarios render as code + action → outcome under their owning feature, grouped by context', async () => {
    const db = getDB()
    const { markdown } = await exportProjectMarkdown(projectId)

    expect(markdown).toContain('**user on the login page**')
    expect(markdown).toContain('**user with an active session**')

    const first = db.select({ action: scenarios.action, outcome: scenarios.outcome }).from(scenarios)
      .innerJoin(features, eq(scenarios.featureId, features.id))
      .where(and(eq(features.projectId, projectId), eq(features.name, 'Authentication'), eq(scenarios.code, 'HP-1')))
      .get()
    expect(markdown).toContain(`- \`HP-1\` ${first!.action} → ${first!.outcome}`)

    const actions = db.select({ action: scenarios.action }).from(scenarios)
      .innerJoin(features, eq(scenarios.featureId, features.id))
      .where(eq(features.projectId, projectId)).all()
    for (const { action } of actions) {
      expect(markdown).toContain(action)
    }
  })

  test('an operator scenario on a child feature exports under that child', async () => {
    const db = getDB()
    const login = db.select().from(features).where(and(eq(features.projectId, projectId), eq(features.name, 'Login'))).get()
    createManualScenario(login!.id, {
      context: 'user locked out',
      action: 'request a magic link',
      outcome: 'the link lands in the mailbox',
      category: 'happy',
    })

    const { markdown } = await exportProjectMarkdown(projectId)

    expect(markdown).toContain('- `HP-1` request a magic link → the link lands in the mailbox')
    const loginHeading = markdown.indexOf('### Login')
    const manualLine = markdown.indexOf('user locked out')
    const nextHeading = markdown.indexOf('### Logout')
    expect(loginHeading).toBeGreaterThan(0)
    expect(manualLine).toBeGreaterThan(loginHeading)
    expect(manualLine).toBeLessThan(nextHeading)
  })

  test('the filename is a kebab-case ASCII slug of the project name', async () => {
    const db = getDB()
    const slugProject = db.insert(projects).values({
      name: 'Naïve Design — Über Draft (v2)',
      description: '',
      createdAt: '2026-11-04T00:00:00.000Z',
    }).returning().get().id

    const { filename } = await exportProjectMarkdown(slugProject)
    expect(filename).toBe('na-ve-design-ber-draft-v2.md')
    expect(/^[\x21-\x7E]+$/.test(filename)).toBe(true)
  })
})

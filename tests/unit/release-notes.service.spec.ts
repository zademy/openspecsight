import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import {
  features,
  jobs,
  projects,
  releaseNotes,
  releases,
  repositories,
  scenarioRevisions,
} from '../../server/db/schema'
import type { ContentBlocks } from '../../shared/types'
import { CreateReleaseNoteSchema } from '../../shared/schemas'
import {
  createVoice,
  deleteVoice,
  draftNote,
  listReleaseNotes,
  listVoices,
  NoteInProgressError,
  NoteScopeEmptyError,
  resolveNoteSelection,
  RevisionScopeMismatchError,
  runNoteDraft,
  setVoiceDefault,
  startNoteDraft,
  VoiceLimitReachedError,
  VoiceNameTakenError,
  VoiceNotFoundError,
} from '../../server/services/releaseNotes.service'
import type { LlmClient } from '../../server/services/llm.service'

/**
 * Voice and release-note tests run against a :memory: database seeded with
 * the rows a sync pipeline leaves behind (a release whose scenario revisions
 * carry action/outcome snapshots). The LLM stays out of the picture except
 * where stated: the fixture test lets draftNote build its default client
 * under LLM_MOCK=true, so the real `fixtures/llm/note-draft.json` must parse
 * against NoteDraftSchema for the test to pass; everything else scripts a
 * fake that records the prompt it was handed. Scope and voice errors are
 * thrown synchronously by resolveNoteSelection, before any LLM call —
 * submit-time refusals, not job-time failures.
 */

let projectId: number
let otherProjectId: number
let repositoryId: number
let authId: number

interface ScriptedLlm extends LlmClient {
  prompts: string[]
}

/** Scripts one draft for every generate call and records each prompt. */
function scriptedLlm(draft: { title: string, blocks: ContentBlocks }): ScriptedLlm {
  const prompts: string[] = []
  const client: ScriptedLlm = {
    prompts,
    async generate(_name, schema, prompt) {
      prompts.push(prompt)
      return schema.parse(draft) as never
    },
  }
  return client
}

function seedRevision(
  releaseId: number,
  featureId: number,
  kind: 'new' | 'changed' | 'gone' | 'fixed',
  display: { code: string, action: string, outcome: string },
): number {
  const json = JSON.stringify(display)
  return getDB().insert(scenarioRevisions).values({
    releaseId,
    scenarioId: null,
    featureId,
    kind,
    state: 'applied',
    // The state a release leaves the scenario in: removals keep the old
    // snapshot, every other kind reads the after snapshot.
    beforeJson: kind === 'gone' ? json : null,
    afterJson: kind === 'gone' ? null : json,
  }).run().lastInsertRowid as number
}

function seedRelease(over: { title: string, committedAt: string, projectId?: number }): number {
  return getDB().insert(releases).values({
    projectId: over.projectId ?? projectId,
    repositoryId,
    sha: `sha-${Math.random().toString(36).slice(2, 10)}`,
    title: over.title,
    category: 'feat',
    highlight: 0,
    summary: `${over.title} summary`,
    authorsJson: JSON.stringify(['Ada Lovelace']),
    message: over.title,
    committedAt: over.committedAt,
  }).run().lastInsertRowid as number
}

/** The mock-sync release: four Authentication revisions worth drafting about. */
function seedSyncRelease(): number {
  const releaseId = seedRelease({ title: 'Tighter sign-in checks', committedAt: '2026-11-02T09:30:00Z' })
  seedRevision(releaseId, authId, 'new', {
    code: 'HP-7',
    action: 'sign in with a valid password when two-factor authentication is enforced for admins',
    outcome: 'the user is asked for a second-factor code before any session cookie is set',
  })
  seedRevision(releaseId, authId, 'changed', {
    code: 'HP-1',
    action: 'submit the login form with a registered email and the correct password',
    outcome: 'the user lands on the tasks page and the session cookie expiry slides forward on each request',
  })
  seedRevision(releaseId, authId, 'fixed', {
    code: 'ED-1',
    action: 'open a protected page with an expired session cookie',
    outcome: 'the session is rejected server-side and the user is redirected to the login page',
  })
  seedRevision(releaseId, authId, 'gone', {
    code: 'ER-3',
    action: 'open a protected page with a cookie signed by a foreign key',
    outcome: 'the foreign-key cookie rejection was removed together with the legacy token endpoint',
  })
  return releaseId
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Notes Fixture',
    description: 'Exercises the release-note pipeline',
    createdAt: '2026-11-04T00:00:00Z',
  }).run().lastInsertRowid as number
  otherProjectId = db.insert(projects).values({
    name: 'Other Fixture',
    description: 'Owns voices of its own',
    createdAt: '2026-11-04T00:00:00Z',
  }).run().lastInsertRowid as number
  repositoryId = db.insert(repositories).values({
    projectId,
    owner: 'acme',
    repo: 'tasks',
    branch: 'main',
    patEncrypted: null,
    lastSyncedSha: null,
  }).run().lastInsertRowid as number
  authId = db.insert(features).values({
    projectId,
    name: 'Authentication',
    description: 'Email and password login.',
    sortOrder: 0,
    source: 'ai',
  }).run().lastInsertRowid as number
})

afterAll(() => {
  delete process.env.LLM_MOCK
})

describe('voices', () => {
  test('the first voice of a project lands as the default, later ones do not', () => {
    const first = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })
    const second = createVoice(projectId, { name: 'Warm', description: 'Friendly and encouraging.' })

    expect(first.isDefault).toBe(true)
    expect(second.isDefault).toBe(false)
    expect(listVoices(projectId).filter((voice) => voice.isDefault)).toHaveLength(1)
  })

  test('a fourth voice is refused', () => {
    createVoice(projectId, { name: 'One', description: 'First.' })
    createVoice(projectId, { name: 'Two', description: 'Second.' })
    createVoice(projectId, { name: 'Three', description: 'Third.' })

    expect(() => createVoice(projectId, { name: 'Four', description: 'Too many.' }))
      .toThrow(VoiceLimitReachedError)
    try {
      createVoice(projectId, { name: 'Four', description: 'Too many.' })
    } catch (error) {
      expect((error as Error).message).toBe('A project keeps up to three voices')
    }
  })

  test('voice names are unique per project, free across projects', () => {
    createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })

    expect(() => createVoice(projectId, { name: 'Changelog', description: 'Another one.' }))
      .toThrow(VoiceNameTakenError)
    const other = createVoice(otherProjectId, { name: 'Changelog', description: 'Fine over here.' })
    expect(other.name).toBe('Changelog')
  })

  test('listVoices returns the stored voices with id, name, description and isDefault', () => {
    const created = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })

    expect(listVoices(projectId)).toEqual([
      { id: created.id, name: 'Changelog', description: 'Terse and factual.', isDefault: true },
    ])
    expect(listVoices(otherProjectId)).toEqual([])
  })

  test('setting a default clears the previous one', () => {
    const first = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })
    const second = createVoice(projectId, { name: 'Warm', description: 'Friendly and encouraging.' })

    const updated = setVoiceDefault(projectId, second.id)
    expect(updated.isDefault).toBe(true)
    const voices = listVoices(projectId)
    expect(voices.find((voice) => voice.id === first.id)?.isDefault).toBe(false)
    expect(voices.filter((voice) => voice.isDefault)).toHaveLength(1)
  })

  test('setting a default on an unknown voice throws VoiceNotFoundError', () => {
    const voice = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })

    expect(() => setVoiceDefault(projectId, 424242)).toThrow(VoiceNotFoundError)
    // A voice id from another project is unknown here too.
    expect(() => setVoiceDefault(otherProjectId, voice.id)).toThrow(VoiceNotFoundError)
  })

  test('deleting the default voice leaves no default behind', () => {
    const defaultVoice = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })
    const kept = createVoice(projectId, { name: 'Warm', description: 'Friendly and encouraging.' })

    deleteVoice(projectId, defaultVoice.id)

    expect(listVoices(projectId).map((voice) => voice.id)).toEqual([kept.id])
    // No auto-redefault: notes fall back to the implicit "Default voice".
    expect(listVoices(projectId).filter((voice) => voice.isDefault)).toHaveLength(0)
  })

  test('deleting an unknown voice throws VoiceNotFoundError', () => {
    expect(() => deleteVoice(projectId, 424242)).toThrow(VoiceNotFoundError)
  })

  test('deleting a voice that notes reference nulls them onto the implicit Default voice', async () => {
    process.env.LLM_MOCK = 'true'
    const releaseId = seedSyncRelease()
    const voice = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })
    const noteId = await draftNote(projectId, { releaseId, voiceId: voice.id })
    expect(getDB().select().from(releaseNotes).where(eq(releaseNotes.id, noteId)).get()!.voiceId).toBe(voice.id)

    deleteVoice(projectId, voice.id)

    const row = getDB().select().from(releaseNotes).where(eq(releaseNotes.id, noteId)).get()
    expect(row).toBeTruthy()
    expect(row!.voiceId).toBeNull()
    expect(listVoices(projectId)).toEqual([])

    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'x' }] })
    const nextId = await draftNote(projectId, { releaseId }, { llm })
    expect(llm.prompts[0]).toContain('plain, factual, no exclamation')
    expect(getDB().select().from(releaseNotes).where(eq(releaseNotes.id, nextId)).get()!.voiceId).toBeNull()
  })
})

describe('scope resolution', () => {
  test('the request schema demands exactly one of releaseId or a full range', () => {
    expect(() => CreateReleaseNoteSchema.parse({ releaseId: 1, rangeFrom: '2026-11-01', rangeTo: '2026-11-02' })).toThrow()
    expect(() => CreateReleaseNoteSchema.parse({})).toThrow()
    expect(() => CreateReleaseNoteSchema.parse({ rangeFrom: '2026-11-01' })).toThrow()
    expect(() => CreateReleaseNoteSchema.parse({ rangeTo: '2026-11-02' })).toThrow()
    expect(() => CreateReleaseNoteSchema.parse({ rangeFrom: '2026-11-03', rangeTo: '2026-11-01' })).toThrow()

    expect(() => CreateReleaseNoteSchema.parse({ releaseId: 1 })).not.toThrow()
    expect(() => CreateReleaseNoteSchema.parse({ rangeFrom: '2026-11-01', rangeTo: '2026-11-02' })).not.toThrow()
    expect(() => CreateReleaseNoteSchema.parse({ releaseId: 1, voiceId: 2, revisionIds: [3, 4] })).not.toThrow()
  })

  test('a range without releases throws NoteScopeEmptyError', () => {
    seedRelease({ title: 'Old work', committedAt: '2026-10-01T10:00:00Z' })

    expect(() => resolveNoteSelection(projectId, { rangeFrom: '2026-10-28', rangeTo: '2026-11-04' }))
      .toThrow(NoteScopeEmptyError)
  })

  test('an unknown or foreign releaseId throws NoteScopeEmptyError', () => {
    const foreign = seedRelease({ title: 'Foreign work', committedAt: '2026-11-02T09:30:00Z', projectId: otherProjectId })

    expect(() => resolveNoteSelection(projectId, { releaseId: 424242 })).toThrow(NoteScopeEmptyError)
    expect(() => resolveNoteSelection(projectId, { releaseId: foreign })).toThrow(NoteScopeEmptyError)
  })

  test('revisionIds must be a subset of the revisions in scope; strangers are named', () => {
    const releaseId = seedSyncRelease()
    const scopedIds = getDB().select({ id: scenarioRevisions.id })
      .from(scenarioRevisions)
      .where(eq(scenarioRevisions.releaseId, releaseId))
      .all()
      .map((row) => row.id)
    const [first, , third] = scopedIds

    expect(() => resolveNoteSelection(projectId, { releaseId, revisionIds: [first!, 900001, 900002] }))
      .toThrow(RevisionScopeMismatchError)
    try {
      resolveNoteSelection(projectId, { releaseId, revisionIds: [first!, 900001, 900002] })
    } catch (error) {
      expect((error as Error).message).toContain('900001')
      expect((error as Error).message).toContain('900002')
      expect((error as Error).message).not.toContain(String(third))
    }
  })

  test('an unknown or foreign voiceId throws VoiceNotFoundError', () => {
    const releaseId = seedSyncRelease()
    const foreign = createVoice(otherProjectId, { name: 'Foreign', description: 'Not yours.' })

    expect(() => resolveNoteSelection(projectId, { releaseId, voiceId: 424242 })).toThrow(VoiceNotFoundError)
    expect(() => resolveNoteSelection(projectId, { releaseId, voiceId: foreign.id })).toThrow(VoiceNotFoundError)
  })
})

describe('draftNote', () => {
  test('stores the note-draft fixture verbatim with published 0 and unique slugs (mock mode)', async () => {
    process.env.LLM_MOCK = 'true'
    const releaseId = seedSyncRelease()

    const firstId = await draftNote(projectId, { releaseId })
    const secondId = await draftNote(projectId, { releaseId })
    const fixture = JSON.parse(
      await readFile(path.resolve(process.cwd(), 'fixtures', 'llm', 'note-draft.json'), 'utf8'),
    ) as { title: string, blocks: ContentBlocks }

    const first = getDB().select().from(releaseNotes).where(eq(releaseNotes.id, firstId)).get()
    expect(first).toBeTruthy()
    expect(first!.title).toBe(fixture.title)
    expect(JSON.parse(first!.blocksJson)).toEqual(fixture.blocks)
    expect(first!.published).toBe(0)
    expect(first!.voiceId).toBeNull()
    expect(first!.rangeFrom).toBe('2026-11-02')
    expect(first!.rangeTo).toBe('2026-11-02')

    const second = getDB().select().from(releaseNotes).where(eq(releaseNotes.id, secondId)).get()
    expect(second!.slug).not.toBe(first!.slug)
    expect(first!.slug).toMatch(/^tighter-sign-in-checks-[0-9a-f]{4}$/)

    const summaries = listReleaseNotes(projectId)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]!.id).toBe(secondId)
    expect(summaries[0]).toMatchObject({
      id: secondId,
      title: fixture.title,
      slug: second!.slug,
      rangeFrom: '2026-11-02',
      rangeTo: '2026-11-02',
      published: false,
    })
    expect(typeof summaries[0]!.createdAt).toBe('string')
  })

  test('a single release scopes the selection to that release and dates to its commit day', async () => {
    const releaseId = seedSyncRelease()
    const other = seedRelease({ title: 'Other day', committedAt: '2026-11-03T10:00:00Z' })
    seedRevision(other, authId, 'new', { code: 'HP-9', action: 'other action', outcome: 'other outcome' })
    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'What changed' }] })

    const noteId = await draftNote(projectId, { releaseId }, { llm })

    const row = getDB().select().from(releaseNotes).where(eq(releaseNotes.id, noteId)).get()
    expect(row!.rangeFrom).toBe('2026-11-02')
    expect(row!.rangeTo).toBe('2026-11-02')
    expect(llm.prompts.join('\n')).not.toContain('other action')
  })

  test('a date range scopes the selection to every release inside it', async () => {
    seedSyncRelease()
    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'What changed' }] })

    await draftNote(projectId, { rangeFrom: '2026-11-02', rangeTo: '2026-11-02' }, { llm })

    expect(llm.prompts[0]).toContain('Tighter sign-in checks')
    expect(llm.prompts[0]).toContain('second-factor code')
  })

  test('revisionIds narrow the selection the prompt is built from', async () => {
    const releaseId = seedSyncRelease()
    const scopedIds = getDB().select({ id: scenarioRevisions.id })
      .from(scenarioRevisions)
      .where(eq(scenarioRevisions.releaseId, releaseId))
      .all()
      .map((row) => row.id)
    const [first, , third] = scopedIds
    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'What changed' }] })

    await draftNote(projectId, { releaseId, revisionIds: [first!, third!] }, { llm })

    expect(llm.prompts[0]).toContain('second-factor code')
    expect(llm.prompts[0]).toContain('rejected server-side')
    expect(llm.prompts[0]).not.toContain('slides forward')
    expect(llm.prompts[0]).not.toContain('foreign key')
  })

  test('an explicit voice is recorded and its description feeds the prompt', async () => {
    const releaseId = seedSyncRelease()
    const voice = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })
    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'x' }] })

    const noteId = await draftNote(projectId, { releaseId, voiceId: voice.id }, { llm })

    const row = getDB().select().from(releaseNotes).where(eq(releaseNotes.id, noteId)).get()
    expect(row!.voiceId).toBe(voice.id)
    expect(llm.prompts[0]).toContain('Terse and factual.')
    expect(llm.prompts[0]).not.toContain('plain, factual')
  })

  test('without voiceId the project default feeds the prompt and is recorded', async () => {
    const releaseId = seedSyncRelease()
    createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })
    const defaultVoice = createVoice(projectId, { name: 'Warm', description: 'Friendly and encouraging.' })
    setVoiceDefault(projectId, defaultVoice.id)
    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'x' }] })

    const noteId = await draftNote(projectId, { releaseId }, { llm })

    const row = getDB().select().from(releaseNotes).where(eq(releaseNotes.id, noteId)).get()
    expect(row!.voiceId).toBe(defaultVoice.id)
    expect(llm.prompts[0]).toContain('Friendly and encouraging.')
    expect(llm.prompts[0]).not.toContain('plain, factual')
  })

  test('with no voices at all the implicit Default voice applies', async () => {
    const releaseId = seedSyncRelease()
    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'x' }] })

    const noteId = await draftNote(projectId, { releaseId }, { llm })

    const row = getDB().select().from(releaseNotes).where(eq(releaseNotes.id, noteId)).get()
    expect(row!.voiceId).toBeNull()
    expect(llm.prompts[0]).toContain('plain, factual, no exclamation')
  })

  test('the prompt names every revision with kind, action, outcome and feature, and demands complete coverage', async () => {
    const releaseId = seedSyncRelease()
    const voice = createVoice(projectId, { name: 'Steady', description: 'Steady, plain-spoken.' })
    const llm = scriptedLlm({ title: 'Note', blocks: [{ type: 'heading', text: 'x' }] })

    await draftNote(projectId, { releaseId, voiceId: voice.id }, { llm })

    const prompt = llm.prompts[0]
    expect(prompt).toContain('Steady, plain-spoken.')
    for (const needle of [
      'every',
      'Authentication',
      'new', 'changed', 'fixed', 'gone',
      'second-factor code', 'slides forward', 'rejected server-side', 'legacy token endpoint',
    ]) {
      expect(prompt).toContain(needle)
    }
  })
})

describe('startNoteDraft', () => {
  test('answers null for an unknown project', () => {
    expect(startNoteDraft(99999, { releaseId: 1 })).toBeNull()
  })

  test('enqueues a release-note job with the request as payload', () => {
    const releaseId = seedSyncRelease()

    const jobId = startNoteDraft(projectId, { releaseId })
    expect(jobId).not.toBeNull()
    const row = getDB().select().from(jobs).where(eq(jobs.id, jobId!)).get()
    expect(row!.type).toBe('release-note')
    expect(JSON.parse(row!.payloadJson)).toEqual({ projectId, releaseId })
  })

  test('a second queued or running note job for the project is refused', () => {
    const releaseId = seedSyncRelease()
    startNoteDraft(projectId, { releaseId })

    expect(() => startNoteDraft(projectId, { releaseId })).toThrow(NoteInProgressError)
  })

  test('empty scope and unknown voices are refused at submit time, not in the job', () => {
    expect(() => startNoteDraft(projectId, { rangeFrom: '2026-10-28', rangeTo: '2026-11-04' }))
      .toThrow(NoteScopeEmptyError)
    const releaseId = seedSyncRelease()
    expect(() => startNoteDraft(projectId, { releaseId, voiceId: 424242 }))
      .toThrow(VoiceNotFoundError)
  })
})

describe('runNoteDraft', () => {
  test('the job handler entry stores the note', async () => {
    seedSyncRelease()

    const noteId = await runNoteDraft({ projectId, rangeFrom: '2026-11-02', rangeTo: '2026-11-02' }, {
      llm: scriptedLlm({ title: 'Handled note', blocks: [{ type: 'heading', text: 'x' }] }),
    })

    expect(getDB().select().from(releaseNotes).where(eq(releaseNotes.id, noteId)).get()?.title).toBe('Handled note')
  })
})

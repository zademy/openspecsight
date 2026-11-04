import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { features, projects, releaseNotes, releases, repositories, scenarioRevisions } from '../../server/db/schema'
import { NoteEnhanceSchema, UpdateReleaseNoteSchema } from '../../shared/schemas'
import type { ContentBlocks } from '../../shared/types'
import { createVoice, draftNote, enhanceNoteBlock, NoteBlockNotEnhancableError, NoteBlockRangeError, NoteEnhanceEmptyError, updateReleaseNote, getReleaseNote } from '../../server/services/releaseNotes.service'
import type { LlmClient } from '../../server/services/llm.service'

/**
 * The editor's server side: the field-level autosave PATCH and the
 * per-block enhance. Like the voice spec, these run against a :memory:
 * database seeded through a scripted draft; the enhance LLM is always a
 * fake that records the prompt it was handed, so the voice-line contract
 * is pinned without any network. The fixture test is the one place the
 * real `fixtures/llm/note-enhance.json` is read.
 */

let projectId: number
let repositoryId: number
let authId: number

interface ScriptedEnhance extends LlmClient {
  prompts: string[]
}

/** Scripts one enhance answer and records each prompt. */
function scriptedEnhance(text: string): ScriptedEnhance {
  const prompts: string[] = []
  const client: ScriptedEnhance = {
    prompts,
    async generate(_name, schema, prompt) {
      prompts.push(prompt)
      return schema.parse({ text }) as never
    },
  }
  return client
}

/** Scripts the note-draft answer that seeds every test's note. */
function scriptedDraft(blocks: ContentBlocks): LlmClient {
  return {
    async generate(_name, schema, _prompt) {
      return schema.parse({ title: 'Tighter sign-in checks', blocks }) as never
    },
  }
}

const DRAFT_BLOCKS: ContentBlocks = [
  { type: 'heading', text: 'What changed' },
  { type: 'paragraph', text: 'This release tightens how admin sign-in works.' },
  { type: 'list', items: ['First item (Authentication).', 'Second item (Authentication).'] },
]

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
    beforeJson: kind === 'gone' ? json : null,
    afterJson: kind === 'gone' ? null : json,
  }).run().lastInsertRowid as number
}

/** One sync-shaped release with a couple of revisions, worth drafting about. */
function seedSyncRelease(): number {
  const releaseId = getDB().insert(releases).values({
    projectId,
    repositoryId,
    sha: `sha-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Tighter sign-in checks',
    category: 'feat',
    highlight: 0,
    summary: 'Tighter sign-in checks summary',
    authorsJson: JSON.stringify(['Ada Lovelace']),
    message: 'Tighter sign-in checks',
    committedAt: '2026-11-02T09:30:00Z',
  }).run().lastInsertRowid as number
  seedRevision(releaseId, authId, 'new', {
    code: 'HP-7',
    action: 'sign in with a valid password when two-factor authentication is enforced for admins',
    outcome: 'the user is asked for a second-factor code before any session cookie is set',
  })
  return releaseId
}

/** One scripted draft over the seeded release, with its id. */
async function draftedNote(voiceId?: number): Promise<number> {
  const releaseId = seedSyncRelease()
  return draftNote(
    projectId,
    voiceId ? { releaseId, voiceId } : { releaseId },
    { llm: scriptedDraft(DRAFT_BLOCKS) },
  )
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Notes Fixture',
    description: 'Exercises the release-note editor',
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

describe('UpdateReleaseNoteSchema', () => {
  test('accepts a title-only patch and trims it', () => {
    expect(UpdateReleaseNoteSchema.parse({ title: '  Renamed  ' })).toEqual({ title: 'Renamed' })
  })

  test('accepts a blocks-only patch', () => {
    const blocks = [{ type: 'paragraph', text: 'Handwritten.' }]
    expect(UpdateReleaseNoteSchema.parse({ blocks })).toEqual({ blocks })
  })

  test('rejects an empty body', () => {
    expect(() => UpdateReleaseNoteSchema.parse({})).toThrow()
  })

  test('rejects a blank title', () => {
    expect(() => UpdateReleaseNoteSchema.parse({ title: '   ' })).toThrow()
  })

  test('rejects blocks that cannot render', () => {
    expect(() => UpdateReleaseNoteSchema.parse({ blocks: [{ type: 'paragraph', text: '   ' }] })).toThrow()
    expect(() => UpdateReleaseNoteSchema.parse({ blocks: [{ type: 'list', items: [] }] })).toThrow()
  })
})

describe('updateReleaseNote', () => {
  test('a title-only patch saves the title and leaves the blocks untouched', async () => {
    const id = await draftedNote()
    const before = getReleaseNote(id)!

    const updated = updateReleaseNote(id, { title: 'Renamed by autosave' })

    expect(updated).not.toBeNull()
    expect(updated!.title).toBe('Renamed by autosave')
    expect(updated!.blocks).toEqual(before.blocks)
  })

  test('a blocks-only patch saves the blocks and leaves the title untouched', async () => {
    const id = await draftedNote()
    const blocks: ContentBlocks = [{ type: 'paragraph', text: 'Rewritten by hand.' }]

    const updated = updateReleaseNote(id, { blocks })

    expect(updated!.title).toBe('Tighter sign-in checks')
    expect(updated!.blocks).toEqual(blocks)
  })

  test('an unknown note answers null', async () => {
    expect(updateReleaseNote(424242, { title: 'Nothing here' })).toBeNull()
  })
})

describe('enhanceNoteBlock', () => {
  test('rewrites one paragraph in the note\'s voice and stores it with the title intact', async () => {
    const voice = createVoice(projectId, { name: 'Changelog', description: 'Terse and factual.' })
    const id = await draftedNote(voice.id)
    const llm = scriptedEnhance('Sign-in got stricter, and sessions now prove who you are twice.')

    const block = await enhanceNoteBlock(id, 1, undefined, { llm })

    expect(block).toEqual({ type: 'paragraph', text: 'Sign-in got stricter, and sessions now prove who you are twice.' })
    const stored = getReleaseNote(id)!
    expect(stored.title).toBe('Tighter sign-in checks')
    expect(stored.blocks[1]).toEqual({ type: 'paragraph', text: 'Sign-in got stricter, and sessions now prove who you are twice.' })
    expect(stored.blocks[0]).toEqual(DRAFT_BLOCKS[0])
    expect(stored.blocks[2]).toEqual(DRAFT_BLOCKS[2])
    // The prompt must carry the note's voice and the block being rewritten.
    expect(llm.prompts[0]).toContain('Terse and factual.')
    expect(llm.prompts[0]).toContain('This release tightens how admin sign-in works.')
  })

  test('an optional instruction lands in the prompt, and so does the default voice line', async () => {
    const id = await draftedNote()
    const llm = scriptedEnhance('Shorter.')

    await enhanceNoteBlock(id, 1, 'Shorter, fewer clauses', { llm })

    expect(llm.prompts[0]).toContain('Shorter, fewer clauses')
    expect(llm.prompts[0]).toContain('plain, factual, no exclamation')
  })

  test('heading blocks are refused without calling the LLM', async () => {
    const id = await draftedNote()
    const llm = scriptedEnhance('x')

    await expect(enhanceNoteBlock(id, 0, undefined, { llm })).rejects.toThrow(NoteBlockNotEnhancableError)
    expect(llm.prompts).toHaveLength(0)
    expect(getReleaseNote(id)!.blocks).toEqual(DRAFT_BLOCKS)
  })

  test('list blocks are refused without calling the LLM', async () => {
    const id = await draftedNote()
    const llm = scriptedEnhance('x')

    await expect(enhanceNoteBlock(id, 2, undefined, { llm })).rejects.toThrow(NoteBlockNotEnhancableError)
    expect(llm.prompts).toHaveLength(0)
    expect(getReleaseNote(id)!.blocks).toEqual(DRAFT_BLOCKS)
  })

  test('an out-of-range index is refused without calling the LLM', async () => {
    const id = await draftedNote()
    const llm = scriptedEnhance('x')

    await expect(enhanceNoteBlock(id, 3, undefined, { llm })).rejects.toThrow(NoteBlockRangeError)
    await expect(enhanceNoteBlock(id, -1, undefined, { llm })).rejects.toThrow(NoteBlockRangeError)
    expect(llm.prompts).toHaveLength(0)
  })

  test('an unknown note answers null', async () => {
    expect(await enhanceNoteBlock(424242, 0, undefined, { llm: scriptedEnhance('x') })).toBeNull()
  })

  test('corrupt stored blocks answer null', async () => {
    const id = await draftedNote()
    getDB().update(releaseNotes).set({ blocksJson: 'not json' }).where(eq(releaseNotes.id, id)).run()

    expect(await enhanceNoteBlock(id, 0, undefined, { llm: scriptedEnhance('x') })).toBeNull()
  })

  test('an empty rewrite is refused and stores nothing', async () => {
    const id = await draftedNote()
    const llm = scriptedEnhance('   ')

    await expect(enhanceNoteBlock(id, 1, undefined, { llm })).rejects.toThrow(NoteEnhanceEmptyError)
    expect(getReleaseNote(id)!.blocks).toEqual(DRAFT_BLOCKS)
  })
})

describe('note-enhance fixture', () => {
  test('the committed fixture parses against the schema', async () => {
    const raw = await readFile(path.join(import.meta.dirname, '../../fixtures/llm/note-enhance.json'), 'utf8')
    expect(NoteEnhanceSchema.safeParse(JSON.parse(raw)).success).toBe(true)
  })
})

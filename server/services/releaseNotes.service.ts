import { randomBytes } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDB } from '../db/client'
import { features, jobs, releaseNotes, releases, scenarioRevisions, voices } from '../db/schema'
import { CreateReleaseNoteSchema, NoteDraftSchema } from '../../shared/schemas'
import type {
  CreateReleaseNoteInput,
  CreateVoiceInput,
  NoteDraft,
  ReleaseNoteSummary,
  RevisionKind,
  Voice,
} from '../../shared/types'
import { enqueueJob } from './jobs.service'
import { createLlmClient, type LlmClient } from './llm.service'
import { projectExists } from './projects.service'
import { parseSnapshot } from './releases.service'

/**
 * Voices and release notes. Voices are named writing tones, at most three
 * per project; the first voice a project creates becomes its default, and
 * exactly one default is kept (setting a new one clears the old). Deleting
 * the default promotes nobody: existing notes recorded the voice id, and new
 * notes fall back to the implicit "Default voice", a tone that needs no row.
 *
 * Drafting resolves the scope synchronously — one release or all releases in
 * a committed-at date range, optionally narrowed to specific revisions — and
 * refuses an empty scope, strangers in `revisionIds` and unknown voices at
 * submit time, before any job exists. The `note-draft` LLM call receives the
 * voice line, the complete selection with kind, action, outcome and feature
 * name, and the demand for full coverage; the stored note keeps the validated
 * title and blocks under a `kebab(title)-4chars` slug, unpublished.
 */

const MAX_VOICES = 3

/** Prompt line for a note drafted without any stored voice. */
const DEFAULT_VOICE_LINE = 'plain, factual, no exclamation'

/** Error thrown when the project already has a queued or running note job. */
export class NoteInProgressError extends Error {
  constructor(
    readonly projectId: number,
  ) {
    super(`Project ${projectId} already has a queued or running release-note job`)
    this.name = 'NoteInProgressError'
  }
}

/** Error thrown when a fourth voice is requested. */
export class VoiceLimitReachedError extends Error {
  constructor(
    readonly projectId: number,
  ) {
    super('A project keeps up to three voices')
    this.name = 'VoiceLimitReachedError'
  }
}

/** Error thrown when a voice name is reused within one project. */
export class VoiceNameTakenError extends Error {
  constructor(
    readonly name: string,
  ) {
    super(`A voice named "${name}" already exists in this project`)
    this.name = 'VoiceNameTakenError'
  }
}

/** Error thrown when a voice id is unknown or belongs to another project. */
export class VoiceNotFoundError extends Error {
  constructor(
    readonly voiceId: number,
    readonly projectId: number,
  ) {
    super(`No voice with id ${voiceId} in project ${projectId}`)
    this.name = 'VoiceNotFoundError'
  }
}

/** Error thrown when the scope holds no draftable revisions. */
export class NoteScopeEmptyError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'NoteScopeEmptyError'
  }
}

/** Error thrown when revisionIds name revisions outside the resolved scope. */
export class RevisionScopeMismatchError extends Error {
  constructor(
    readonly strangerIds: number[],
    readonly scopeLabel: string,
  ) {
    super(`Revisions ${strangerIds.join(', ')} are not part of the scope (${scopeLabel})`)
    this.name = 'RevisionScopeMismatchError'
  }
}

// --- Voices ---

function voiceDTO(row: {
  id: number
  name: string
  description: string
  isDefault: number
}): Voice {
  return { id: row.id, name: row.name, description: row.description, isDefault: row.isDefault === 1 }
}

function getVoiceInProject(projectId: number, voiceId: number) {
  return getDB().select().from(voices)
    .where(and(eq(voices.id, voiceId), eq(voices.projectId, projectId)))
    .get()
}

/** The project's voices, oldest first. */
export function listVoices(projectId: number): Voice[] {
  return getDB().select().from(voices)
    .where(eq(voices.projectId, projectId))
    .orderBy(voices.id)
    .all()
    .map(voiceDTO)
}

/**
 * Creates a voice; the project's first voice lands as the default. Refuses a
 * fourth voice and a reused name, both with 409-class errors.
 */
export function createVoice(projectId: number, input: CreateVoiceInput): Voice {
  const db = getDB()
  const existing = db.select().from(voices).where(eq(voices.projectId, projectId)).all()
  if (existing.length >= MAX_VOICES) {
    throw new VoiceLimitReachedError(projectId)
  }
  if (existing.some((row) => row.name === input.name)) {
    throw new VoiceNameTakenError(input.name)
  }
  const row = db.insert(voices).values({
    projectId,
    name: input.name,
    description: input.description,
    isDefault: existing.length === 0 ? 1 : 0,
  }).returning().get()
  return voiceDTO(row)
}

/** Sets one voice as the project's default, clearing every other. */
export function setVoiceDefault(projectId: number, voiceId: number): Voice {
  const row = getVoiceInProject(projectId, voiceId)
  if (!row) {
    throw new VoiceNotFoundError(voiceId, projectId)
  }
  getDB().transaction((tx) => {
    tx.update(voices).set({ isDefault: 0 }).where(eq(voices.projectId, projectId)).run()
    tx.update(voices).set({ isDefault: 1 }).where(eq(voices.id, voiceId)).run()
  })
  return voiceDTO({ ...row, isDefault: 1 })
}

/**
 * Deletes a voice. Notes referencing it are moved to the implicit "Default
 * voice" (voiceId null) in the same transaction — the foreign key would
 * otherwise reject the delete — and nobody is promoted: the next note simply
 * drafts under the implicit Default voice.
 */
export function deleteVoice(projectId: number, voiceId: number): void {
  const row = getVoiceInProject(projectId, voiceId)
  if (!row) {
    throw new VoiceNotFoundError(voiceId, projectId)
  }
  getDB().transaction((tx) => {
    tx.update(releaseNotes).set({ voiceId: null }).where(eq(releaseNotes.voiceId, voiceId)).run()
    tx.delete(voices).where(eq(voices.id, voiceId)).run()
  })
}

// --- Selection ---

/** One revision as the note prompt describes it. */
export interface SelectedRevision {
  id: number
  kind: RevisionKind
  action: string
  outcome: string
  featureName: string
}

/** The resolved scope, selection and voice a note draft is built from. */
export interface NoteSelection {
  releaseIds: number[]
  releaseTitles: string[]
  rangeFrom: string
  rangeTo: string
  revisions: SelectedRevision[]
  /** The explicit or default voice; null drafts under the implicit Default voice. */
  voiceId: number | null
  voiceLine: string
}

interface ScopedReleases {
  rows: Array<{ id: number, title: string, committedAt: string }>
  rangeFrom: string
  rangeTo: string
}

/** One release, or every release whose commit day falls inside the range. */
function scopedReleases(projectId: number, input: CreateReleaseNoteInput): ScopedReleases {
  const rows = getDB().select({
    id: releases.id,
    title: releases.title,
    committedAt: releases.committedAt,
  }).from(releases).where(eq(releases.projectId, projectId)).all()

  if (input.releaseId !== undefined) {
    const release = rows.find((row) => row.id === input.releaseId)
    if (!release) {
      throw new NoteScopeEmptyError(`No release with id ${input.releaseId} in project ${projectId}; nothing to draft`)
    }
    const day = release.committedAt.slice(0, 10)
    return { rows: [release], rangeFrom: day, rangeTo: day }
  }

  const rangeFrom = input.rangeFrom!
  const rangeTo = input.rangeTo!
  const inRange = rows
    .filter((row) => {
      const day = row.committedAt.slice(0, 10)
      return day >= rangeFrom && day <= rangeTo
    })
    .sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.id - b.id)
  if (inRange.length === 0) {
    throw new NoteScopeEmptyError(`No releases between ${rangeFrom} and ${rangeTo}; nothing to draft`)
  }
  return { rows: inRange, rangeFrom, rangeTo }
}

/**
 * Resolves the note's scope, revision selection and voice synchronously.
 * Throws NoteScopeEmptyError for an unknown release or a scope without
 * revisions, RevisionScopeMismatchError when revisionIds name strangers, and
 * VoiceNotFoundError for an unknown voice — the 422/404 refusals the API
 * answers with at submit time.
 */
export function resolveNoteSelection(projectId: number, input: CreateReleaseNoteInput): NoteSelection {
  const db = getDB()
  const scope = scopedReleases(projectId, input)
  const releaseIds = scope.rows.map((row) => row.id)

  const revisionRows = db.select({ revision: scenarioRevisions, featureName: features.name })
    .from(scenarioRevisions)
    .innerJoin(features, eq(scenarioRevisions.featureId, features.id))
    .where(inArray(scenarioRevisions.releaseId, releaseIds))
    .all()

  if (input.revisionIds !== undefined) {
    const scopedIds = new Set(revisionRows.map((row) => row.revision.id))
    const strangers = input.revisionIds.filter((id) => !scopedIds.has(id))
    if (strangers.length > 0) {
      throw new RevisionScopeMismatchError(strangers, `${scope.rangeFrom} to ${scope.rangeTo}`)
    }
    const wanted = new Set(input.revisionIds)
    revisionRows.splice(0, revisionRows.length, ...revisionRows.filter((row) => wanted.has(row.revision.id)))
  }

  // The state a release leaves the scenario in: applied removals only keep
  // the old snapshot, every other kind reads the after snapshot.
  const revisions = revisionRows.flatMap(({ revision, featureName }) => {
    const display = parseSnapshot(revision.kind === 'gone' ? revision.beforeJson : revision.afterJson)
    if (!display) {
      return []
    }
    return [{
      id: revision.id,
      kind: revision.kind,
      action: display.action,
      outcome: display.outcome,
      featureName,
    }]
  })
  if (revisions.length === 0) {
    throw new NoteScopeEmptyError(
      `No scenario revisions for the selection between ${scope.rangeFrom} and ${scope.rangeTo}; nothing to draft`,
    )
  }

  let voiceId: number | null = null
  let voiceLine = DEFAULT_VOICE_LINE
  if (input.voiceId !== undefined) {
    const voice = getVoiceInProject(projectId, input.voiceId)
    if (!voice) {
      throw new VoiceNotFoundError(input.voiceId, projectId)
    }
    voiceId = voice.id
    voiceLine = voice.description
  } else {
    const defaultVoice = db.select().from(voices)
      .where(and(eq(voices.projectId, projectId), eq(voices.isDefault, 1)))
      .get()
    if (defaultVoice) {
      voiceId = defaultVoice.id
      voiceLine = defaultVoice.description
    }
  }

  return {
    releaseIds,
    releaseTitles: scope.rows.map((row) => row.title),
    rangeFrom: scope.rangeFrom,
    rangeTo: scope.rangeTo,
    revisions,
    voiceId,
    voiceLine,
  }
}

// --- Drafting ---

/** Dependency seams for note drafting; production builds the default client per call. */
export interface NoteDeps {
  llm?: LlmClient
}

function buildNotePrompt(selection: NoteSelection): string {
  return [
    'Draft a release note covering the scenario revisions listed below.',
    `Voice: ${selection.voiceLine}`,
    'Audience: people who use the product, not the engineers who built it.',
    `Scope: ${selection.revisions.length} revisions across ${selection.releaseIds.length} releases.`,
    'Cover every listed revision: a complete set, none left out.',
    '',
    `Releases covered: ${selection.releaseTitles.join('; ')}.`,
    '',
    ...selection.revisions.map(
      (revision) => `- ${revision.kind} (${revision.featureName}): ${revision.action} → ${revision.outcome}`,
    ),
    '',
    'Return a short title and a few content blocks: a heading, a short paragraph, one list naming each revision.',
  ].join('\n')
}

function kebabCase(title: string): string {
  const kebab = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return kebab || 'note'
}

/** kebab(title) plus a 4-char random suffix, regenerated on a collision. */
function uniqueSlug(title: string): string {
  const base = kebabCase(title)
  for (;;) {
    const candidate = `${base}-${randomBytes(2).toString('hex')}`
    const clash = getDB().select({ id: releaseNotes.id }).from(releaseNotes)
      .where(eq(releaseNotes.slug, candidate))
      .get()
    if (!clash) {
      return candidate
    }
  }
}

function storeNote(projectId: number, selection: NoteSelection, draft: NoteDraft): number {
  const row = getDB().insert(releaseNotes).values({
    projectId,
    title: draft.title,
    rangeFrom: selection.rangeFrom,
    rangeTo: selection.rangeTo,
    voiceId: selection.voiceId,
    blocksJson: JSON.stringify(draft.blocks),
    slug: uniqueSlug(draft.title),
    published: 0,
    createdAt: new Date().toISOString(),
  }).returning({ id: releaseNotes.id }).get()
  return row.id
}

/**
 * Generates and stores one note: resolve selection → `note-draft` LLM call →
 * row (title + validated blocks, unpublished, unique slug). Returns the note id.
 */
export async function draftNote(projectId: number, input: CreateReleaseNoteInput, deps?: NoteDeps): Promise<number> {
  const selection = resolveNoteSelection(projectId, input)
  const llm = deps?.llm ?? createLlmClient()
  const draft = await llm.generate('note-draft', NoteDraftSchema, buildNotePrompt(selection))
  return storeNote(projectId, selection, draft)
}

/**
 * The jobs handler entry for `release-note`: drafts from the enqueued
 * request. The queue's stale-job guard parks payloads whose project was
 * deleted before this runs.
 */
export async function runNoteDraft(payload: Record<string, unknown>, deps?: NoteDeps): Promise<number> {
  return draftNote(
    Number(payload.projectId),
    CreateReleaseNoteSchema.parse({
      releaseId: payload.releaseId,
      rangeFrom: payload.rangeFrom,
      rangeTo: payload.rangeTo,
      revisionIds: payload.revisionIds,
      voiceId: payload.voiceId,
    }),
    deps,
  )
}

// --- Queueing and listing ---

function payloadProjectId(payloadJson: string): number | null {
  try {
    const parsed = JSON.parse(payloadJson) as { projectId?: unknown }
    return typeof parsed.projectId === 'number' ? parsed.projectId : null
  } catch {
    return null
  }
}

function hasActiveNoteJob(projectId: number): boolean {
  const activeJobs = getDB().select({ payloadJson: jobs.payloadJson })
    .from(jobs)
    .where(and(eq(jobs.type, 'release-note'), inArray(jobs.status, ['queued', 'running'])))
    .all()
  return activeJobs.some((job) => payloadProjectId(job.payloadJson) === projectId)
}

/**
 * Enqueues a `release-note` job and answers with the job id. Returns null
 * when the project does not exist, throws NoteInProgressError when a note
 * job for the project is already `queued|running`, and resolves the scope
 * and voice up front so empty selections, strangers and unknown voices are
 * refused at submit time instead of failing inside the job.
 */
export function startNoteDraft(projectId: number, input: CreateReleaseNoteInput): number | null {
  if (!projectExists(projectId)) {
    return null
  }
  if (hasActiveNoteJob(projectId)) {
    throw new NoteInProgressError(projectId)
  }
  resolveNoteSelection(projectId, input)
  return enqueueJob('release-note', { projectId, ...input })
}

/** The project's notes, newest first. */
export function listReleaseNotes(projectId: number): ReleaseNoteSummary[] {
  return getDB().select({
    id: releaseNotes.id,
    title: releaseNotes.title,
    slug: releaseNotes.slug,
    rangeFrom: releaseNotes.rangeFrom,
    rangeTo: releaseNotes.rangeTo,
    published: releaseNotes.published,
    createdAt: releaseNotes.createdAt,
  }).from(releaseNotes)
    .where(eq(releaseNotes.projectId, projectId))
    .orderBy(desc(releaseNotes.createdAt), desc(releaseNotes.id))
    .all()
    .map((row) => ({ ...row, published: row.published === 1 }))
}

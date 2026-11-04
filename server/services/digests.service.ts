import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDB } from '../db/client'
import { digests, features, jobs, releases, scenarioRevisions } from '../db/schema'
import { ContentBlocksSchema, DigestDraftSchema } from '../../shared/schemas'
import { defaultDigestRange } from '../../shared/digest-range'
import type { ContentBlocks, DigestDetail, DigestSummary, ReleaseCounts } from '../../shared/types'
import { renderBlocksHtml, renderBlocksText } from '../utils/mailRenderer'
import { enqueueJob } from './jobs.service'
import { createLlmClient, type LlmClient } from './llm.service'
import { createMailService, MailNotConfiguredError, type MailService } from './mail.service'
import { projectExists } from './projects.service'

/**
 * Digests: a weekly (or on-demand) summary of what shipped. Generation
 * aggregates the releases inside a date range into counts and per-feature
 * highlights, hands them to the `digest-draft` LLM call and stores the
 * validated draft (title + content blocks) with `emailedAt` null — email
 * delivery is a separate step (Task 4) so a digest exists even when SMTP
 * is not configured.
 *
 * Ranges are `YYYY-MM-DD` dates compared against the calendar day of each
 * release's `committedAt`, boundaries inclusive.
 */

/** Error thrown when no release falls inside the requested range. */
export class DigestRangeEmptyError extends Error {
  constructor(
    readonly rangeFrom: string,
    readonly rangeTo: string,
  ) {
    super('No releases in that range; nothing to digest')
    this.name = 'DigestRangeEmptyError'
  }
}

/** Error thrown when the project already has a queued or running digest job. */
export class DigestInProgressError extends Error {
  constructor(
    readonly projectId: number,
  ) {
    super(`Project ${projectId} already has a queued or running digest`)
    this.name = 'DigestInProgressError'
  }
}

/** Error thrown when delivery is asked for a digest that does not exist. */
export class DigestNotFoundError extends Error {
  constructor(
    readonly digestId: number,
  ) {
    super(`No digest with id ${digestId}`)
    this.name = 'DigestNotFoundError'
  }
}

/** Error thrown when an already-emailed digest is sent again without `force`. */
export class DigestAlreadyEmailedError extends Error {
  constructor(
    readonly digestId: number,
  ) {
    super(`Digest ${digestId} was already emailed; pass force to send it again`)
    this.name = 'DigestAlreadyEmailedError'
  }
}

/** What the aggregation stage feeds the LLM prompt. */
export interface DigestAggregation {
  releaseCount: number
  releases: Array<{ title: string, category: string, summary: string, committedAt: string }>
  kinds: ReleaseCounts
  features: Array<{ name: string, titles: string[] }>
}

/** One project's outcome inside a weekly run. */
export interface WeeklyDigestOutcome {
  projectId: number
  /** The stored digest, or null when generation failed for this project. */
  digestId: number | null
  sent: boolean
  /** Why nothing went out; absent when the digest was emailed. */
  reason?: string
  /** Set when generation failed; other projects continue regardless. */
  error?: string
}

/** The result of one weekly scheduled run (or one disabled no-op). */
export interface WeeklyDigestRun {
  enabled: boolean
  rangeFrom: string
  rangeTo: string
  outcomes: WeeklyDigestOutcome[]
}

/** Dependency seams for tests; production builds the real client per call. */
export interface DigestDeps {
  llm?: LlmClient
}

function nowISO(): string {
  return new Date().toISOString()
}

/** Calendar day of a stored `committedAt`; ranges compare as plain strings. */
function committedDay(committedAt: string): string {
  return committedAt.slice(0, 10)
}

/** The project's releases whose commit day falls inside the range, oldest first. */
function releasesInRange(projectId: number, rangeFrom: string, rangeTo: string) {
  return getDB().select().from(releases).where(eq(releases.projectId, projectId)).all()
    .filter((row) => {
      const day = committedDay(row.committedAt)
      return day >= rangeFrom && day <= rangeTo
    })
    .sort((a, b) => a.committedAt.localeCompare(b.committedAt))
}

/**
 * Aggregates the range's releases and their scenario revisions into the
 * numbers the digest describes: release list, per-kind revision counts and
 * per-feature release titles. Throws DigestRangeEmptyError when the range
 * holds no releases — an empty digest would be either a lie or a stub.
 */
export function aggregateDigest(projectId: number, rangeFrom: string, rangeTo: string): DigestAggregation {
  const releaseRows = releasesInRange(projectId, rangeFrom, rangeTo)
  if (releaseRows.length === 0) {
    throw new DigestRangeEmptyError(rangeFrom, rangeTo)
  }

  const db = getDB()
  const revisionRows = db.select({
    releaseId: scenarioRevisions.releaseId,
    featureId: scenarioRevisions.featureId,
    kind: scenarioRevisions.kind,
  }).from(scenarioRevisions)
    .where(inArray(scenarioRevisions.releaseId, releaseRows.map((row) => row.id)))
    .all()

  const kinds: ReleaseCounts = { new: 0, changed: 0, gone: 0, fixed: 0 }
  const titlesByFeature = new Map<number, string[]>()
  for (const row of revisionRows) {
    kinds[row.kind] += 1
    const titles = titlesByFeature.get(row.featureId) ?? []
    const title = releaseRows.find((release) => release.id === row.releaseId)?.title
    if (title && !titles.includes(title)) {
      titles.push(title)
    }
    titlesByFeature.set(row.featureId, titles)
  }

  const featureNames = new Map(
    db.select({ id: features.id, name: features.name }).from(features).where(eq(features.projectId, projectId)).all()
      .map((row) => [row.id, row.name]),
  )
  const featureSummaries = [...titlesByFeature.keys()].sort((a, b) => a - b).map((featureId) => ({
    name: featureNames.get(featureId) ?? `Feature ${featureId}`,
    titles: titlesByFeature.get(featureId) ?? [],
  }))

  return {
    releaseCount: releaseRows.length,
    releases: releaseRows.map((row) => ({
      title: row.title,
      category: row.category,
      summary: row.summary,
      committedAt: row.committedAt,
    })),
    kinds,
    features: featureSummaries,
  }
}

/** The prompt behind the digest-draft call: the range's facts, nothing more. */
function buildPrompt(aggregation: DigestAggregation, rangeFrom: string, rangeTo: string): string {
  const lines = [
    `Write a short weekly digest covering ${rangeFrom} through ${rangeTo} for people who did not watch the repository.`,
    `${aggregation.releaseCount} ${aggregation.releaseCount === 1 ? 'release' : 'releases'} shipped:`,
    ...aggregation.releases.map((release) => `- ${release.title} (${release.category}): ${release.summary}`),
    `Scenario revisions: ${aggregation.kinds.new} new, ${aggregation.kinds.changed} changed, ${aggregation.kinds.gone} gone, ${aggregation.kinds.fixed} fixed.`,
    ...aggregation.features.map((feature) => `${feature.name}: ${feature.titles.join(', ')}`),
    'Return a plain-spoken title and a few content blocks (a heading, short paragraphs, one list) that name releases and features as written above.',
  ]
  return lines.join('\n')
}

/**
 * Generates and stores one digest: aggregate → `digest-draft` LLM call →
 * row (title + validated blocks, `emailedAt` null). Returns the digest id.
 * Throws DigestRangeEmptyError when the range holds no releases.
 */
export async function generateDigest(projectId: number, rangeFrom: string, rangeTo: string, deps?: DigestDeps): Promise<number> {
  const aggregation = aggregateDigest(projectId, rangeFrom, rangeTo)
  const llm = deps?.llm ?? createLlmClient()
  const draft = await llm.generate('digest-draft', DigestDraftSchema, buildPrompt(aggregation, rangeFrom, rangeTo), { projectId })

  const row = getDB().insert(digests).values({
    projectId,
    rangeFrom,
    rangeTo,
    title: draft.title,
    blocksJson: JSON.stringify(draft.blocks),
    emailedAt: null,
    createdAt: nowISO(),
  }).returning().get()
  return row.id
}

/** The jobs-queue handler entry: coerces the loosely-typed payload and generates. */
export async function runDigest(payload: { projectId: number, rangeFrom: string, rangeTo: string }, deps?: DigestDeps): Promise<number> {
  return generateDigest(Number(payload.projectId), String(payload.rangeFrom), String(payload.rangeTo), deps)
}

/** Best-effort projectId out of a stored job payload; NaN when malformed. */
function safeProjectId(payloadJson: string): number {
  try {
    return Number((JSON.parse(payloadJson) as { projectId?: unknown }).projectId)
  } catch {
    return Number.NaN
  }
}

/**
 * Starts a digest for the project: checks the range has something to digest,
 * enqueues the `digest` job and answers with the job id. Returns `null` when
 * the project does not exist, throws DigestInProgressError when a digest job
 * for the project is already `queued|running`, and DigestRangeEmptyError when
 * the range holds no releases (the 422 the API maps — honest feedback at
 * submit time instead of a job that can only fail). The UI polls the digest
 * list until a new row appears; digests carry no analyses progress row.
 */
export function startDigest(projectId: number, rangeFrom?: string, rangeTo?: string): number | null {
  const db = getDB()
  if (!projectExists(projectId)) {
    return null
  }

  const activeJobs = db.select({ id: jobs.id, payloadJson: jobs.payloadJson })
    .from(jobs)
    .where(and(eq(jobs.type, 'digest'), inArray(jobs.status, ['queued', 'running'])))
    .all()
  if (activeJobs.some((job) => safeProjectId(job.payloadJson) === projectId)) {
    throw new DigestInProgressError(projectId)
  }

  const defaults = defaultDigestRange()
  const from = rangeFrom ?? defaults.rangeFrom
  const to = rangeTo ?? defaults.rangeTo
  aggregateDigest(projectId, from, to)

  return enqueueJob('digest', { projectId, rangeFrom: from, rangeTo: to })
}

/** The project's digests, newest first. */
export function listDigests(projectId: number): DigestSummary[] {
  return getDB().select({
    id: digests.id,
    title: digests.title,
    rangeFrom: digests.rangeFrom,
    rangeTo: digests.rangeTo,
    emailedAt: digests.emailedAt,
    createdAt: digests.createdAt,
  }).from(digests).where(eq(digests.projectId, projectId)).orderBy(desc(digests.id)).all()
}

/**
 * Parses stored blocks; null when the row is missing or the JSON has drifted
 * from ContentBlocksSchema. The only writer stores a schema-validated draft,
 * so a parse failure means a corrupt row — surfaced as a 404 upstream, the
 * same defensive shape as the release detail's snapshot parsing.
 */
function parseBlocks(raw: string): ContentBlocks | null {
  try {
    const parsed = ContentBlocksSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** One digest with its parsed blocks; null when unknown (or corrupt). */
export function getDigest(id: number): DigestDetail | null {
  const row = getDB().select().from(digests).where(eq(digests.id, id)).get()
  if (!row) {
    return null
  }
  const blocks = parseBlocks(row.blocksJson)
  if (!blocks) {
    return null
  }
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    rangeFrom: row.rangeFrom,
    rangeTo: row.rangeTo,
    blocks,
    emailedAt: row.emailedAt,
    createdAt: row.createdAt,
  }
}

/** The projects that shipped at least one release inside the range, ascending. */
export function projectsWithReleasesInRange(rangeFrom: string, rangeTo: string): number[] {
  const rows = getDB().select({ projectId: releases.projectId, committedAt: releases.committedAt }).from(releases).all()
  return [...new Set(
    rows
      .filter((row) => {
        const day = committedDay(row.committedAt)
        return day >= rangeFrom && day <= rangeTo
      })
      .map((row) => row.projectId),
  )].sort((a, b) => a - b)
}

/** Dependency seams for email delivery; production builds the SMTP service per call. */
export interface DeliverDigestDeps {
  mail?: MailService
  /** Re-send an already-emailed digest (updates emailedAt). */
  force?: boolean
}

/**
 * Emails one digest to DIGEST_RECIPIENTS (comma-separated, trimmed). The
 * blocks go through the mail renderer as text + html; the subject is the
 * digest title. Every "not sent" answer is honest and specific, and a
 * refused or failed delivery never stamps `emailedAt`: no recipients or no
 * SMTP config answer `{ sent: false, reason: ... }`, an already-emailed
 * digest throws unless `force` re-sends, and only a real transport success
 * stamps the time. Unexpected send failures propagate — callers decide
 * whether that is fatal (API → 500) or per-project (weekly run).
 */
export async function deliverDigest(digestId: number, deps?: DeliverDigestDeps): Promise<{ sent: boolean, reason?: string }> {
  const digest = getDigest(digestId)
  if (!digest) {
    throw new DigestNotFoundError(digestId)
  }
  if (digest.emailedAt && !deps?.force) {
    throw new DigestAlreadyEmailedError(digestId)
  }

  const recipients = (process.env.DIGEST_RECIPIENTS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '')
  if (recipients.length === 0) {
    return { sent: false, reason: 'DIGEST_RECIPIENTS is not set' }
  }

  const mail = deps?.mail ?? createMailService()
  try {
    await mail.send({
      to: recipients,
      subject: digest.title,
      text: renderBlocksText(digest.blocks),
      html: renderBlocksHtml(digest.blocks),
    })
  } catch (error) {
    if (error instanceof MailNotConfiguredError) {
      return { sent: false, reason: 'SMTP is not configured' }
    }
    throw error
  }

  getDB().update(digests).set({ emailedAt: nowISO() }).where(eq(digests.id, digestId)).run()
  return { sent: true }
}

/**
 * One weekly run: the default window (today plus the seven days before it,
 * eight days inclusive — see shared/digest-range), every project that
 * shipped something. `enabled` defaults to the runtime check the scheduled
 * task performs (DIGEST_WEEKLY_ENABLED === 'true'), so a deployment without
 * the flag set never sends anything. One project failing does not stop the
 * others.
 */
export async function runWeeklyDigests(deps?: DigestDeps & { enabled?: boolean }): Promise<WeeklyDigestRun> {
  const enabled = deps?.enabled ?? process.env.DIGEST_WEEKLY_ENABLED === 'true'
  const { rangeFrom, rangeTo } = defaultDigestRange()
  if (!enabled) {
    return { enabled: false, rangeFrom, rangeTo, outcomes: [] }
  }

  const outcomes: WeeklyDigestOutcome[] = []
  for (const projectId of projectsWithReleasesInRange(rangeFrom, rangeTo)) {
    // Generation and delivery report separately — one honest reason each,
    // and a delivery failure still names the digest it produced.
    let digestId: number
    try {
      digestId = await generateDigest(projectId, rangeFrom, rangeTo, { llm: deps?.llm })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcomes.push({ projectId, digestId: null, sent: false, reason: 'digest generation failed', error: message })
      continue
    }
    try {
      const delivery = await deliverDigest(digestId)
      outcomes.push({ projectId, digestId, sent: delivery.sent, reason: delivery.reason })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcomes.push({ projectId, digestId, sent: false, reason: 'digest delivery failed', error: message })
    }
  }
  return { enabled: true, rangeFrom, rangeTo, outcomes }
}

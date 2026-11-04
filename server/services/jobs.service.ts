import { asc, eq, inArray } from 'drizzle-orm'
import { getDB } from '../db/client'
import { jobs } from '../db/schema'
import { projectExists } from './projects.service'

/**
 * Durable jobs queue over the `jobs` table. Producers call enqueueJob(); a
 * Nitro task (`jobs:run`) drains the queue by claiming rows with an atomic
 * `UPDATE ... WHERE status = 'queued' ... RETURNING`, so two workers can never
 * run the same row. Handlers register per job type and receive the parsed
 * payload; a handler that throws gets the job requeued until MAX_ATTEMPTS is
 * reached, then the row parks as `error` with the stored message.
 */

export type JobPayload = Record<string, unknown>
export type JobHandler = (payload: JobPayload) => Promise<void>

const MAX_ATTEMPTS = 3

/** Note stored on jobs whose payload projectId no longer exists. */
const PROJECT_DELETED_NOTE = 'project deleted'

/** Serialize claims around the registry map (populated at plugin time). */
const handlers = new Map<string, JobHandler>()

/** Registers the handler that runs a job of `type`. Last registration wins. */
export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler)
}

/** Persists a queued job and returns its id. */
export function enqueueJob(type: string, payload: JobPayload): number {
  const db = getDB()
  const row = db.insert(jobs).values({
    type,
    payloadJson: JSON.stringify(payload),
    status: 'queued',
    attempts: 0,
    error: null,
    createdAt: nowISO(),
    finishedAt: null,
  }).returning().get()
  return row.id
}

interface ClaimedJob {
  id: number
  type: string
  payloadJson: string
  attempts: number
}

/**
 * Atomically claims the oldest queued job: the `UPDATE ... RETURNING` runs as
 * a single SQLite statement that only matches `status = 'queued'`, so a row
 * already claimed (status `running`) can never be handed out twice, whatever
 * the number of concurrent callers.
 */
function claimNextJob(): ClaimedJob | null {
  const db = getDB()
  const oldestQueued = db.select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.status, 'queued'))
    .orderBy(asc(jobs.id))
    .limit(1)
  const [claimed] = db.update(jobs)
    .set({ status: 'running' })
    .where(inArray(jobs.id, oldestQueued))
    .returning({
      id: jobs.id,
      type: jobs.type,
      payloadJson: jobs.payloadJson,
      attempts: jobs.attempts,
    })
    .all()
  return claimed ?? null
}

/**
 * Claims and processes up to `limit` queued jobs, oldest first. Returns how
 * many claims were made (a retried job counts once per attempt).
 */
export async function processNextJobs(limit = 5): Promise<number> {
  let processed = 0
  for (let index = 0; index < limit; index += 1) {
    const job = claimNextJob()
    if (!job) {
      break
    }
    await runClaimedJob(job)
    processed += 1
  }
  return processed
}

async function runClaimedJob(job: ClaimedJob): Promise<void> {
  const db = getDB()
  try {
    const payload = JSON.parse(job.payloadJson) as JobPayload
    if (projectIsDeleted(payload)) {
      // Stale-job guard: the project (and its analyses) were cascade-deleted
      // after this job was enqueued. Park it as `done` with a note instead of
      // retrying work that can never succeed.
      db.update(jobs).set({
        status: 'done', error: PROJECT_DELETED_NOTE, finishedAt: nowISO(),
      }).where(eq(jobs.id, job.id)).run()
      return
    }

    const handler = handlers.get(job.type)
    if (!handler) {
      throw new Error(`No job handler registered for "${job.type}"`)
    }

    await handler(payload)
    db.update(jobs).set({
      status: 'done', error: null, finishedAt: nowISO(),
    }).where(eq(jobs.id, job.id)).run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const attempts = job.attempts + 1
    const parked = attempts >= MAX_ATTEMPTS
    db.update(jobs).set({
      status: parked ? 'error' : 'queued',
      attempts,
      error: message,
      finishedAt: parked ? nowISO() : null,
    }).where(eq(jobs.id, job.id)).run()
  }
}

/** True when the payload carries a projectId that no longer exists. */
function projectIsDeleted(payload: JobPayload): boolean {
  const projectId = Number(payload.projectId)
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return false
  }
  return !projectExists(projectId)
}

/**
 * Fire-and-forget trigger asking this server to drain the queue through the
 * `jobs:run` Nitro task endpoint. Intentionally not awaited — enqueueing must
 * stay fast, and processing failures surface in the job rows. If the kick
 * fails, queued jobs stay durable until the next kick or a manual
 * `npx nuxt task run jobs:run`.
 */
export function kickJobProcessing(origin: string): void {
  void fetch(new URL('/_nitro/tasks/jobs:run', origin), { method: 'POST' }).catch(() => {
    // Leftover jobs remain queued; the next enqueue or manual task run drains them.
  })
}

function nowISO(): string {
  return new Date().toISOString()
}

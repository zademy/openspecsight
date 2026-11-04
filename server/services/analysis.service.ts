import { eq } from 'drizzle-orm'
import { getDB } from '../db/client'
import { analyses } from '../db/schema'
import type { JobPayload } from './jobs.service'

/**
 * The initial-analysis pipeline. Task 7 ships the skeleton (queued → running
 * → done so the queue can be exercised end to end); Task 8 replaces the noop
 * middle section with the real GitHub scan + LLM pipeline. The jobs layer
 * only ever calls this one function, so the swap stays trivial.
 */

/** Progress reported while the real pipeline prepares its inputs. */
const PREPARING_PROGRESS = 5

export async function runInitialAnalysis(payload: JobPayload): Promise<void> {
  const analysisId = Number(payload.analysisId)
  if (!Number.isInteger(analysisId) || analysisId <= 0) {
    throw new Error(`initial-analysis job payload has no valid analysisId: ${String(payload.analysisId)}`)
  }

  const db = getDB()
  const analysis = db.select({ id: analyses.id })
    .from(analyses)
    .where(eq(analyses.id, analysisId))
    .get()
  if (!analysis) {
    // The analysis row is gone (its project was deleted after enqueueing).
    // Nothing to update; the queue's stale-project guard ends the job.
    return
  }

  db.update(analyses).set({
    status: 'running', progress: PREPARING_PROGRESS, step: 'preparing',
  }).where(eq(analyses.id, analysisId)).run()

  // Noop pipeline — Task 8 replaces this with the real implementation.
  db.update(analyses).set({
    status: 'done',
    progress: 100,
    step: 'done',
    statsJson: '{}',
    error: null,
    finishedAt: nowISO(),
  }).where(eq(analyses.id, analysisId)).run()
}

function nowISO(): string {
  return new Date().toISOString()
}

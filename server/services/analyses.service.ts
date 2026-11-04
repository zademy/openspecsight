import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDB } from '../db/client'
import { analyses } from '../db/schema'
import { enqueueJob } from './jobs.service'
import { projectExists } from './projects.service'
import type { AnalysisProgress } from '../../shared/types'

/**
 * Analysis row lifecycle for the API layer: starting an initial analysis
 * creates the `analyses` row, enqueues its `initial-analysis` job and guards
 * against concurrent analyses per project. The job's actual work lives in
 * analysis.service (runInitialAnalysis).
 */

/** Error thrown when the project already has a queued or running analysis. */
export class AnalysisInProgressError extends Error {
  constructor(
    readonly projectId: number,
  ) {
    super(`Project ${projectId} already has a queued or running analysis`)
    this.name = 'AnalysisInProgressError'
  }
}

/**
 * Creates the queued `initial` analysis row and enqueues its job. Returns the
 * analysis id, `null` when the project does not exist, and throws
 * AnalysisInProgressError when a queued or running analysis already exists.
 */
export function startInitialAnalysis(projectId: number): number | null {
  const db = getDB()
  if (!projectExists(projectId)) {
    return null
  }

  const active = db.select({ id: analyses.id })
    .from(analyses)
    .where(and(
      eq(analyses.projectId, projectId),
      inArray(analyses.status, ['queued', 'running']),
    ))
    .get()
  if (active) {
    throw new AnalysisInProgressError(projectId)
  }

  const analysis = db.insert(analyses).values({
    projectId,
    type: 'initial',
    status: 'queued',
    progress: 0,
    step: 'queued',
    statsJson: '{}',
    error: null,
    createdAt: nowISO(),
    finishedAt: null,
  }).returning().get()

  enqueueJob('initial-analysis', { analysisId: analysis.id, projectId })
  return analysis.id
}

/** Latest analysis of the project (newest id first), or null when there is none. */
export function getLatestAnalysis(projectId: number): AnalysisProgress | null {
  const db = getDB()
  const row = db.select()
    .from(analyses)
    .where(eq(analyses.projectId, projectId))
    .orderBy(desc(analyses.id))
    .get()
  if (!row) {
    return null
  }
  return { status: row.status, progress: row.progress, step: row.step, error: row.error }
}

function nowISO(): string {
  return new Date().toISOString()
}

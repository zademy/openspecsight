import { runInitialAnalysis } from '../services/analysis.service'
import { runSync } from '../services/sync.service'
import { registerJobHandler, sweepInterruptedJobs } from '../services/jobs.service'

/**
 * Registers every job handler this app knows. The initial-analysis pipeline
 * lives in analysis.service (repo scan → LLM spec build); the incremental
 * sync pipeline lives in sync.service (diff → revisions → release). The
 * queue hands loosely-typed JSON payloads, so each registration coerces the
 * known fields before calling in. Before any handler runs, jobs a crashed
 * process left `running` are requeued or parked, so a restart can never
 * leave a project permanently 409-blocked behind a phantom job.
 */
export default defineNitroPlugin(() => {
  sweepInterruptedJobs()
  registerJobHandler('initial-analysis', (payload) => runInitialAnalysis({
    analysisId: Number(payload.analysisId),
    projectId: Number(payload.projectId),
  }))
  registerJobHandler('sync', async (payload) => {
    // The release id matters to direct callers only; the queue needs the job's
    // completion, not its value.
    await runSync({ projectId: Number(payload.projectId) })
  })
})

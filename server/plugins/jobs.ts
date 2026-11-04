import { runInitialAnalysis } from '../services/analysis.service'
import { runDigest } from '../services/digests.service'
import { runNoteDraft } from '../services/releaseNotes.service'
import { runSync } from '../services/sync.service'
import { recoverAfterRestart, registerJobHandler } from '../services/jobs.service'

/**
 * Registers every job handler this app knows, then recovers from a restart.
 * The initial-analysis pipeline lives in analysis.service (repo scan → LLM
 * spec build); the incremental sync pipeline lives in sync.service (diff →
 * revisions → release); digest generation lives in digests.service
 * (aggregate → LLM draft → row). The queue hands loosely-typed JSON
 * payloads, so each registration coerces the known fields before calling
 * in. Handlers register before recovery runs: recovery requeues jobs a
 * crashed process left `running`, errors the analyses rows those jobs
 * orphaned, and kicks the queue once so the requeued jobs drain — a kicked
 * job claims itself immediately and must find its handler registered.
 */
export default defineNitroPlugin(() => {
  registerJobHandler('initial-analysis', (payload) => runInitialAnalysis({
    analysisId: Number(payload.analysisId),
    projectId: Number(payload.projectId),
  }))
  registerJobHandler('sync', async (payload) => {
    // The release id matters to direct callers only; the queue needs the job's
    // completion, not its value.
    await runSync({ projectId: Number(payload.projectId) })
  })
  registerJobHandler('digest', async (payload) => {
    // The digest id matters to the weekly task only; the queue needs the job's
    // completion. A payload whose project was deleted is parked by the queue's
    // stale-job guard before this handler runs.
    await runDigest({
      projectId: Number(payload.projectId),
      rangeFrom: String(payload.rangeFrom),
      rangeTo: String(payload.rangeTo),
    })
  })
  registerJobHandler('release-note', async (payload) => {
    // The note id matters to direct callers only; the queue needs the job's
    // completion.
    await runNoteDraft(payload)
  })
  recoverAfterRestart(runTask)
})

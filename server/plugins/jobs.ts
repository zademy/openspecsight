import { runInitialAnalysis } from '../services/analysis.service'
import { registerJobHandler } from '../services/jobs.service'

/**
 * Registers every job handler this app knows. The initial-analysis pipeline
 * lives in analysis.service (repo scan → LLM spec build); the queue hands it
 * loosely-typed JSON payloads, so the registration coerces the two known
 * fields before calling in. The `sync` handler arrives with Task 10.
 */
export default defineNitroPlugin(() => {
  registerJobHandler('initial-analysis', (payload) => runInitialAnalysis({
    analysisId: Number(payload.analysisId),
    projectId: Number(payload.projectId),
  }))
})

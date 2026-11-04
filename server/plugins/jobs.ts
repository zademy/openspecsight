import { runInitialAnalysis } from '../services/analysis.service'
import { registerJobHandler } from '../services/jobs.service'

/**
 * Registers every job handler this app knows. Task 8 will replace the noop
 * runInitialAnalysis body with the real pipeline without touching this file;
 * the `sync` handler arrives with Task 10.
 */
export default defineNitroPlugin(() => {
  registerJobHandler('initial-analysis', runInitialAnalysis)
})

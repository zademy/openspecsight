import { processNextJobs } from '../../services/jobs.service'

/**
 * Drains up to five queued jobs through their registered handlers. The
 * analyses API fires this off after enqueueing (fire-and-forget kick), and it
 * can also be run by hand via `npx nuxt task run jobs:run`. No schedule is
 * configured: the queue only runs when there is something to do.
 */
export default defineTask({
  meta: {
    name: 'jobs:run',
    description: 'Claim queued jobs and run them through their registered handlers',
  },
  async run() {
    const processed = await processNextJobs(5)
    return { result: { processed } }
  },
})

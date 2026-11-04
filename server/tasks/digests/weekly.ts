import { runWeeklyDigests } from '../../services/digests.service'

/**
 * The weekly digest run, Monday 09:00 server time (nuxt.config's
 * scheduledTasks). The schedule is config, but sending is not: the run
 * no-ops unless DIGEST_WEEKLY_ENABLED is exactly 'true' in the serving
 * environment, so a deployment opts in per instance and nothing goes out
 * from a forgotten checkout. Projects without releases in the past week
 * are skipped; one project failing does not stop the others. It can also
 * be run by hand: `npx nuxt task run digests:weekly`.
 */
export default defineTask({
  meta: {
    name: 'digests:weekly',
    description: 'Generate (and, once Task 4 wires delivery, email) a weekly digest for every project with releases in the past week',
  },
  async run() {
    const run = await runWeeklyDigests()
    return { result: run }
  },
})

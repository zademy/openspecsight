import { runInitialAnalysis } from '../services/analysis.service'
import { registerJobHandler } from '../services/jobs.service'

/**
 * Registers every job handler this app knows. Task 8 will replace the noop
 * runInitialAnalysis body with the real pipeline without touching this file;
 * the `sync` handler arrives with Task 10.
 */
export default defineNitroPlugin((nitroApp) => {
  registerJobHandler('initial-analysis', runInitialAnalysis)

  // Nitro only exposes /_nitro/tasks/:name on the dev server; production
  // builds register no task routes at all. Mirror the dev runner here so the
  // fire-and-forget kick from the analyses API drains the queue on the built
  // server too (the e2e suite runs the build). Same URL, same payload rules
  // as the dev endpoint.
  if (!import.meta.dev) {
    nitroApp.router.use('/_nitro/tasks/:name', defineEventHandler(async (event) => {
      const name = getRouterParam(event, 'name')
      if (!name) {
        throw createError({ statusCode: 404, statusMessage: 'Task not found' })
      }
      const body = await readBody(event).catch(() => undefined) as { payload?: Record<string, unknown> } | undefined
      const payload = { ...getQuery(event), ...body?.payload }
      return await runTask(name, { payload })
    }))
  }
})

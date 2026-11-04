import { cpSync } from 'node:fs'
import { join } from 'node:path'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: [
    '@nuxt/ui',
    '@nuxt/eslint',
  ],

  components: [
    // Filenames already carry their domain (project/CreateProjectModal.vue);
    // the default path prefix would register awkward, mismatched tags like
    // <ProjectCreateProjectModal> while ProjectCard stays unprefixed.
    { path: '~/components', pathPrefix: false },
  ],

  css: ['~/assets/css/main.css'],

  app: {
    head: {
      title: 'OpenSpecSight',
    },
  },

  nitro: {
    experimental: {
      // Scan server/tasks/** into runnable Nitro tasks (nitropack 2.x gates
      // tasks behind this flag). jobs:run drains the queue; digests:weekly
      // runs the Monday-morning digest (the task itself checks
      // DIGEST_WEEKLY_ENABLED at runtime and no-ops when it is not 'true').
      tasks: true,
    },
    scheduledTasks: {
      // Monday 09:00, server time. The flag gate lives in the task body, so
      // the schedule is honest about when it would run even when disabled.
      '0 9 * * 1': ['digests:weekly'],
    },
    hooks: {
      // Drizzle migrations are read from disk at runtime (server/db/client.ts
      // resolves them by walking up from its own module), which the bundled
      // server alone cannot satisfy: copy them next to the server entry so
      // production builds can apply them. Dev builds are skipped. The same
      // applies to fixtures/llm, which the mock LLM reads from disk and
      // `nuxt preview` would otherwise not find (its cwd is .output).
      compiled(nitro) {
        if (nitro.options.dev) {
          return
        }
        cpSync('server/db/migrations', join(nitro.options.output.serverDir, 'db', 'migrations'), { recursive: true })
        cpSync('fixtures', join(nitro.options.output.dir, 'fixtures'), { recursive: true })
      },
    },
  },
})

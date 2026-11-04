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
    hooks: {
      // Drizzle migrations are read from disk at runtime (server/db/client.ts
      // resolves them by walking up from its own module), which the bundled
      // server alone cannot satisfy: copy them next to the server entry so
      // production builds can apply them. Dev builds are skipped.
      compiled(nitro) {
        if (nitro.options.dev) {
          return
        }
        cpSync('server/db/migrations', join(nitro.options.output.serverDir, 'db', 'migrations'), { recursive: true })
      },
    },
  },
})

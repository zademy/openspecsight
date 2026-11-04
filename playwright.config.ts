import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Production build instead of `pnpm dev`: the dev server's request bridge
    // can drop a JSON body that arrives mid-SSR-render (readBody then hangs and
    // pins the whole server), which flaked automated logins. Production Nitro
    // serves requests on a plain http server and does not use that bridge.
    // Start the built bundle with node directly (no CLI layer). reuseExistingServer
    // is false on purpose: a dev/preview server left on :3000 (e.g. with a real
    // .env) silently serves the suite and every auth-dependent test fails —
    // this bit twice (2026-11-03/04, see docs/superpowers/ledgers).
    command: 'pnpm build && node .output/server/index.mjs',
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      LLM_MOCK: 'true',
      AUTH_PASSWORD: 'test-pass',
      SESSION_SECRET: 'test-secret',
      DATABASE_PATH: './data/test-e2e.db',
      GITHUB_API_BASE: 'http://127.0.0.1:9876',
    },
  },
})

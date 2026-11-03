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
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      LLM_MOCK: 'true',
      AUTH_PASSWORD: 'test-pass',
      SESSION_SECRET: 'test-secret',
      DATABASE_PATH: './data/test-e2e.db',
      GITHUB_API_BASE: 'http://127.0.0.1:9876',
    },
  },
})

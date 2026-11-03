import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.spec.ts',
      'shared/**/*.spec.ts',
    ],
    // The suite starts empty; unit tests are added by later tasks.
    passWithNoTests: true,
  },
})

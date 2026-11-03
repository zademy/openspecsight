import { describe, expect, test } from 'vitest'
import { registerGithubRoutes, startGithubStub, stopGithubStub, type GithubStubHandle } from '../helpers/github-stub'

// Distinct test port: the fixed 9876 belongs to the Playwright global-setup
// stub, and unit tests must never collide with it across processes.
const TEST_PORT = 19876

async function withStub(run: (handle: GithubStubHandle) => Promise<void>): Promise<void> {
  const handle = await startGithubStub({ port: TEST_PORT })
  try {
    await run(handle)
  } finally {
    await stopGithubStub()
  }
}

describe('github-stub', () => {
  test('unmatched paths return the GitHub 404 JSON shape', async () => {
    await withStub(async (handle) => {
      const response = await fetch(`${handle.baseUrl}/repos/acme/tasks`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ message: 'Not Found' })
    })
  })

  test('a throwing route handler yields a 500 JSON response instead of an unhandled rejection', async () => {
    registerGithubRoutes({
      method: 'GET',
      pattern: '/boom',
      handler: () => {
        throw new Error('boom')
      },
    })

    // If the stub let this rejection escape, Node would terminate the process
    // (unhandled rejection) and this test would die instead of passing.
    await withStub(async (handle) => {
      const response = await fetch(`${handle.baseUrl}/boom`)
      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.message).toBe('stub error')
      expect(body.error).toContain('boom')
    })
  })
})

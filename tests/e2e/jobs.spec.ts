import { expect, test, type Page } from '@playwright/test'

/**
 * Jobs queue end to end against the production build: POST analyses answers
 * 202 immediately, the fire-and-forget kick runs the `jobs:run` Nitro task
 * in-process (nitro's own /_nitro/tasks/* routes exist on the dev server only,
 * and the built server must not expose them), and the noop initial-analysis
 * pipeline drives the row to done. The 409-while-active guard is pinned in
 * unit tests — the noop finishes in milliseconds, too fast to race from e2e.
 *
 * Like projects.spec.ts, the GitHub stub answers `acme/tasks` and the created
 * project is deleted afterwards to keep the persistent e2e database clean.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Password').fill('test-pass')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('http://localhost:3000/')
}

interface AnalysisProgress {
  status: string
  progress: number
  step: string
  error: string | null
}

test.describe('jobs queue', () => {
  test('starting an analysis returns 202 and the noop pipeline completes it', async ({ page }) => {
    await login(page)

    const listResponse = await page.request.get('/api/projects')
    const existing = (await listResponse.json()) as Array<{ id: number, name: string }>
    for (const stale of existing.filter((p) => p.name === 'Job Queue Fixture')) {
      await page.request.delete(`/api/projects/${stale.id}`)
    }

    const createResponse = await page.request.post('/api/projects', {
      data: {
        name: 'Job Queue Fixture',
        description: 'Exercises the jobs queue end to end',
        owner: 'acme',
        repo: 'tasks',
      },
    })
    expect(createResponse.status()).toBe(201)
    const project = (await createResponse.json()) as { id: number }

    try {
      const beforeResponse = await page.request.get(`/api/projects/${project.id}/analyses`)
      expect(await beforeResponse.json()).toBeNull()

      const startResponse = await page.request.post(`/api/projects/${project.id}/analyses`)
      expect(startResponse.status()).toBe(202)
      const { analysisId } = (await startResponse.json()) as { analysisId: number }
      expect(Number.isInteger(analysisId)).toBe(true)

      await expect.poll(async () => {
        const progressResponse = await page.request.get(`/api/projects/${project.id}/analyses`)
        return (await progressResponse.json()) as AnalysisProgress
      }, { timeout: 15_000 }).toMatchObject({ status: 'done', progress: 100, error: null })

      // The built server must not expose the task runner over HTTP: the kick
      // runs the task in-process, and nitro's own /_nitro/tasks/* routes exist
      // on the dev server only. If the route existed, this would answer 200
      // with the task result instead of the app's 404 error page.
      const taskMirror = await page.request.post('/_nitro/tasks/jobs:run')
      expect(taskMirror.status()).toBe(404)
    } finally {
      await page.request.delete(`/api/projects/${project.id}`)
    }
  })
})

import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress } from '../../shared/types'

/**
 * Initial analysis end to end against the production build: the stub GitHub
 * serves the acme/tasks pipeline fixtures (see tests/helpers/github-fixtures
 * and fixtures/github/), LLM_MOCK answers with the Task 4 fixtures, and the
 * project overview must surface both the live progress (against the delayed
 * acme/slowpoke repo) and the final stats badge. Created projects are deleted
 * afterwards to keep the persistent e2e database clean.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Password').fill('test-pass')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('http://localhost:3000/')
}

async function deleteProjectsByName(page: Page, name: string): Promise<void> {
  const response = await page.request.get('/api/projects')
  const projects = (await response.json()) as Array<{ id: number, name: string }>
  for (const stale of projects.filter((p) => p.name === name)) {
    await page.request.delete(`/api/projects/${stale.id}`)
  }
}

/** Creates a project over the API and returns its id. */
async function createProject(page: Page, name: string, description: string, repo: string): Promise<number> {
  await deleteProjectsByName(page, name)
  const createResponse = await page.request.post('/api/projects', {
    data: { name, description, owner: 'acme', repo },
  })
  expect(createResponse.status()).toBe(201)
  const project = (await createResponse.json()) as { id: number }
  return project.id
}

test.describe('initial analysis', () => {
  test('the pipeline builds the spec and the overview shows the final stats', async ({ page }) => {
    await login(page)
    const projectId = await createProject(page, 'Analysis Fixture', 'Exercises the initial analysis pipeline end to end', 'tasks')

    try {
      await page.goto(`/projects/${projectId}`)
      await expect(page.getByText('No analysis has run yet.', { exact: false })).toBeVisible()

      const start = await page.request.post(`/api/projects/${projectId}/analyses`)
      expect(start.status()).toBe(202)

      // The overview polls the analyses endpoint; once the pipeline reaches
      // done, the human summary and the stats badge replace the empty state.
      await expect(page.getByText('Initial analysis finished.', { exact: false })).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText('6 features · 12 scenarios · 7 files')).toBeVisible()

      const progress = await page.request.get(`/api/projects/${projectId}/analyses`)
      const body = (await progress.json()) as AnalysisProgress
      expect(body.status).toBe('done')
      expect(body.progress).toBe(100)
      expect(body.stats).toEqual({ features: 6, scenarios: 12, files: 7 })
    } finally {
      await deleteProjectsByName(page, 'Analysis Fixture')
    }
  })

  test('the overview shows live progress while the pipeline reads the repository', async ({ page }) => {
    await login(page)
    const projectId = await createProject(page, 'Slow Scan Fixture', 'Watches the analysis run against a slow upstream', 'slowpoke')

    try {
      const start = await page.request.post(`/api/projects/${projectId}/analyses`)
      expect(start.status()).toBe(202)

      // slowpoke's first blob read is delayed 5 s in the stub, so the page
      // must catch the running state: progress bar plus the concrete step.
      await page.goto(`/projects/${projectId}`)
      await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 5_000 })
      await expect(page.getByText('Reading the repository…')).toBeVisible({ timeout: 5_000 })

      await expect(page.getByText('6 features · 12 scenarios · 2 files')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('progressbar')).toHaveCount(0)
    } finally {
      await deleteProjectsByName(page, 'Slow Scan Fixture')
    }
  })
})

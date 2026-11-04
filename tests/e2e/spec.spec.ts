import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress, FeatureNode } from '../../shared/types'

/**
 * Product spec end to end on top of the Task 8 analysis state: the stub
 * GitHub serves acme/tasks, LLM_MOCK answers with the fixtures, and the spec
 * must present the resulting tree and scenario groups, filter them by
 * category, and accept operator edits — a manual scenario (source manual,
 * next HP code) plus an annotation. The project is deleted afterwards to
 * keep the persistent e2e database clean.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/login')
  // Hydration re-mounts the form and resets the password input from state —
  // wait until the client app owns the DOM, or an early fill gets wiped and
  // sign-in submits an empty password.
  await page.waitForFunction(() => {
    const nuxtApp = (window as unknown as { useNuxtApp?: () => { isHydrating: boolean } }).useNuxtApp
    return nuxtApp?.().isHydrating === false
  })
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

/** Creates the project and runs its initial analysis to a terminal `done`. */
async function createAnalyzedProject(page: Page): Promise<number> {
  await deleteProjectsByName(page, 'Spec Fixture')
  const create = await page.request.post('/api/projects', {
    data: { name: 'Spec Fixture', description: 'Exercises the product spec UI', owner: 'acme', repo: 'tasks' },
  })
  expect(create.status()).toBe(201)
  const projectId = ((await create.json()) as { id: number }).id

  const start = await page.request.post(`/api/projects/${projectId}/analyses`)
  expect(start.status()).toBe(202)

  await expect.poll(async () => {
    const progress = await page.request.get(`/api/projects/${projectId}/analyses`)
    return ((await progress.json()) as AnalysisProgress).status
  }, { timeout: 20_000 }).toBe('done')

  return projectId
}

test.describe('product spec', () => {
  test('the feature tree, scenario groups, category filter, manual scenarios and annotations work together', async ({ page }) => {
    await login(page)
    const projectId = await createAnalyzedProject(page)

    try {
      // The tree lists the fixture features with their scenario counts,
      // including the zero-scenario sub-features. (The accessible name
      // carries the trailing count, so match by substring.)
      await page.goto(`/projects/${projectId}/spec`)
      const authItem = page.getByRole('treeitem', { name: 'Authentication' })
      await expect(authItem).toBeVisible()
      await expect(authItem.getByText('6 scenarios')).toBeVisible()
      await expect(page.getByRole('treeitem', { name: 'Login' }).getByText('0 scenarios')).toBeVisible()

      // The same shape the API promises, for the navigation below.
      const treeResponse = await page.request.get(`/api/projects/${projectId}/features`)
      const tree = (await treeResponse.json()) as FeatureNode[]
      const auth = tree.find((feature) => feature.name === 'Authentication')
      expect(auth?.scenarioCount).toBe(6)

      // Opening a feature shows its groups with the "context + action →
      // outcome" rows and the stable codes.
      await authItem.click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/${auth!.id}$`))
      await expect(page.getByText('user on the login page')).toBeVisible()
      await expect(page.getByText('user with an active session')).toBeVisible()
      await expect(page.getByText('HP-1', { exact: true })).toBeVisible()

      // Filtering by category keeps only the happy rows (HP-*).
      await page.getByRole('button', { name: 'Happy', exact: true }).click()
      await expect(page.getByText('HP-1', { exact: true })).toBeVisible()
      await expect(page.getByText('HP-2', { exact: true })).toBeVisible()
      await expect(page.getByText('ER-1', { exact: true })).toBeHidden()
      await expect(page.getByText('ED-1', { exact: true })).toBeHidden()
      await page.getByRole('button', { name: 'All', exact: true }).click()

      // A manual scenario joins the feature with the next happy code and a
      // manual source badge.
      await page.getByRole('button', { name: 'Add scenario' }).click()
      await page.getByLabel('Context').fill('user on the login page')
      await page.getByLabel('Action').fill('submit the login form with a magic link')
      await page.getByLabel('Outcome').fill('the user is signed in without a password')
      await page.getByRole('button', { name: 'Create scenario' }).click()

      const manualRow = page.locator('[id^="scenario-"]', { hasText: 'HP-3' })
      await expect(manualRow).toBeVisible()
      await expect(manualRow.getByText('manual', { exact: true })).toBeVisible()

      // An operator note attaches to the scenario and shows up in its list.
      await manualRow.getByRole('button', { name: 'Notes' }).click()
      await manualRow.getByLabel('Add a note').fill('Support asked about this case')
      await manualRow.getByRole('button', { name: 'Add note' }).click()
      await expect(manualRow.getByText('Support asked about this case')).toBeVisible()
    } finally {
      await deleteProjectsByName(page, 'Spec Fixture')
    }
  })
})

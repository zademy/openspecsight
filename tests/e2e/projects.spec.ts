import { expect, test } from '@playwright/test'

/**
 * The Playwright webServer env points GITHUB_API_BASE at the stub from
 * tests/helpers/github-stub.ts: `acme/tasks` exists there with default branch
 * `main`, `acme/missing` answers GitHub's 404 shape. DATABASE_PATH persists
 * across runs, so the created project is deleted through the API at the end —
 * which doubles as e2e coverage for DELETE /api/projects/:id.
 */
async function deleteTaskManagerProjects(page: import('@playwright/test').Page): Promise<void> {
  const response = await page.request.get('/api/projects')
  const projects = (await response.json()) as Array<{ id: number, name: string }>

  for (const project of projects.filter((p) => p.name === 'Task Manager')) {
    await page.request.delete(`/api/projects/${project.id}`)
  }
}

test.describe('projects', () => {
  test('creating a project lists it without ever exposing the PAT and opens its overview', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Password').fill('test-pass')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL('http://localhost:3000/')

    await deleteTaskManagerProjects(page)

    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByLabel('Name').fill('Task Manager')
    await page.getByLabel('Description').fill('Track the spec of the task manager product')
    await page.getByLabel('Owner').fill('acme')
    await page.getByLabel('Repository').fill('tasks')
    // Branch stays empty so the server defaults it to the repo's default
    // branch; the PAT stays empty because the stub repo is public.
    await page.getByRole('button', { name: 'Create project' }).click()

    const card = page.getByRole('link', { name: /Task Manager/ }).first()
    await expect(card).toBeVisible()
    await expect(card).toContainText('acme/tasks')

    // The list response must not carry the encrypted PAT — not even its field
    // name. `patEncrypted` would trip this substring match.
    const listResponse = await page.request.get('/api/projects')
    expect(listResponse.status()).toBe(200)
    expect(await listResponse.text()).not.toContain('pat')

    // The card leads to the project overview with repo info and rail nav.
    await card.click()
    await expect(page).toHaveURL(/\/projects\/\d+$/)
    // The URL flips before the list DOM swaps, and a parallel worker's
    // card shows acme/tasks too; hold for the overview's own heading
    // first so the repo assert resolves to exactly the overview's item.
    await expect(page.getByRole('heading', { name: 'Task Manager', level: 1 })).toBeVisible()
    await expect(page.getByText('acme/tasks', { exact: true })).toBeVisible()
    await expect(page.getByText('main', { exact: true })).toBeVisible()
    for (const railItem of ['Overview', 'Changes', 'Product spec']) {
      await expect(page.getByText(railItem, { exact: true })).toBeVisible()
    }

    // Delete through the API, then reload: the fresh SSR list must not show
    // the project anymore, proving the cascade actually persisted.
    await deleteTaskManagerProjects(page)
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Task Manager/ })).toHaveCount(0)
  })

  test('an unknown repository shows a clear error and creates nothing', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Password').fill('test-pass')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL('http://localhost:3000/')

    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByLabel('Name').fill('Broken')
    await page.getByLabel('Description').fill('Should never be created')
    await page.getByLabel('Owner').fill('acme')
    await page.getByLabel('Repository').fill('missing')
    await page.getByRole('button', { name: 'Create project' }).click()

    await expect(page.getByText(/acme\/missing was not found on GitHub/)).toBeVisible()
    await expect(page.getByRole('link', { name: /Broken/ })).toHaveCount(0)
  })
})

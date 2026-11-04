import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress, FeatureNode } from '../../shared/types'

/**
 * Changes end to end, continuing the Task 10 sync flow in the UI: analysis
 * done, one manual scenario, the stub serves the extra commit, sync runs —
 * then the overview must show the release under its day heading with the
 * counts motif, the changes list must filter by feature, and the release
 * detail must link "View in spec" onto the live scenario anchor (deep link
 * ruling: group expanded, row scrolled into view and focused). Stub state
 * and fixture project are restored afterwards. The repo is `acme/changes`,
 * a fixture alias of `tasks` with its own stub state — parallel workers
 * flip states independently.
 */
const STUB_ADMIN = 'http://127.0.0.1:9876/_admin/state'
const PROJECT_NAME = 'Changes Fixture'

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

async function setStubState(page: Page, state: 'initial' | 'after-auth-commit'): Promise<void> {
  const response = await page.request.post(STUB_ADMIN, { data: { repo: 'acme/changes', state } })
  expect(response.status()).toBe(200)
}

/** Creates a project over the API, then runs its initial analysis to `done`. */
async function createAnalyzedProject(page: Page, name: string = PROJECT_NAME): Promise<number> {
  await deleteProjectsByName(page, name)
  const createResponse = await page.request.post('/api/projects', {
    data: { name, description: 'Exercises the changes UI end to end', owner: 'acme', repo: 'changes' },
  })
  expect(createResponse.status()).toBe(201)
  const project = (await createResponse.json()) as { id: number }

  expect((await page.request.post(`/api/projects/${project.id}/analyses`)).status()).toBe(202)
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${project.id}/analyses`)
    return ((await response.json()) as AnalysisProgress).status
  }, { timeout: 30_000 }).toBe('done')

  return project.id
}

test('release timeline, feature filter and the View-in-spec deep link', async ({ page }) => {
  await login(page)
  const projectId = await createAnalyzedProject(page)

  try {
    // The Task 10 precondition: one manual scenario on Authentication.
    const tree = (await (await page.request.get(`/api/projects/${projectId}/features`)).json()) as FeatureNode[]
    const authId = tree.find((feature) => feature.name === 'Authentication')!.id
    const manualResponse = await page.request.post(`/api/features/${authId}/scenarios`, {
      data: {
        context: 'operator walk-through',
        action: 'reset a forgotten password from the login page',
        outcome: 'a reset email arrives and the password form accepts the new one',
        category: 'happy',
      },
    })
    expect(manualResponse.status()).toBe(201)

    // Sync against the stub's extra commit → exactly one release.
    await setStubState(page, 'after-auth-commit')
    expect((await page.request.post(`/api/projects/${projectId}/sync`)).status()).toBe(202)
    await expect.poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}/analyses`)
      return ((await response.json()) as AnalysisProgress).status
    }, { timeout: 30_000 }).toBe('done')

    // API sanity by status code only: manual filter excludes the ai-only
    // release, an unknown release id is a plain 404.
    const manualDays = await page.request.get(`/api/projects/${projectId}/releases?source=manual`)
    expect(manualDays.status()).toBe(200)
    expect(((await manualDays.json()) as Array<{ releases: unknown[] }>).flatMap((day) => day.releases)).toEqual([])
    expect((await page.request.get('/api/releases/999999')).status()).toBe(404)

    // --- Overview: day heading, release card, honest ask bar ---
    await page.goto(`/projects/${projectId}`)

    const dayHeading = page.getByRole('heading', { name: 'Nov 2 · Monday' })
    await expect(dayHeading).toBeVisible()

    const card = page.getByRole('link', { name: /Tighter sign-in checks/ })
    await expect(card).toBeVisible()
    await expect(card.getByText('Highlight')).toBeVisible()
    await expect(card.getByText('GH', { exact: true })).toBeVisible()
    await expect(card.getByText('1 new · 1 changed · 1 gone · 1 fixed')).toBeVisible()

    const askInput = page.getByPlaceholder('Ask anything (coming next)')
    await expect(askInput).toBeDisabled()
    // The input swallows pointer events (pointer-events: none) so the tooltip
    // trigger — its wrapper — is what receives the hover. The tooltip renders
    // the text twice (a11y copy + visible bubble); assert the visible one.
    await askInput.locator('..').hover()
    await expect(
      page.locator('[data-slot="content"]', { hasText: 'Not wired up yet — the ask bar ships in the next milestone.' }),
    ).toBeVisible()

    // --- Changes list: filter by feature ---
    await page.goto(`/projects/${projectId}/changes`)
    await expect(page.getByRole('link', { name: /Tighter sign-in checks/ })).toBeVisible()

    await page.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Tasks', exact: true }).click()
    await expect(page.getByText('No releases match')).toBeVisible()

    await page.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Authentication', exact: true }).click()
    await expect(page.getByRole('link', { name: /Tighter sign-in checks/ })).toBeVisible()

    // --- Release detail: sections and the deep link ---
    await page.getByRole('link', { name: /Tighter sign-in checks/ }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/changes/\\d+`))
    await expect(page.getByRole('heading', { name: 'Tighter sign-in checks' })).toBeVisible()
    for (const section of ['New', 'Changed', 'Gone', 'Fixed']) {
      await expect(page.getByText(section, { exact: true })).toBeVisible()
    }

    // The applied removal links nowhere; the new scenario links to its anchor.
    const goneRow = page.locator('[id^="revision-gone"]', { hasText: 'ER-3' })
    await expect(goneRow).toBeVisible()
    await expect(goneRow.getByRole('link')).toHaveCount(0)

    await page.getByRole('link', { name: 'View in spec' }).first().click()
    await page.waitForURL(/#scenario-\d+$/)
    const url = new URL(page.url())
    const scenarioId = /^#scenario-(\d+)$/.exec(url.hash)?.[1]
    expect(scenarioId, 'the deep link carries a scenario anchor').toBeTruthy()

    // Deep-link ruling: the group is expanded, the row is in view and focused.
    const anchorRow = page.locator(`#scenario-${scenarioId}`)
    await expect(anchorRow).toBeVisible()
    await expect(anchorRow).toBeInViewport()
    await expect(anchorRow).toBeFocused()
    await expect(page.getByText('sign in with a valid password when two-factor authentication is enforced for admins')).toBeVisible()
  } finally {
    await deleteProjectsByName(page, PROJECT_NAME)
    await setStubState(page, 'initial')
  }
})

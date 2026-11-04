import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress, FeatureNode } from '../../shared/types'

/**
 * Flow-diagram tab end to end on top of a full analysis: the feature page
 * grows "Scenarios | Flow diagram" tabs (state in ?tab=flow, default stays
 * Scenarios), the flow renders on a client-only canvas with distinct node
 * shapes, and a node carrying a scenario code jumps back to the Scenarios
 * tab via the deep-link ruling (group expanded, row scrolled and focused).
 * A child feature without a stored flow hides the tab entirely, and a direct
 * ?tab=flow there lands on a quiet message. Review Focus #4: every page load
 * hydrates without a single console error. The project is deleted afterwards
 * to keep the persistent e2e database clean.
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

/** Creates the project and runs its initial analysis to a terminal `done`. The name must be unique per test — fullyParallel workers share the database. */
async function createAnalyzedProject(page: Page, name: string): Promise<number> {
  await deleteProjectsByName(page, name)
  const create = await page.request.post('/api/projects', {
    // The `acme/flow` stub alias (see global-setup) keeps this fixture off
    // the `acme/tasks` cards other running specs assert text against.
    data: { name, description: 'Exercises the flow diagram UI', owner: 'acme', repo: 'flow' },
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

test.describe('flow diagram tab', () => {
  test('tabs, canvas shapes and the scenario-code jump work together', async ({ page }) => {
    await login(page)
    const projectId = await createAnalyzedProject(page, 'Flow Fixture')

    // Review Focus #4: the page must hydrate without a single console error.
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })

    const treeResponse = await page.request.get(`/api/projects/${projectId}/features`)
    const tree = (await treeResponse.json()) as FeatureNode[]
    // Children ride inside their parent (one nesting level), so the lookup
    // walks them too.
    const byName = new Map(tree.flatMap((feature) => [feature, ...feature.children])
      .map((feature) => [feature.name, feature.id]))
    const authId = byName.get('Authentication')
    const loginId = byName.get('Login')
    const tasksId = byName.get('Tasks')
    expect(authId).toBeDefined()
    expect(loginId).toBeDefined()
    expect(tasksId).toBeDefined()

    try {
      await page.goto(`/projects/${projectId}/spec/${authId}`)

      // Both tabs are there; Scenarios stays the default with its content.
      const scenariosTab = page.getByRole('tab', { name: 'Scenarios' })
      const flowTab = page.getByRole('tab', { name: 'Flow diagram' })
      await expect(scenariosTab).toBeVisible()
      await expect(flowTab).toBeVisible()
      await expect(scenariosTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText('user on the login page').first()).toBeVisible()
      await expect(page.locator('.vue-flow')).toHaveCount(0)

      // Switching to Flow diagram: the URL carries the tab, the canvas
      // mounts, and the fixture graph shows its distinct kinds — decision
      // (the diamond glyph) and error (semantic red only on this kind).
      await flowTab.click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/${authId}\\?tab=flow`))
      await expect(scenariosTab).toHaveAttribute('aria-selected', 'false')
      const canvas = page.locator('.vue-flow')
      await expect(canvas).toBeVisible()
      await expect(page.locator('.vue-flow__node').first()).toBeInViewport()
      await expect(page.getByText('Valid credentials?')).toBeVisible()
      await expect(page.getByText("Show 'Invalid email or password'")).toBeVisible()
      await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible()
      // The node chip carries its code in mono; the legend's example `HP-1`
      // stays out of the match by scoping to the canvas.
      await expect(canvas.getByRole('button', { name: 'Open scenario HP-1' })).toBeVisible()

      // The decision kind is genuinely a diamond: the node's glyph carries
      // the rotation, and the legend's glyph matches it.
      const legend = page.getByRole('list', { name: 'Node shapes' })
      const decisionNode = page.locator('.vue-flow__node', { hasText: 'Valid credentials?' })
      await expect(decisionNode.locator('.flow-node__diamond')).toHaveClass(/rotate-45/)
      await expect(legend.locator('li', { hasText: 'Decision' }).locator('span')).toHaveClass(/rotate-45/)

      // The legend explains the shapes without inventing kinds.
      await expect(legend.getByRole('listitem').first()).toBeVisible()

      // A node with a scenario code jumps back: the URL loses ?tab, gains
      // the anchor, and the deep-link ruling applies (expanded group, row
      // scrolled into view and focused).
      await page.getByRole('button', { name: 'Open scenario HP-1' }).click()
      await page.waitForURL(/#scenario-\d+$/)
      const url = new URL(page.url())
      const scenarioId = /^#scenario-(\d+)$/.exec(url.hash)?.[1]
      expect(scenarioId, 'the click carries a scenario anchor').toBeTruthy()
      expect(url.searchParams.get('tab'), 'the flow tab is left').toBeNull()

      await expect(page.getByRole('tab', { name: 'Scenarios' })).toHaveAttribute('aria-selected', 'true')
      const anchorRow = page.locator(`#scenario-${scenarioId}`)
      await expect(anchorRow).toBeVisible()
      await expect(anchorRow).toBeInViewport()
      await expect(anchorRow).toBeFocused()
      await expect(page.getByText('submit the login form with a registered email and the correct password')).toBeVisible()

      // The same chip again after a tab round-trip: the URL already carries
      // this hash, so no hash change fires — the jump must still reveal the
      // row in the re-mounted pane.
      await flowTab.click()
      await expect(page).toHaveURL(new RegExp(`\\?tab=flow#scenario-${scenarioId}$`))
      await expect(page.locator('.vue-flow')).toBeVisible()
      await page.getByRole('button', { name: 'Open scenario HP-1' }).click()
      await expect(anchorRow).toBeVisible()
      await expect(anchorRow).toBeInViewport()
      await expect(anchorRow).toBeFocused()

      // The tab state is linkable: arriving straight on ?tab=flow skips the
      // click-through and renders the canvas directly.
      await page.goto(`/projects/${projectId}/spec/${tasksId}?tab=flow`)
      await expect(page.locator('.vue-flow')).toBeVisible()
      await expect(page.getByText('Task limit reached?')).toBeVisible()

      // A child feature has no stored flow (analysis draws top-level
      // features only): the Flow tab is gone and the direct URL lands on a
      // quiet message pointing back to Scenarios.
      await page.goto(`/projects/${projectId}/spec/${loginId}`)
      await expect(page.getByRole('tab', { name: 'Flow diagram' })).toHaveCount(0)
      await expect(page.getByRole('tab', { name: 'Scenarios' })).toHaveAttribute('aria-selected', 'true')
      await page.goto(`/projects/${projectId}/spec/${loginId}?tab=flow`)
      await expect(page.getByText('no flow diagram', { exact: false })).toBeVisible()
      await page.getByRole('button', { name: 'Go to scenarios' }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/${loginId}$`))
      await expect(page.getByText('no flow diagram', { exact: false })).toBeHidden()

      expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
      expect(pageErrors, pageErrors.join('\n')).toEqual([])
    } finally {
      await deleteProjectsByName(page, 'Flow Fixture')
    }
  })
})

import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress, FeatureNode } from '../../shared/types'

/**
 * Product map end to end on top of a full analysis: the stub GitHub serves
 * acme/tasks and LLM_MOCK answers with the fixtures, so the map canvas draws
 * the fixture world — Authentication and Tasks with their children, one
 * collapsed edge carrying three types, one child-to-child edge. The page
 * must load SSR-clean (no console errors or hydration warnings), reveal the
 * humanized edge types on hover, raise search matches while dimming the
 * rest, navigate node clicks into the spec, and toggle the fullscreen
 * stage. The project is deleted afterwards to keep the persistent e2e
 * database clean.
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
    data: { name, description: 'Exercises the product map UI', owner: 'acme', repo: 'tasks' },
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

test.describe('product map', () => {
  test('canvas, edge types, search raise, navigation and fullscreen work together', async ({ page }) => {
    await login(page)
    const projectId = await createAnalyzedProject(page, 'Map Fixture')

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

    // The fixture world, resolved through the API the map was built from.
    const treeResponse = await page.request.get(`/api/projects/${projectId}/features`)
    const tree = (await treeResponse.json()) as FeatureNode[]
    const byName = new Map(tree.map((feature) => [feature.name, feature.id]))
    const authId = byName.get('Authentication')
    const tasksId = byName.get('Tasks')
    expect(authId).toBeDefined()
    expect(tasksId).toBeDefined()

    try {
      await page.goto(`/projects/${projectId}/map`)

      // SSR chrome renders before the client-only canvas.
      await expect(page.getByRole('heading', { name: 'Product map' })).toBeVisible()

      // The legend lists exactly the connection types the fixture analysis
      // stored, in sorted order — nothing invented.
      const legend = page.getByRole('list', { name: 'Connection types' })
      await expect(legend.getByRole('listitem')).toHaveText(['Authenticates', 'Depends on', 'Leads to', 'Shares data'])

      // The canvas mounts client-side and draws both fixture features.
      const canvas = page.locator('.vue-flow')
      await expect(canvas).toBeVisible()
      const authNode = page.locator(`.vue-flow__node[data-id="feature-${authId}"]`)
      const tasksNode = page.locator(`.vue-flow__node[data-id="feature-${tasksId}"]`)
      await expect(authNode).toBeVisible()
      await expect(tasksNode).toBeVisible()

      // The corner control stack is an sm-and-up affordance (collapsed on
      // phones, asserted below on a small viewport).
      await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible()

      // Two collapsed edges: Authentication↔Tasks (three merged types) and
      // Login→Task list — and no more.
      const authTasksEdge = page.locator(`.vue-flow__edge[data-id="${Math.min(authId!, tasksId!)}-${Math.max(authId!, tasksId!)}"]`)
      await expect(page.locator('.vue-flow__edge')).toHaveCount(2)
      await expect(authTasksEdge).toHaveCount(1)

      // The type label stays hidden until the edge is hovered, then shows
      // the humanized list ("authenticates, depends_on, shares_data" as one
      // collapsed undirected edge).
      const label = authTasksEdge.locator('.vue-flow__edge-text')
      await expect(label).toHaveText('Authenticates, Depends on, Shares data')
      await expect(label).toHaveCSS('opacity', '0')
      // Hover the edge itself: the (hidden) label sits on the line's midpoint
      // and is part of the same hover group, so Playwright's hit check passes
      // on it while the browser reveals the text.
      await authTasksEdge.hover()
      await expect(label).toHaveCSS('opacity', '1')

      // Search "auth": the match stays raised, everything else dims.
      await page.getByRole('textbox', { name: 'Search features' }).fill('auth')
      await expect(authNode).toHaveClass(/map-node--match/)
      await expect(tasksNode).toHaveClass(/map-node--dimmed/)
      await page.getByRole('textbox', { name: 'Search features' }).fill('')
      await expect(authNode).not.toHaveClass(/map-node--match/)
      await expect(tasksNode).not.toHaveClass(/map-node--dimmed/)

      // A node click opens that feature's spec page.
      await authNode.click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/${authId}$`))

      // Fullscreen is a class toggle that Esc exits.
      await page.goto(`/projects/${projectId}/map`)
      const stage = page.locator('.map-stage')
      await expect(page.locator('.vue-flow')).toBeVisible()
      await expect(stage).not.toHaveClass(/map-stage--fullscreen/)
      await page.getByRole('button', { name: 'Fullscreen' }).click()
      await expect(stage).toHaveClass(/map-stage--fullscreen/)
      await page.keyboard.press('Escape')
      await expect(stage).not.toHaveClass(/map-stage--fullscreen/)

      expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
      expect(pageErrors, pageErrors.join('\n')).toEqual([])
    } finally {
      await deleteProjectsByName(page, 'Map Fixture')
    }
  })
})

test.describe('product map on a phone', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test('the canvas fills in and the control stack collapses', async ({ page }) => {
    await login(page)
    const projectId = await createAnalyzedProject(page, 'Map Phone Fixture')

    try {
      await page.goto(`/projects/${projectId}/map`)

      const canvas = page.locator('.vue-flow')
      await expect(canvas).toBeVisible()

      // fit-view-on-init frames the whole graph inside the canvas — the
      // canvas is the page's working surface at 360px. The section rail
      // grew with Ask (Task 8), so the canvas sits below the phone fold;
      // scroll to it before judging what fit-view framed.
      await canvas.scrollIntoViewIfNeeded()
      await expect(page.locator('.vue-flow__node').first()).toBeInViewport()

      // The corner control stack is an sm-and-up affordance; on a phone
      // touch users pinch and scroll to zoom (Vue Flow defaults).
      await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden()
    } finally {
      await deleteProjectsByName(page, 'Map Phone Fixture')
    }
  })
})

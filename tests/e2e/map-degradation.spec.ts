import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import type { AnalysisProgress, FeatureNode, MapData } from '../../shared/types'

/**
 * The pre-Plan-2 predecessor, simulated honestly: a project analyzed before
 * the connections/flows tables existed has features and scenarios but not a
 * single connections or flows row. The spec runs the full analysis on the
 * stub, then deletes exactly those project-scoped rows through the server's
 * database (nothing restored — the old world never gets them back) and
 * proves the product degrades gracefully: the map API answers `empty: true`
 * with every feature node, the flow endpoint 404s, the map page shows its
 * honest empty state with the Run analysis button, and the spec page hides
 * the Flow tab while Scenarios stays fully usable. The project is deleted
 * afterwards to keep the persistent e2e database clean.
 */
const PROJECT_NAME = 'Map Degradation Fixture'

/**
 * Opens the e2e server's SQLite database. `DATABASE_PATH=./data/test-e2e.db`
 * resolves against the *server's* cwd, which `nuxt preview` sets to
 * `.output/` — fall back to the project-root layout for other runners. The
 * file must already exist (the server created it on boot); never create one.
 */
function openServerDb(): Database.Database {
  for (const candidate of [path.resolve(process.cwd(), '.output', 'data', 'test-e2e.db'), path.resolve(process.cwd(), 'data', 'test-e2e.db')]) {
    if (existsSync(candidate)) {
      return new Database(candidate)
    }
  }
  throw new Error('e2e server database not found (expected .output/data/test-e2e.db or data/test-e2e.db)')
}

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

/** Creates the project on the stub's initial state and runs its analysis to a terminal `done`. */
async function createAnalyzedProject(page: Page, name: string): Promise<number> {
  await deleteProjectsByName(page, name)
  const create = await page.request.post('/api/projects', {
    data: { name, description: 'Exercises the pre-Plan-2 degradation path', owner: 'acme', repo: 'flow' },
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

/** The features API nests children; the map API lists features flat. */
function flattenFeatures(nodes: FeatureNode[]): FeatureNode[] {
  return nodes.flatMap((node) => [node, ...flattenFeatures(node.children)])
}

test('a project stripped of connections and flows degrades to the empty map and no flow tab', async ({ page }) => {
  await login(page)
  const projectId = await createAnalyzedProject(page, PROJECT_NAME)

  // Sanity: the fresh analysis really produced the Plan-2 rows we are about
  // to remove — otherwise the test would pass vacuously.
  const fresh = await page.request.get(`/api/projects/${projectId}/map`)
  expect(fresh.status()).toBe(200)
  const freshMap = await fresh.json() as MapData
  expect(freshMap.empty).toBe(false)
  expect(freshMap.edges.length).toBeGreaterThan(0)

  const treeResponse = await page.request.get(`/api/projects/${projectId}/features`)
  const tree = flattenFeatures(await treeResponse.json() as FeatureNode[])
  const byName = new Map(tree.map((feature) => [feature.name, feature.id]))
  const authId = byName.get('Authentication')
  expect(authId).toBeDefined()

  // Strip exactly what the old database lacked — project-scoped rows, no
  // restore (the predecessor never regains them).
  const db = openServerDb()
  db.prepare('DELETE FROM connections WHERE projectId = ?').run(projectId)
  db.prepare('DELETE FROM flows WHERE featureId IN (SELECT id FROM features WHERE projectId = ?)').run(projectId)
  db.close()

  // The map API still answers: every feature node with its live scenario
  // count, zero edges, `empty` flagged for the page.
  const stripped = await page.request.get(`/api/projects/${projectId}/map`)
  expect(stripped.status()).toBe(200)
  const map = await stripped.json() as MapData
  expect(map.empty).toBe(true)
  expect(map.edges).toEqual([])
  expect(map.nodes).toHaveLength(tree.length)
  for (const feature of tree) {
    const node = map.nodes.find((candidate) => candidate.featureId === feature.id)
    expect(node?.scenarioCount).toBe(feature.scenarioCount)
  }

  // The flow endpoint 404s for a feature that lost its flow row.
  const flow = await page.request.get(`/api/features/${authId}/flow`)
  expect(flow.status()).toBe(404)

  // Review Focus #4: every degraded page must hydrate without an error.
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

  try {
    // Map page: the honest empty state, not a bare canvas — and the summary
    // still counts every feature against zero connections.
    await page.goto(`/projects/${projectId}/map`)
    await expect(page.getByText('The map builds from the latest analysis')).toBeVisible()
    await expect(page.getByText('No connections between features have been recorded yet. Run the analysis and every link it finds is drawn here.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Run analysis' })).toBeVisible()
    await expect(page.locator('.vue-flow')).toHaveCount(0)
    await expect(page.getByText(`${tree.length} features · 0 connections`)).toBeVisible()

    // Spec page: Scenarios stays the default and fully usable, the Flow tab
    // is gone — even a stale ?tab=flow link lands on the honest message.
    await page.goto(`/projects/${projectId}/spec/${authId}`)
    await expect(page.getByRole('tab', { name: 'Flow diagram' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Scenarios' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('submit the login form with a registered email and the correct password')).toBeVisible()

    await page.goto(`/projects/${projectId}/spec/${authId}?tab=flow`)
    await expect(page.getByText('no flow diagram', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Go to scenarios' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/${authId}$`))
    await expect(page.getByText('no flow diagram', { exact: false })).toBeHidden()

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
  } finally {
    await deleteProjectsByName(page, PROJECT_NAME)
  }
})

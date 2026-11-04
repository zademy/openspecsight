import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress, FeatureDetail, FeatureNode } from '../../shared/types'

/**
 * Incremental sync end to end, API-driven (the sync UI arrives with T11):
 * run the initial analysis on the stubbed acme/tasks repo, add one manual
 * scenario on Authentication, push the stub's `after-auth-commit` state via
 * the test-only admin route and sync. The sync must apply the AI revisions,
 * leave the manual scenario untouched, advance the head so a second sync is
 * an up-to-date no-op, and leave the stub state clean for the other specs.
 */
const STUB_ADMIN = 'http://127.0.0.1:9876/_admin/state'
const PROJECT_NAME = 'Sync Fixture'

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
  const response = await page.request.post(STUB_ADMIN, { data: { repo: 'acme/tasks', state } })
  expect(response.status()).toBe(200)
}

/** Creates a project over the API and returns its id. */
async function createProject(page: Page): Promise<number> {
  await deleteProjectsByName(page, PROJECT_NAME)
  const createResponse = await page.request.post('/api/projects', {
    data: { name: PROJECT_NAME, description: 'Exercises the sync pipeline end to end', owner: 'acme', repo: 'tasks' },
  })
  expect(createResponse.status()).toBe(201)
  const project = (await createResponse.json()) as { id: number }
  return project.id
}

/** Polls the analyses endpoint until the latest run is done, then returns it. */
async function waitForSyncDone(page: Page, projectId: number): Promise<AnalysisProgress> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${projectId}/analyses`)
    return ((await response.json()) as AnalysisProgress).status
  }, { timeout: 30_000 }).toBe('done')

  const final = await page.request.get(`/api/projects/${projectId}/analyses`)
  return (await final.json()) as AnalysisProgress
}

test('sync applies new commits, protects manual scenarios and no-ops when up to date', async ({ page }) => {
  await login(page)
  // The stub state leaks across spec files — always start from a clean slate.
  await setStubState(page, 'initial')
  const projectId = await createProject(page)

  try {
    // Initial analysis builds the spec; its head becomes the sync baseline.
    expect((await page.request.post(`/api/projects/${projectId}/analyses`)).status()).toBe(202)
    await waitForSyncDone(page, projectId)

    const tree = (await (await page.request.get(`/api/projects/${projectId}/features`)).json()) as FeatureNode[]
    const authId = tree.find((feature) => feature.name === 'Authentication')!.id

    // An operator-documented scenario next to the AI ones (source manual, HP-3).
    const manualResponse = await page.request.post(`/api/features/${authId}/scenarios`, {
      data: {
        context: 'operator walk-through',
        action: 'reset a forgotten password from the login page',
        outcome: 'a reset email arrives and the password form accepts the new one',
        category: 'happy',
      },
    })
    expect(manualResponse.status()).toBe(201)

    // Push the stub to the new commit and sync.
    await setStubState(page, 'after-auth-commit')
    const syncStart = await page.request.post(`/api/projects/${projectId}/sync`)
    expect(syncStart.status()).toBe(202)
    expect(((await syncStart.json()) as { jobId: number }).jobId).toBeGreaterThan(0)
    expect(await waitForSyncDone(page, projectId)).toMatchObject({ status: 'done', step: 'done' })

    // Release rows have no endpoint yet (T11) — assert the sync's effects on the spec.
    const detail = (await (await page.request.get(`/api/features/${authId}`)).json()) as FeatureDetail
    const scenarios = detail.groups.flatMap((group) => group.scenarios)
    const codes = scenarios.map((scenario) => scenario.code)
    expect(codes).toContain('HP-4') // the 2FA scenario inserted after the manual HP-3
    expect(codes).not.toContain('ER-3') // gone
    expect(scenarios.find((scenario) => scenario.code === 'HP-1')?.outcome).toContain('slides forward')
    expect(scenarios.find((scenario) => scenario.code === 'ED-1')).toMatchObject({ category: 'error' })
    expect(scenarios.find((scenario) => scenario.source === 'manual')).toMatchObject({
      code: 'HP-3',
      context: 'operator walk-through',
      action: 'reset a forgotten password from the login page',
      outcome: 'a reset email arrives and the password form accepts the new one',
    })

    // A second sync with no new commits completes as an up-to-date no-op.
    expect((await page.request.post(`/api/projects/${projectId}/sync`)).status()).toBe(202)
    expect(await waitForSyncDone(page, projectId)).toMatchObject({ status: 'done', step: 'up-to-date' })
  } finally {
    await deleteProjectsByName(page, PROJECT_NAME)
    await setStubState(page, 'initial')
  }
})

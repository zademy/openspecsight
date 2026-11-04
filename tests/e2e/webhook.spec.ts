import crypto from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress } from '../../shared/types'
import { login } from './helpers/login'

/**
 * The GitHub webhook end to end against the built server: a project watches
 * `acme/hooks`, the stub is pushed to its `after-auth-commit` state, then a
 * push delivery signed with the real HMAC scheme (crypto in the test, over
 * the exact body bytes) lands on `/api/webhooks/github`. The webhook must
 * answer 200 with the project id, enqueue one sync job, and the resulting
 * sync must carry the new commit into a release. Each test gets its own repo
 * alias of `tasks` and project name, so parallel workers never share stub
 * state or delete each other's fixtures.
 */
const STUB_ADMIN = 'http://127.0.0.1:9876/_admin/state'
const WEBHOOK_SECRET = 'webhook-e2e-secret' // matches playwright.config env

/** The exact header GitHub sends: sha256=, hex HMAC over the body bytes. */
function signDelivery(body: string): string {
  return `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')}`
}

async function deleteProjectsByName(page: Page, name: string): Promise<void> {
  const response = await page.request.get('/api/projects')
  const projects = (await response.json()) as Array<{ id: number, name: string }>
  for (const stale of projects.filter((project) => project.name === name)) {
    await page.request.delete(`/api/projects/${stale.id}`)
  }
}

async function setStubState(page: Page, repo: string, state: 'initial' | 'after-auth-commit'): Promise<void> {
  const response = await page.request.post(STUB_ADMIN, { data: { repo, state } })
  expect(response.status(), await response.text()).toBe(200)
}

/** Creates the project over the API, then runs its initial analysis to `done`. */
async function createAnalyzedProject(page: Page, name: string, repo: string): Promise<number> {
  await deleteProjectsByName(page, name)
  const createResponse = await page.request.post('/api/projects', {
    data: { name, description: `Exercises the webhook flow end to end (${name})`, owner: 'acme', repo },
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

test('a signed push delivery syncs the project and records the release', async ({ page }) => {
  await login(page)
  const projectId = await createAnalyzedProject(page, 'Webhook Fixture', 'hooks')

  try {
    await setStubState(page, 'acme/hooks', 'after-auth-commit')

    // The exact bytes the signature covers: stringify here, post as a string.
    const body = JSON.stringify({ repository: { full_name: 'acme/hooks' }, ref: 'refs/heads/main' })
    const delivery = await page.request.post('/api/webhooks/github', {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signDelivery(body),
      },
    })
    expect(delivery.status()).toBe(200)
    expect(await delivery.json()).toEqual({ ok: true, synced: [projectId] })

    // The enqueued sync runs in-process; poll until its analyses row is done.
    await expect.poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}/analyses`)
      const progress = (await response.json()) as AnalysisProgress
      return progress.type === 'sync' ? progress.status : 'waiting'
    }, { timeout: 30_000 }).toBe('done')

    // The pushed commit is now a recorded release of the project.
    const releases = await page.request.get(`/api/projects/${projectId}/releases`)
    expect(releases.status()).toBe(200)
    const days = (await releases.json()) as Array<{ releases: Array<{ title: string }> }>
    const titles = days.flatMap((day) => day.releases.map((release) => release.title))
    expect(titles).toContain('Tighter sign-in checks')
  } finally {
    await deleteProjectsByName(page, 'Webhook Fixture')
    await setStubState(page, 'acme/hooks', 'initial')
  }
})

test('a delivery without a signature header is rejected and enqueues nothing', async ({ page }) => {
  await login(page)
  const projectId = await createAnalyzedProject(page, 'Webhook Guard Fixture', 'hooks-guard')

  try {
    const body = JSON.stringify({ repository: { full_name: 'acme/hooks-guard' }, ref: 'refs/heads/main' })
    const unsigned = await page.request.post('/api/webhooks/github', {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
      },
    })
    expect(unsigned.status()).toBe(401)

    // The spy is the point at HTTP level: the project has no queued sync.
    const analyses = await page.request.get(`/api/projects/${projectId}/analyses`)
    const progress = (await analyses.json()) as AnalysisProgress
    expect(progress.type).toBe('initial')
    expect(progress.status).toBe('done')
  } finally {
    await deleteProjectsByName(page, 'Webhook Guard Fixture')
  }
})

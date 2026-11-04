import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { login } from './helpers/login'

/**
 * Digests end to end, after the analysis+sync flow has produced a release
 * (committedAt 2026-11-02 in the stub fixtures): the on-demand digest with
 * the UI's default range, the list it appears in, the detail page rendering
 * the draft's blocks through ContentBlocks, and the "Digests" rail entry.
 * The email action is checked in both places against the real e2e
 * environment, where SMTP is deliberately unset: the detail page shows the
 * disabled button with the missing-config explanation, and the send API
 * answers the honest `{ sent: false, reason: 'SMTP is not configured' }`.
 * An API-driven pass pins the explicit-range request and the honest 422 for
 * a range without releases. Each test owns one stub repo and project name
 * (both flip stub state and run under fullyParallel workers — a shared repo
 * or name would race the other test's analysis and sync, seen live: a sync
 * that runs while the other test flipped state becomes an up-to-date
 * no-op and the expected release never exists).
 */
const STUB_ADMIN = 'http://127.0.0.1:9876/_admin/state'
const UI_REPO = 'acme/digests'
const API_REPO = 'acme/digests-api'

/** Opens the e2e server's SQLite database (same layout as sync.spec). */
function openServerDb(): Database.Database {
  for (const candidate of [path.resolve(process.cwd(), '.output', 'data', 'test-e2e.db'), path.resolve(process.cwd(), 'data', 'test-e2e.db')]) {
    if (existsSync(candidate)) {
      return new Database(candidate)
    }
  }
  throw new Error('e2e server database not found (expected .output/data/test-e2e.db or data/test-e2e.db)')
}

/**
 * Rewrites the project's release timestamps to yesterday (full ISO, UTC date
 * = today − 1). The stub fixtures carry static committedAt values, while the
 * "New digest" modal under test uses the default last-seven-days range —
 * backdating keeps that default range non-empty on any future run date.
 */
function backdateReleasesToYesterday(projectId: number): void {
  const db = openServerDb()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  db.prepare('UPDATE releases SET committedAt = ? WHERE projectId = ?').run(yesterday, projectId)
  db.close()
}

async function setStubState(page: Page, repo: string, state: 'initial' | 'after-auth-commit'): Promise<void> {
  const response = await page.request.post(STUB_ADMIN, { data: { repo, state } })
  expect(response.status()).toBe(200)
}

async function deleteProjectsByName(page: Page, name: string): Promise<void> {
  const response = await page.request.get('/api/projects')
  const projects = (await response.json()) as Array<{ id: number, name: string }>
  for (const stale of projects.filter((p) => p.name === name)) {
    await page.request.delete(`/api/projects/${stale.id}`)
  }
}

/** Creates a project over the API and returns its id. */
async function createProject(page: Page, name: string, repo: string): Promise<number> {
  await deleteProjectsByName(page, name)
  const createResponse = await page.request.post('/api/projects', {
    data: { name, description: 'Exercises the digest pipeline end to end', owner: 'acme', repo },
  })
  expect(createResponse.status()).toBe(201)
  const project = (await createResponse.json()) as { id: number }
  return project.id
}

/** Runs the initial analysis and, after flipping the stub state, one sync. */
async function analysisAndSync(page: Page, repo: string, projectId: number): Promise<void> {
  expect((await page.request.post(`/api/projects/${projectId}/analyses`)).status()).toBe(202)
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${projectId}/analyses`)
    return ((await response.json()) as { status: string }).status
  }, { timeout: 30_000 }).toBe('done')

  await setStubState(page, repo, 'after-auth-commit')
  expect((await page.request.post(`/api/projects/${projectId}/sync`)).status()).toBe(202)
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${projectId}/analyses`)
    return ((await response.json()) as { status: string }).status
  }, { timeout: 30_000 }).toBe('done')
}

/** Waits until the project's digest list carries at least one digest. */
async function waitForDigest(page: Page, projectId: number): Promise<Array<{ id: number, title: string, emailedAt: string | null }>> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${projectId}/digests`)
    return ((await response.json()) as Array<{ id: number }>).length
  }, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

  const response = await page.request.get(`/api/projects/${projectId}/digests`)
  return (await response.json()) as Array<{ id: number, title: string, emailedAt: string | null }>
}

test.describe('digests', () => {
  test('rail, list, default-range digest and the detail page render the draft', async ({ page }) => {
    test.setTimeout(120_000)
    await login(page)
    await setStubState(page, UI_REPO, 'initial')
    const projectId = await createProject(page, 'Digest UI Fixture', 'digests')

    try {
      await analysisAndSync(page, UI_REPO, projectId)
      // The digest under test uses the modal's default (today-relative) range;
      // the fixture's static release date must not decide whether it's empty.
      backdateReleasesToYesterday(projectId)

      // The rail gains "Digests" once the section exists.
      await page.goto(`/projects/${projectId}`)
      await page.getByRole('link', { name: 'Digests' }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/digests$`))
      await expect(page.getByText('No digests yet')).toBeVisible()

      // "New digest" opens the quiet modal with the last-seven-days defaults shown.
      // exact: true — "To" would otherwise also match the "Switch to dark mode" toggle.
      await page.getByRole('button', { name: 'New digest' }).click()
      const from = page.getByLabel('From', { exact: true })
      const to = page.getByLabel('To', { exact: true })
      await expect(from).toHaveValue(/\d{4}-\d{2}-\d{2}/)
      await expect(to).toHaveValue(/\d{4}-\d{2}-\d{2}/)
      await page.getByRole('button', { name: 'Create digest' }).click()

      // While the job runs the list shows an honest inline note, then the digest.
      await expect(page.getByText('Writing this week')).toBeVisible()
      await expect(page.getByText('Tighter sign-in and a steadier week')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText('Not emailed')).toBeVisible()

      // The detail page renders title and blocks through ContentBlocks.
      await page.getByRole('link', { name: 'Tighter sign-in and a steadier week' }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/digests/\\d+$`))
      await expect(page.getByRole('heading', { name: 'Tighter sign-in and a steadier week' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible()
      await expect(page.getByRole('listitem').filter({ hasText: 'Add tasks module' })).toBeVisible()

      // SMTP-off honesty: the email action is disabled and names what is
      // missing — it never pretends a digest went out.
      const emailButton = page.getByRole('button', { name: 'Email to recipients' })
      await expect(emailButton).toBeDisabled()
      await expect(page.getByText('SMTP is not configured. Set SMTP_* in .env to enable email')).toBeVisible()

      // The stored digest carries the fixture blocks verbatim and no email stamp.
      const digestId = Number(path.basename(page.url()))
      const db = openServerDb()
      const row = db.prepare('SELECT title, emailedAt, blocksJson FROM digests WHERE id = ?').get(digestId) as { title: string, emailedAt: string | null, blocksJson: string }
      expect(row.title).toBe('Tighter sign-in and a steadier week')
      expect(row.emailedAt).toBeNull()
      const blocks = JSON.parse(row.blocksJson) as Array<{ type: string }>
      expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'heading', 'list', 'paragraph'])
    } finally {
      await page.request.delete(`/api/projects/${projectId}`)
    }
  })

  test('API: explicit range stores a digest; an empty range answers 422 honestly', async ({ page }) => {
    await login(page)
    await setStubState(page, API_REPO, 'initial')
    const projectId = await createProject(page, 'Digest API Fixture', 'digests-api')

    try {
      await analysisAndSync(page, API_REPO, projectId)

      // Explicit dates keep this check independent of the day it runs on.
      const start = await page.request.post(`/api/projects/${projectId}/digests`, {
        data: { rangeFrom: '2026-10-28', rangeTo: '2026-11-04' },
      })
      expect(start.status()).toBe(202)
      expect(Number.isInteger(((await start.json()) as { jobId: number }).jobId)).toBe(true)

      const digests = await waitForDigest(page, projectId)
      expect(digests[0]!.emailedAt).toBeNull()

      const detail = await page.request.get(`/api/digests/${digests[0]!.id}`)
      expect(detail.status()).toBe(200)
      const body = (await detail.json()) as { projectId: number, title: string, blocks: Array<{ type: string }>, rangeFrom: string, rangeTo: string }
      expect(body.projectId).toBe(projectId)
      expect(body.title).toBe('Tighter sign-in and a steadier week')
      expect(body.rangeFrom).toBe('2026-10-28')
      expect(body.rangeTo).toBe('2026-11-04')
      expect(body.blocks.length).toBeGreaterThanOrEqual(3)

      const empty = await page.request.post(`/api/projects/${projectId}/digests`, {
        data: { rangeFrom: '2020-01-01', rangeTo: '2020-01-07' },
      })
      expect(empty.status()).toBe(422)
      expect(((await empty.json()) as { message: string }).message).toBe('No releases in that range; nothing to digest')

      // Email delivery with SMTP unset answers 200 with the honest result —
      // never a fake "sent" — and emailedAt stays null. DIGEST_RECIPIENTS is
      // set in the e2e env, so the named blocker is SMTP itself.
      const mailStatus = await page.request.get('/api/mail-status')
      expect(mailStatus.status()).toBe(200)
      expect(((await mailStatus.json()) as { configured: boolean }).configured).toBe(false)

      const send = await page.request.post(`/api/digests/${digests[0]!.id}/send`, { data: {} })
      expect(send.status()).toBe(200)
      expect(await send.json()).toEqual({ sent: false, reason: 'SMTP is not configured' })

      const afterSend = await page.request.get(`/api/digests/${digests[0]!.id}`)
      expect(((await afterSend.json()) as { emailedAt: string | null }).emailedAt).toBeNull()

      const unknown = await page.request.post('/api/digests/999999/send', { data: {} })
      expect(unknown.status()).toBe(404)
    } finally {
      await page.request.delete(`/api/projects/${projectId}`)
    }
  })
})

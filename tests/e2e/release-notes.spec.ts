import { expect, test, type Page } from '@playwright/test'
import { login } from './helpers/login'

/**
 * Release notes end to end, after the analysis+sync flow has produced a
 * release (the `acme/notes` stub alias serves the tasks fixtures): drafting
 * through the quiet modal (202 → the list polls until the note appears),
 * the read-only draft view, publish/unpublish, and the isolation contract —
 * a logged-out visitor sees the published note at /notes/<slug> and gets a
 * 404 for a draft or after unpublishing, while the auth guard stays exact
 * (an unrelated /api/notes/* path still 401s; only the public reader and
 * the not-yet-built webhook path are exempt).
 */
const STUB_ADMIN = 'http://127.0.0.1:9876/_admin/state'
const UI_REPO = 'acme/notes'

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
    data: { name, description: 'Exercises the release-note pipeline end to end', owner: 'acme', repo },
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

interface NoteSummary {
  id: number
  slug: string
  title: string
  published: boolean
}

/** A fresh logged-out browser context: no cookies, no session. */
async function loggedOutPage(page: Page): Promise<Page> {
  const context = page.context().browser()!.newContext()
  return (await context).newPage()
}

test.describe('release notes', () => {
  test('draft from the synced release, publish, read logged out, unpublish', async ({ page }) => {
    test.setTimeout(120_000)
    await login(page)
    await setStubState(page, UI_REPO, 'initial')
    const projectId = await createProject(page, 'Release Notes Fixture', 'notes')

    try {
      await analysisAndSync(page, UI_REPO, projectId)

      // The rail gains "Release notes" once the section exists.
      await page.goto(`/projects/${projectId}`)
      await page.getByRole('link', { name: 'Release notes' }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/release-notes$`))
      await expect(page.getByText('No release notes yet')).toBeVisible()

      // The quiet modal: one release in scope after the sync, so the
      // dropdown offers it; voice stays Default; no revision narrowing.
      await page.getByRole('button', { name: 'New release note' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('radio', { name: 'Whole release' }).check()
      await dialog.getByRole('combobox', { name: 'Release' }).click()
      await page.getByRole('option', { name: /Tighter sign-in checks/ }).click()
      await dialog.getByRole('button', { name: 'Draft note' }).click()

      // 202 → the page polls its own list until the draft appears.
      await expect(page.getByText('Tighter sign-in checks')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('Draft', { exact: true })).toBeVisible()

      const listResponse = await page.request.get(`/api/projects/${projectId}/release-notes`)
      const notes = (await listResponse.json()) as NoteSummary[]
      expect(notes).toHaveLength(1)
      const note = notes[0]!
      expect(note.published).toBe(false)

      // Isolation before publish: a logged-out visitor gets a 404.
      const anonBefore = await loggedOutPage(page)
      const draftResponse = await anonBefore.goto(`/notes/${note.slug}`)
      expect(draftResponse!.status()).toBe(404)
      await anonBefore.context().close()

      // The read-only draft view: blocks, voice line, publish action.
      await page.getByRole('link', { name: 'Tighter sign-in checks' }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/release-notes/${note.id}$`))
      await expect(page.getByRole('heading', { name: 'Tighter sign-in checks' })).toBeVisible()
      await expect(page.getByText('This release tightens how admin sign-in works.')).toBeVisible()
      await expect(page.getByText('Default voice')).toBeVisible()
      const publish = page.getByRole('button', { name: 'Publish' })
      await expect(publish).toBeVisible()

      publish.click()
      await expect(page.getByText('Published', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Copy public link' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible()

      // The public page, read from a fresh logged-out context.
      const anon = await loggedOutPage(page)
      const publicResponse = await anon.goto(`/notes/${note.slug}`)
      expect(publicResponse!.status()).toBe(200)
      await expect(anon.getByRole('heading', { name: 'Tighter sign-in checks' })).toBeVisible()
      await expect(anon.getByText('This release tightens how admin sign-in works.')).toBeVisible()
      await expect(anon.getByText('Second factor at sign-in')).toBeVisible()
      await expect(anon.getByText('Published with OpenSpecSight')).toBeVisible()

      // The public API serializes exactly the public shape.
      const publicApi = await anon.request.get(`/api/notes/public/${note.slug}`)
      expect(publicApi.status()).toBe(200)
      expect(Object.keys(await publicApi.json()).sort()).toEqual(['blocks', 'publishedAt', 'title'])
      expect((await anon.request.get('/api/notes/public/no-such-slug')).status()).toBe(404)

      // The guard stays exact: only /api/notes/public/ is exempt, an
      // unrelated /api/notes/* path still 401s; the webhook path is exempt
      // (route comes in Task 9, so it 404s — the point is not-401); the
      // general API guard and the page middleware are untouched.
      expect((await anon.request.get('/api/notes/publicX')).status()).toBe(401)
      expect((await anon.request.get('/api/notes/public/')).status()).not.toBe(401)
      expect((await anon.request.post('/api/webhooks/github')).status()).not.toBe(401)
      expect((await anon.request.get('/api/projects')).status()).toBe(401)
      await anon.goto(`/projects/${projectId}`)
      await expect(anon).toHaveURL(/\/login/)

      // Unpublish: back to draft, the public page 404s again.
      await anon.context().close()
      await page.getByRole('button', { name: 'Unpublish' }).click()
      await expect(page.getByText('Draft', { exact: true })).toBeVisible()

      const anonAfter = await loggedOutPage(page)
      const unpublishResponse = await anonAfter.goto(`/notes/${note.slug}`)
      expect(unpublishResponse!.status()).toBe(404)
      await anonAfter.context().close()

      // Authenticated app pages are unaffected by all of this.
      await page.goto(`/projects/${projectId}`)
      await expect(page.getByText('Release Notes Fixture')).toBeVisible()
    } finally {
      await page.request.delete(`/api/projects/${projectId}`)
    }
  })
})

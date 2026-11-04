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
// The editor spec flips commit state too, so it owns another alias.
const EDITOR_REPO = 'acme/notes-editor'

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

/** The id of the release a sync produced (the list API groups by day). */
async function firstReleaseId(page: Page, projectId: number): Promise<number> {
  const response = await page.request.get(`/api/projects/${projectId}/releases`)
  const days = (await response.json()) as Array<{ releases: Array<{ id: number }> }>
  return days[0]!.releases[0]!.id
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

      // 202 → the page polls its own list until the draft appears. The
      // link role keeps this off the modal's (hidden) native select
      // duplicate of the same title while the dialog is closing.
      await expect(page.getByRole('link', { name: 'Tighter sign-in checks' })).toBeVisible({ timeout: 30_000 })
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

      // The draft view is the block editor: editable title and blocks.
      await page.getByRole('link', { name: 'Tighter sign-in checks' }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/release-notes/${note.id}$`))
      await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Tighter sign-in checks')
      await expect(page.getByRole('textbox', { name: 'Paragraph 2' })).toHaveValue(/^This release tightens how admin sign-in works\./)
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
      // from the session guard but authenticates by signature instead —
      // an unsigned delivery reaches the handler and its 401 status text
      // reads 'Invalid signature' (the session guard's would read
      // 'Unauthorized'); the general API guard and page middleware are
      // untouched.
      expect((await anon.request.get('/api/notes/publicX')).status()).toBe(401)
      expect((await anon.request.get('/api/notes/public/')).status()).not.toBe(401)
      const webhookProbe = await anon.request.post('/api/webhooks/github')
      expect(webhookProbe.status()).toBe(401)
      expect(webhookProbe.statusText()).toBe('Invalid signature')
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

  test('edit a draft in the block editor: autosave persists, enhance rewrites one paragraph', async ({ page }) => {
    test.setTimeout(120_000)
    await login(page)
    await setStubState(page, EDITOR_REPO, 'initial')
    const projectId = await createProject(page, 'Release Notes Editor Fixture', 'notes-editor')

    try {
      await analysisAndSync(page, EDITOR_REPO, projectId)

      // A draft over the whole release (the modal flow is pinned above);
      // 202 → poll the list until the drafted note appears.
      expect((await page.request.post(`/api/projects/${projectId}/release-notes`, {
        data: { releaseId: await firstReleaseId(page, projectId) },
      })).status()).toBe(202)
      await expect.poll(async () => {
        const response = await page.request.get(`/api/projects/${projectId}/release-notes`)
        return ((await response.json()) as NoteSummary[]).length
      }, { timeout: 30_000 }).toBe(1)
      const listResponse = await page.request.get(`/api/projects/${projectId}/release-notes`)
      const note = ((await listResponse.json()) as NoteSummary[])[0]!

      await page.goto(`/projects/${projectId}/release-notes/${note.id}`)
      const title = page.getByRole('textbox', { name: 'Title' })
      const paragraph = page.getByRole('textbox', { name: 'Paragraph 2' })
      await expect(title).toHaveValue('Tighter sign-in checks')

      // Only paragraph blocks can be enhanced.
      await expect(page.getByRole('button', { name: 'Enhance', exact: true })).toHaveCount(1)

      // Edits autosave; the quiet indicator reports the save.
      await title.fill('Better sign-in, explained')
      await paragraph.fill('Sign-in now asks admins for a second factor before any session starts.')
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })

      // A reload proves the autosave landed on the server.
      await page.reload()
      await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Better sign-in, explained')
      await expect(page.getByRole('textbox', { name: 'Paragraph 2' })).toHaveValue('Sign-in now asks admins for a second factor before any session starts.')

      // Enhance rewrites just that paragraph (the mock LLM answers the
      // note-enhance fixture) and the rewrite autosaves in turn.
      await page.getByRole('button', { name: 'Enhance', exact: true }).click()
      await page.getByRole('button', { name: 'Rewrite paragraph' }).click()
      await expect(page.getByRole('textbox', { name: 'Paragraph 2' })).toHaveValue(
        /^Admin sign-in now has a second gate:/,
        { timeout: 15_000 },
      )
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })

      // A manual edit after the enhance wins the next save — no stale
      // response clobbers it.
      await page.getByRole('textbox', { name: 'Paragraph 2' }).fill('Manual words win after the rewrite.')
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })

      // A list block grows one item per line and persists across reloads.
      await page.getByRole('button', { name: 'Add block' }).click()
      await page.getByRole('menuitem', { name: 'List' }).click()
      await page.getByRole('textbox', { name: 'List 4' }).fill('First new item\nSecond new item\nThird new item')
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })
      await page.reload()
      await expect(page.getByRole('textbox', { name: 'List 4' })).toHaveValue('First new item\nSecond new item\nThird new item')

      // Move up swaps the order, and the swap persists.
      await page.getByRole('button', { name: 'Move block 4 up' }).click()
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })
      await page.reload()
      await expect(page.getByRole('textbox', { name: 'List 3' })).toHaveValue('First new item\nSecond new item\nThird new item')

      // Delete the heading: positions renumber, the deletion persists.
      await page.getByRole('button', { name: 'Delete block 1' }).click()
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })
      await page.reload()
      await expect(page.getByRole('textbox', { name: 'Heading 1' })).toHaveCount(0)
      await expect(page.getByRole('textbox', { name: 'Paragraph 1' })).toHaveValue('Manual words win after the rewrite.')
      await expect(page.getByRole('textbox', { name: 'List 2' })).toHaveValue('First new item\nSecond new item\nThird new item')


      // An empty block stays local (never stored), so enhancing a block
      // that sits AFTER it must target the stored array's index — the
      // local position would point one past the end (400) or at the
      // wrong block.
      await page.getByRole('button', { name: 'Add block' }).click()
      await page.getByRole('menuitem', { name: 'Paragraph' }).click()
      await page.getByRole('button', { name: 'Add block' }).click()
      await page.getByRole('menuitem', { name: 'Paragraph' }).click()
      await page.getByRole('textbox', { name: 'Paragraph 5' }).fill('This paragraph sits after an empty one.')
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })
      const lateArticle = page.locator('article').filter({ has: page.getByRole('textbox', { name: 'Paragraph 5' }) })
      await lateArticle.getByRole('button', { name: 'Enhance' }).click()
      await lateArticle.getByRole('button', { name: 'Rewrite paragraph' }).click()
      await expect(page.getByRole('textbox', { name: 'Paragraph 5' })).toHaveValue(
        /^Admin sign-in now has a second gate:/,
        { timeout: 15_000 },
      )
      await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })
      await page.reload()
      // The empty block never persisted, so the rewrite lands at position 4.
      await expect(page.getByRole('textbox', { name: 'Paragraph 4' })).toHaveValue(/^Admin sign-in now has a second gate:/)
      await expect(page.getByRole('textbox', { name: 'Paragraph 5' })).toHaveCount(0)

      // The public page (once published) renders the edited content.
      await page.getByRole('button', { name: 'Publish' }).click()
      await expect(page.getByText('Published', { exact: true })).toBeVisible()
      const anon = await loggedOutPage(page)
      await anon.goto(`/notes/${note.slug}`)
      await expect(anon.getByRole('heading', { name: 'Better sign-in, explained' })).toBeVisible()
      await expect(anon.getByText('Manual words win after the rewrite.')).toBeVisible()
      await anon.context().close()
    } finally {
      await page.request.delete(`/api/projects/${projectId}`)
    }
  })

  test('voices: create with an automatic default, move the default, delete', async ({ page }) => {
    await login(page)
    const projectId = await createProject(page, 'Voices Manager Fixture', 'notes')
    try {
      await page.goto(`/projects/${projectId}/release-notes`)

      // The first voice becomes the default without an extra step.
      await page.getByRole('textbox', { name: 'Name' }).fill('Support notes')
      await page.getByRole('textbox', { name: 'Description' }).fill('Warm and plain-spoken.')
      await page.getByRole('button', { name: 'Add voice' }).click()
      const supportRow = page.locator('li', { hasText: 'Support notes' })
      await expect(supportRow).toBeVisible()
      await expect(supportRow.getByText('Default', { exact: true })).toBeVisible()

      // A second voice starts unmarked; moving the default is one click.
      await page.getByRole('textbox', { name: 'Name' }).fill('Release highlights')
      await page.getByRole('textbox', { name: 'Description' }).fill('Terse and factual.')
      await page.getByRole('button', { name: 'Add voice' }).click()
      const highlightsRow = page.locator('li', { hasText: 'Release highlights' })
      await expect(highlightsRow).toBeVisible()
      await highlightsRow.getByRole('button', { name: 'Set as default' }).click()
      await expect(highlightsRow.getByText('Default', { exact: true })).toBeVisible()
      await expect(supportRow.getByRole('button', { name: 'Set as default' })).toBeVisible()

      // Deleting is confirm-free and quiet: notes using the voice fall
      // back to the default voice, so nothing can break.
      await highlightsRow.getByRole('button', { name: /Delete Release highlights/ }).click()
      await expect(page.getByText('Release highlights')).toHaveCount(0)
      await expect(supportRow).toBeVisible()
    } finally {
      await page.request.delete(`/api/projects/${projectId}`)
    }
  })
})

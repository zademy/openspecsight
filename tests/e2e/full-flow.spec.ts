import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page, type Response } from '@playwright/test'
import Database from 'better-sqlite3'
import type { AnalysisProgress, FeatureNode } from '../../shared/types'
import { askFromOverview, deleteScriptedAnswer, scriptLlmAnswer, wrongPasswordScenario } from './helpers/ask-fixtures'
import { login } from './helpers/login'

/**
 * The whole product in one pass, exactly as a fresh operator drives it: log
 * in, connect the stubbed acme/flow repository (a fixture alias of acme/tasks
 * with its own stub state, so parallel workers cannot flip our commits),
 * run the analysis and watch the progress land on stats, browse the spec,
 * edit a scenario by hand, sync after the stub serves a new commit, follow
 * the release back into the spec, read the refreshed maps (the flow
 * diagram renders the sync fixture's new "Account locked" node) and ask
 * from the overview, following the citation chip to the wrong-password
 * row. The release then reaches people: a digest over the default week
 * renders its blocks, the release note drafted from the release is
 * edited, enhanced and published, a logged-out visitor reads it at
 * /notes/<slug>, the spec export hands over a download that carries the
 * release history, and a signed cookie-less push webhook triggers a sync
 * that completes. Two hard rulings ride along (plan Review Focus #2/#3):
 * - the manually edited scenario must keep the exact text the user wrote
 *   (byte-for-byte) and show the "suggested" badge for the pending AI
 *   revision the sync parked instead of applying — and the operator can then
 *   apply the suggestion from the row, which overwrites the text with the
 *   proposal;
 * - no network response seen during the whole test may leak a secret string
 *   (`sk-`-style LLM keys, `ghp_` PATs) or the env's own test password and
 *   session secret, and no JSON payload may carry a `pat` key.
 */
const STUB_ADMIN = 'http://127.0.0.1:9876/_admin/state'
/**
 * Repeats run concurrently under --repeat-each: the repeat index keeps the
 * fixture project (and its per-project ask fixture) unique per copy.
 */
const projectName = (): string => `Full-Flow Fixture ${test.info().repeatEachIndex}`
const STUB_REPO = 'acme/flow'
const EDITED_ACTION = 'sign in from the CLI with a long-lived device token'
const EDITED_OUTCOME = 'the CLI keeps a session token that survives a server restart'

/**
 * Secret markers. `sk-` is guarded so words like "task-item" (the fixture
 * blob's CSS class) do not false-positive: a real OpenAI-style key always
 * starts the token or follows a separator, not a letter.
 */
const SECRET_MARKERS = /(^|[^a-zA-Z])sk-|ghp_|test-secret|test-pass/

async function deleteProjectsByName(page: Page, name: string): Promise<number[]> {
  const response = await page.request.get('/api/projects')
  const projects = (await response.json()) as Array<{ id: number, name: string }>
  const stale = projects.filter((project) => project.name === name)
  for (const project of stale) {
    await page.request.delete(`/api/projects/${project.id}`)
  }
  return stale.map((project) => project.id)
}

async function setStubState(page: Page, state: 'initial' | 'after-auth-commit'): Promise<void> {
  const response = await page.request.post(STUB_ADMIN, { data: { repo: STUB_REPO, state } })
  // The body names the rejected field when the stub answers 400.
  expect(response.status(), await response.text()).toBe(200)
}

/** Opens the e2e server's SQLite database (same layout as digests.spec). */
function openServerDb(): Database.Database {
  for (const candidate of [path.resolve(process.cwd(), '.output', 'data', 'test-e2e.db'), path.resolve(process.cwd(), 'data', 'test-e2e.db')]) {
    if (existsSync(candidate)) {
      return new Database(candidate)
    }
  }
  throw new Error('e2e server database not found (expected .output/data/test-e2e.db or data/test-e2e.db)')
}

/**
 * Rewrites the project's release timestamps to yesterday and returns the
 * UTC date it stamped. The stub fixtures carry static committedAt values,
 * while the "New digest" modal defaults to the last seven days.
 * Backdating keeps that default range non-empty on any run date.
 */
function backdateReleasesToYesterday(projectId: number): string {
  const stamped = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const db = openServerDb()
  db.prepare('UPDATE releases SET committedAt = ? WHERE projectId = ?').run(stamped, projectId)
  db.close()
  return stamped.slice(0, 10)
}

const WEBHOOK_SECRET = 'webhook-e2e-secret' // matches playwright.config env

/** The exact header GitHub sends: sha256=, hex HMAC over the body bytes. */
function signDelivery(body: string): string {
  return `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')}`
}

/** Mirrors the export's filename rule (featureSlug) for this project name. */
function exportFilename(name: string): string {
  return name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '')
}

/** True when any object key anywhere in the value is exactly `pat` (any case). */
function jsonHasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => jsonHasKey(entry, key))
  }
  if (value === null || typeof value !== 'object') {
    return false
  }
  return Object.entries(value).some(([entryKey, entryValue]) => {
    if (entryKey.toLowerCase() === key) {
      return true
    }
    return jsonHasKey(entryValue, key)
  })
}

/** Parses defensively so a malformed body counts as scanned-not-crashed. */
function jsonHasKeySafe(body: string, key: string): boolean {
  try {
    return jsonHasKey(JSON.parse(body) as unknown, key)
  } catch {
    return false
  }
}

/**
 * Records every secret violation a response carries. Bodies are read
 * best-effort: redirects, streams and pre-body responses resolve to nothing
 * and are skipped — the scan only inspects text-shaped payloads.
 */
function watchForSecretLeaks(page: Page, leaks: string[]): void {
  page.on('response', (response: Response) => {
    const contentType = response.headers()['content-type'] ?? ''
    if (!/json|text|javascript/.test(contentType)) {
      return
    }
    void response.text().then((body) => {
      if (SECRET_MARKERS.test(body)) {
        leaks.push(`${response.url()} contains a secret marker`)
      }
      if (/json/.test(contentType) && jsonHasKeySafe(body, 'pat')) {
        leaks.push(`${response.url()} carries a "pat" key`)
      }
    }).catch(() => {
      // No body to read (navigation, stream) — nothing to leak either.
    })
  })
}

test('full flow: connect, analyze, edit, sync, digest, publish, export, and the webhook', async ({ page }) => {
  // Every leg polls the UI; 30 s per step is not enough for the whole
  // flow including the webServer build fanfare.
  test.setTimeout(240_000)

  const leaks: string[] = []
  watchForSecretLeaks(page, leaks)

  await login(page)

  // A previous run may have died before cleanup; start from a clean slate.
  await deleteProjectsByName(page, projectName())
  await setStubState(page, 'initial')

  try {
    await runFullFlow(page, leaks)
  } finally {
    for (const id of await deleteProjectsByName(page, projectName())) {
      deleteScriptedAnswer(id)
    }
    await setStubState(page, 'initial')
  }
})

/** The flow itself, split out so cleanup runs even when a step fails. */
async function runFullFlow(page: Page, leaks: string[]): Promise<void> {
  // Connect the repository through the create dialog, as the operator would.
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Name').fill(projectName())
  await page.getByLabel('Owner').fill('acme')
  await page.getByLabel('Repository').fill('flow')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: new RegExp(projectName()) }).click()
  await expect(page).toHaveURL(/\/projects\/\d+$/)
  const projectId = Number(/\/projects\/(\d+)$/.exec(page.url())?.[1])
  expect(projectId, 'the project id from the overview URL').toBeGreaterThan(0)

  // Run the first analysis from the overview and wait for the stats badge.
  await page.getByRole('button', { name: 'Run analysis' }).click()
  await expect(page.getByText('Initial analysis finished.', { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('6 features · 12 scenarios · 7 files')).toBeVisible()

  // Browse the spec: the tree lists both fixture features; open Authentication.
  await page.getByRole('link', { name: 'Product spec' }).click()
  await expect(page.getByRole('treeitem', { name: 'Authentication' }).getByText('6 scenarios')).toBeVisible()
  await page.getByRole('treeitem', { name: 'Authentication' }).click()
  await expect(page).toHaveURL(/\/spec\/\d+$/)
  await expect(page.getByText('HP-1', { exact: true })).toBeVisible()

  // Edit HP-1 by hand. The exact strings above are asserted byte-for-byte
  // after the sync, so they must survive the round trip through form and API.
  await page.getByRole('button', { name: 'Edit HP-1' }).click()
  await page.getByLabel('Action').fill(EDITED_ACTION)
  await page.getByLabel('Outcome').fill(EDITED_OUTCOME)
  await page.getByRole('button', { name: 'Save changes' }).click()
  const hp1Row = page.locator('[id^="scenario-"]', { hasText: 'HP-1' })
  await expect(hp1Row.locator('p').first()).toHaveText(`${EDITED_ACTION}→${EDITED_OUTCOME}`)
  await expect(hp1Row.getByText('manual', { exact: true })).toBeVisible()

  // Push the stub to the after-auth-commit state and sync from the overview.
  await page.getByRole('link', { name: 'Overview' }).click()
  await setStubState(page, 'after-auth-commit')
  await page.getByRole('button', { name: 'Sync now' }).click()
  await expect(page.getByText('Tighter sign-in checks')).toBeVisible({ timeout: 30_000 })

  // The changes list shows the same release.
  await page.getByRole('link', { name: 'Changes', exact: true }).click()
  await expect(page.getByText('Tighter sign-in checks')).toBeVisible()

  // Release detail: the proposal for the manual scenario is recorded as
  // "suggested", and the row shows what the AI would have changed it to.
  await page.getByText('Tighter sign-in checks').click()
  await expect(page).toHaveURL(/\/changes\/\d+$/)
  const proposedRow = page.locator('[id^="revision-changed-"]')
  await expect(proposedRow.getByText('suggested', { exact: true })).toBeVisible()
  await expect(proposedRow.locator('p').first()).toHaveText(
    'submit the login form with a registered email and the correct password'
    + '→the user lands on the tasks page, the session cookie is set, and its expiry slides forward on each authenticated request',
  )
  await expect(proposedRow.getByText(`Was: ${EDITED_ACTION} → ${EDITED_OUTCOME}`)).toBeVisible()

  // "View in spec" on the applied new scenario lands on its anchor with the
  // row focused (deep-link ruling).
  await page.locator('[id^="revision-new-"]').getByRole('link', { name: 'View in spec' }).click()
  await page.waitForURL(/#scenario-\d+$/)
  const anchorId = /#scenario-(\d+)$/.exec(page.url())?.[1]
  expect(anchorId, 'the applied revision links to a scenario anchor').toBeTruthy()
  const anchorRow = page.locator(`#scenario-${anchorId}`)
  await expect(anchorRow).toBeVisible()
  await expect(anchorRow).toBeInViewport()
  await expect(anchorRow).toBeFocused()
  await expect(anchorRow.getByText('sign in with a valid password when two-factor authentication is enforced for admins')).toBeVisible()

  // The manual edit survived the sync byte-for-byte, and the spec marks the
  // pending AI proposal right on the row.
  const rendered = await hp1Row.locator('p').first().textContent()
  expect(rendered, 'the manual edit text must be byte-for-byte intact').toBe(`${EDITED_ACTION}→${EDITED_OUTCOME}`)
  await expect(hp1Row.getByText('suggested', { exact: true })).toBeVisible()

  // Design §6.3: the suggestion is actionable right on the row. Applying it
  // (confirm-free — it is reversible by editing) overwrites the manual text
  // with the proposal and clears the badge.
  await hp1Row.getByRole('button', { name: 'Apply suggestion' }).click()
  const proposalText = 'submit the login form with a registered email and the correct password'
    + '→the user lands on the tasks page, the session cookie is set, and its expiry slides forward on each authenticated request'
  await expect(hp1Row.locator('p').first()).toHaveText(proposalText)
  await expect(hp1Row.getByText('suggested', { exact: true })).toBeHidden()
  await expect(hp1Row.getByText('manual', { exact: true })).toBeVisible()

  // The sync refreshed the maps (Task 6): the Authentication↔Tasks edge
  // carries the refreshed relation set, and the feature's flow diagram
  // renders the redrawn graph — "Account locked" exists only in the sync
  // fixture's flow, never in the initial one.
  const treeResponse = await page.request.get(`/api/projects/${projectId}/features`)
  const tree = (await treeResponse.json()) as FeatureNode[]
  const auth = tree.find((feature) => feature.name === 'Authentication')
  const tasks = tree.find((feature) => feature.name === 'Tasks')
  expect(auth && tasks, 'fixture features in the tree').toBeTruthy()
  await page.getByRole('link', { name: 'Product map' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/map$`))
  const edgeId = `${Math.min(auth!.id, tasks!.id)}-${Math.max(auth!.id, tasks!.id)}`
  const authTasksEdge = page.locator(`.vue-flow__edge[data-id="${edgeId}"]`)
  await expect(authTasksEdge).toHaveCount(1)
  await authTasksEdge.hover()
  const edgeLabel = authTasksEdge.locator('.vue-flow__edge-text')
  await expect(edgeLabel).toBeVisible()
  await expect(edgeLabel).toHaveText('Authenticates, Notifies')
  await page.locator(`.vue-flow__node[data-id="feature-${auth!.id}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/${auth!.id}$`))
  await page.getByRole('tab', { name: 'Flow diagram' }).click()
  const lockedNode = page.locator('.vue-flow__node', { hasText: 'Account locked' })
  await expect(lockedNode).toBeVisible()

  // Ask from the overview bar, scripted with the live wrong-password
  // scenario id (the shared ask.spec helper): the grounded answer renders
  // with a citation chip, and the chip lands on the anchored scenario row.
  const scenario = await wrongPasswordScenario(page, projectId)
  // The per-project fixture file (ask-answer-<projectId>.json) means this
  // script cannot collide with ask.spec's, even when both run at once.
  scriptLlmAnswer(projectId, scenario.id)
  await askFromOverview(page, projectId, 'What happens with a wrong password?')
  await expect(page.getByRole('heading', { name: 'What happens with a wrong password?', level: 3 })).toBeVisible()
  await expect(page.getByText("shows 'Invalid email or password'", { exact: false })).toBeVisible()
  const chip = page.getByRole('link', { name: `Citation 1: ${scenario.code} in Authentication` })
  await expect(chip).toBeVisible()
  await expect(chip).toHaveText(scenario.code)
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/\\d+#scenario-${scenario.id}$`))
  const wrongPasswordRow = page.locator(`[id="scenario-${scenario.id}"]`)
  await expect(wrongPasswordRow).toBeVisible()
  await expect(wrongPasswordRow).toBeInViewport()
  await expect(wrongPasswordRow).toBeFocused()

  // --- The release reaches people: the communication legs (Plan 3). ---

  // (a) Weekly digest: backdate this project's releases so the modal's
  // default last-seven-days range is non-empty, generate with the
  // defaults, and read the detail page's rendered blocks.
  const stampedDay = backdateReleasesToYesterday(projectId)
  await page.getByRole('link', { name: 'Digests' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/digests$`))
  await page.getByRole('button', { name: 'New digest' }).click()
  await page.getByRole('button', { name: 'Create digest' }).click()
  // Digests have no progress endpoint: the list says what it is doing
  // and polls until the new digest appears.
  await expect(page.getByText('Writing this week')).toBeVisible()
  await expect(page.getByText('Tighter sign-in and a steadier week')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Tighter sign-in and a steadier week' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/digests/\\d+$`))
  await expect(page.getByRole('heading', { name: 'Tighter sign-in and a steadier week' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible()

  // (b) The release note drafted from that release, edited, enhanced,
  // published, and read by a visitor with no session in the context.
  await page.getByRole('link', { name: 'Release notes' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/release-notes$`))
  await page.getByRole('button', { name: 'New release note' }).click()
  const noteDialog = page.getByRole('dialog')
  await noteDialog.getByRole('combobox', { name: 'Release' }).click()
  await page.getByRole('option', { name: /Tighter sign-in checks/ }).click()
  await noteDialog.getByRole('button', { name: 'Draft note' }).click()
  // 202 → the list polls until the drafted note appears.
  await page.getByRole('link', { name: 'Tighter sign-in checks' }).click({ timeout: 30_000 })
  const noteTitle = page.getByRole('textbox', { name: 'Title' })
  await expect(noteTitle).toHaveValue('Tighter sign-in checks')
  await noteTitle.fill('Tighter sign-in checks, explained')
  await page.getByRole('textbox', { name: 'Paragraph 2' }).fill('Admins now confirm a second factor before any session starts.')
  // Edits autosave; the quiet indicator reports each save.
  await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Enhance', exact: true }).click()
  await page.getByRole('button', { name: 'Rewrite paragraph' }).click()
  await expect(page.getByRole('textbox', { name: 'Paragraph 2' })).toHaveValue(/^Admin sign-in now has a second gate:/, { timeout: 15_000 })
  await expect(page.getByText('Saved just now')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText('Published', { exact: true })).toBeVisible()
  const notes = await (await page.request.get(`/api/projects/${projectId}/release-notes`)).json() as Array<{ slug: string }>
  expect(notes).toHaveLength(1)
  const visitorContext = await page.context().browser()!.newContext()
  const visitor = await visitorContext.newPage()
  try {
    await visitor.goto(`/notes/${notes[0]!.slug}`)
    await expect(visitor.getByRole('heading', { name: 'Tighter sign-in checks, explained' })).toBeVisible()
    await expect(visitor.getByText(/^Admin sign-in now has a second gate:/)).toBeVisible()
    await expect(visitor.getByText('Second factor at sign-in')).toBeVisible()
  } finally {
    await visitorContext.close()
  }

  // (c) The spec export hands the browser a real download, and the
  // document closes with the release history, including the title this
  // flow synced.
  await page.getByRole('link', { name: 'Product spec' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec$`))
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export Markdown' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`${exportFilename(projectName())}.md`)
  const exportPath = path.join(os.tmpdir(), `openspecsight-full-flow-${download.suggestedFilename()}`)
  await download.saveAs(exportPath)
  const exported = await readFile(exportPath, 'utf8')
  expect(exported).toContain(`# ${projectName()}`)
  expect(exported).toContain('## Releases')
  expect(exported).toContain(`- Tighter sign-in checks (${stampedDay})`)

  // (d) The automatic sync: GitHub delivers a cookie-less push; the
  // HMAC signature over the exact body bytes is the only credential
  // (the webhook.spec scheme). The stub serves no commit beyond the one
  // the manual sync leg pulled, so the enqueued sync finishes as an
  // honest up-to-date run; a fresh progress row landing on that step
  // proves the delivery reached this project and its sync completed.
  const webhook = await page.context().browser()!.newContext()
  try {
    const deliveryBody = JSON.stringify({ repository: { full_name: STUB_REPO }, ref: 'refs/heads/main' })
    const delivery = await webhook.request.post('/api/webhooks/github', {
      data: deliveryBody,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signDelivery(deliveryBody),
      },
    })
    expect(delivery.status()).toBe(200)
    expect(await delivery.json()).toEqual({ ok: true, synced: [projectId] })
  } finally {
    await webhook.close()
  }
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${projectId}/analyses`)
    const progress = (await response.json()) as AnalysisProgress
    return `${progress.status}:${progress.step}`
  }, { timeout: 30_000 }).toBe('done:up-to-date')

  // Review Focus #3: nothing above may have leaked a secret.
  expect(leaks, leaks.join('\n')).toEqual([])
}

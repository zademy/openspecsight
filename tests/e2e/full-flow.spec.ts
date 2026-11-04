import { expect, test, type Page, type Response } from '@playwright/test'

/**
 * The whole product in one pass, exactly as a fresh operator drives it: log
 * in, connect the stubbed acme/flow repository (a fixture alias of acme/tasks
 * with its own stub state, so parallel workers cannot flip our commits),
 * run the analysis and watch the progress land on stats, browse the spec,
 * edit a scenario by hand, sync after the stub serves a new commit, and
 * follow the release back into the spec. Two hard rulings ride along (plan
 * Review Focus #2/#3):
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
const PROJECT_NAME = 'Full-Flow Fixture'
const STUB_REPO = 'acme/flow'
const EDITED_ACTION = 'sign in from the CLI with a long-lived device token'
const EDITED_OUTCOME = 'the CLI keeps a session token that survives a server restart'

/**
 * Secret markers. `sk-` is guarded so words like "task-item" (the fixture
 * blob's CSS class) do not false-positive: a real OpenAI-style key always
 * starts the token or follows a separator, not a letter.
 */
const SECRET_MARKERS = /(^|[^a-zA-Z])sk-|ghp_|test-secret|test-pass/

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
  for (const stale of projects.filter((project) => project.name === name)) {
    await page.request.delete(`/api/projects/${stale.id}`)
  }
}

async function setStubState(page: Page, state: 'initial' | 'after-auth-commit'): Promise<void> {
  const response = await page.request.post(STUB_ADMIN, { data: { repo: STUB_REPO, state } })
  // The body names the rejected field when the stub answers 400.
  expect(response.status(), await response.text()).toBe(200)
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

test('full flow: connect, analyze, edit, sync, and the manual edit survives', async ({ page }) => {
  // Analysis and sync both poll the UI; 30 s per step is not enough for the
  // whole flow including the webServer build fanfare.
  test.setTimeout(120_000)

  const leaks: string[] = []
  watchForSecretLeaks(page, leaks)

  await login(page)

  // A previous run may have died before cleanup; start from a clean slate.
  await deleteProjectsByName(page, PROJECT_NAME)
  await setStubState(page, 'initial')

  try {
    await runFullFlow(page, leaks)
  } finally {
    await deleteProjectsByName(page, PROJECT_NAME)
    await setStubState(page, 'initial')
  }
})

/** The flow itself, split out so cleanup runs even when a step fails. */
async function runFullFlow(page: Page, leaks: string[]): Promise<void> {
  // Connect the repository through the create dialog, as the operator would.
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Name').fill(PROJECT_NAME)
  await page.getByLabel('Owner').fill('acme')
  await page.getByLabel('Repository').fill('flow')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: new RegExp(PROJECT_NAME) }).click()
  await expect(page).toHaveURL(/\/projects\/\d+$/)

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

  // Review Focus #3: nothing above may have leaked a secret.
  expect(leaks, leaks.join('\n')).toEqual([])
}

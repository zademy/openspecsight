import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress, FeatureDetail, FeatureNode } from '../../shared/types'

/**
 * Ask end to end: the overview bar (⌘K focus → type → Enter) lands on the
 * ask page, which runs the question, creates the conversation and renders
 * the grounded answer with citation chips; a chip jumps to the anchored
 * scenario row in the spec, a follow-up appends in the same conversation,
 * and a gibberish question renders the honest refusal without chips. The
 * mock LLM's answer is written to the build output's fixture folder with
 * the live scenario id, so grounding stays real end to end. The project is
 * deleted afterwards, which now also cascades its conversations away.
 */

const PROJECT_NAME = 'Ask Fixture'

/**
 * The preview server reads LLM fixtures from the copy bundled into
 * `.output/fixtures/llm` (nuxt.config's compiled hook; `nuxt preview` runs
 * with cwd = .output). Fall back to the project-root layout for other
 * runners. The file is re-read on every generate call, so rewriting it
 * between asks re-scripts the model without touching the server.
 */
function llmFixturePath(): string {
  for (const candidate of [path.resolve(process.cwd(), '.output', 'fixtures', 'llm', 'ask-answer.json'), path.resolve(process.cwd(), 'fixtures', 'llm', 'ask-answer.json')]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('LLM fixture folder not found (expected .output/fixtures/llm or fixtures/llm)')
}

function scriptLlmAnswer(scenarioId: number | null): void {
  const fixture = scenarioId === null
    ? { covered: false, answer: 'The spec has nothing about time travel.', citations: [] }
    : {
        covered: true,
        answer: "Submitting the login form with the wrong password shows 'Invalid email or password' [1] and no cookie is set.",
        citations: [{ index: 1, scenarioId, quote: "the form shows 'Invalid email or password' and no cookie is set" }],
      }
  writeFileSync(llmFixturePath(), `${JSON.stringify(fixture, null, 2)}\n`)
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

/** Creates the project and runs its initial analysis to a terminal `done`. */
async function createAnalyzedProject(page: Page): Promise<number> {
  await deleteProjectsByName(page, PROJECT_NAME)
  const create = await page.request.post('/api/projects', {
    data: { name: PROJECT_NAME, description: 'Exercises the ask UI', owner: 'acme', repo: 'tasks' },
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

/** The wrong-password scenario's live id and code, read from the spec API. */
async function wrongPasswordScenario(page: Page, projectId: number): Promise<{ id: number, code: string }> {
  const treeResponse = await page.request.get(`/api/projects/${projectId}/features`)
  const tree = (await treeResponse.json()) as FeatureNode[]
  const auth = tree.find((feature) => feature.name === 'Authentication')
  expect(auth, 'Authentication feature in the fixture tree').toBeTruthy()

  const detailResponse = await page.request.get(`/api/features/${auth!.id}`)
  const detail = (await detailResponse.json()) as FeatureDetail
  const scenarios = detail.groups.flatMap((group) => group.scenarios)
  const scenario = scenarios.find((candidate) => candidate.action.includes('wrong password'))
  expect(scenario, 'wrong-password scenario in the fixture spec').toBeTruthy()
  return { id: scenario!.id, code: scenario!.code }
}

async function askFromOverview(page: Page, projectId: number, question: string): Promise<void> {
  await page.goto(`/projects/${projectId}`)
  const askBar = page.getByRole('textbox', { name: 'Ask about this product' })
  await expect(askBar).toBeEnabled()
  // ⌘K (macOS) / Ctrl+K elsewhere focuses the bar from anywhere on the page.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  await expect(askBar).toBeFocused()
  await askBar.fill(question)
  await askBar.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/ask/\\d+$`))
}

test.describe('ask', () => {
  test('bar, answer, citations, follow-up, refusal and delete work together', async ({ page }) => {
    await login(page)
    const projectId = await createAnalyzedProject(page)
    const scenario = await wrongPasswordScenario(page, projectId)
    scriptLlmAnswer(scenario.id)

    const QUESTION = 'What happens with a wrong password?'
    try {
      // ⌘K → type → Enter lands on the ask page, which runs the question
      // and replaces the URL with the created conversation's page.
      await askFromOverview(page, projectId, QUESTION)
      await expect(page.getByRole('heading', { name: QUESTION, level: 3 })).toBeVisible()

      // The answer renders as prose with the citation chip showing the
      // scenario code.
      await expect(page.getByText("shows 'Invalid email or password'", { exact: false })).toBeVisible()
      const chip = page.getByRole('link', { name: `Citation 1: ${scenario.code} in Authentication` })
      await expect(chip).toBeVisible()
      await expect(chip).toHaveText(scenario.code)

      // The conversation is in the sidebar, titled from the question.
      const sidebar = page.getByRole('navigation', { name: 'Conversations' })
      await expect(sidebar.getByText(QUESTION)).toBeVisible()

      // The chip deep-links into the spec: the anchored row is focused and
      // in view (Plan-1 expansion does the rest).
      await chip.click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/spec/\\d+#scenario-${scenario.id}$`))
      const row = page.locator(`[id="scenario-${scenario.id}"]`)
      await expect(row).toBeVisible()
      await expect(row).toBeInViewport()
      await expect(row).toBeFocused()

      // Back in the conversation, a follow-up appends to the same thread.
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/ask/\\d+$`))
      await page.getByLabel('Ask a follow-up question').fill('And with an unregistered email?')
      await page.getByLabel('Ask a follow-up question').press('Enter')
      await expect(page.getByRole('heading', { name: 'And with an unregistered email?', level: 3 })).toBeVisible()
      await expect(page.getByText('Answer', { exact: true })).toHaveCount(2)

      // A gibberish question gets the honest refusal: copy, no chips, and a
      // quiet way back to the spec.
      scriptLlmAnswer(null)
      await askFromOverview(page, projectId, 'How does the flux capacitor work?')
      await expect(page.getByText('The spec has nothing about time travel.')).toBeVisible()
      await expect(page.getByRole('link', { name: /Citation \d:/ })).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Browse the product spec' })).toBeVisible()

      // Deleting a conversation removes it and navigates off its page.
      await page.getByRole('navigation', { name: 'Conversations' }).getByText(QUESTION).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/ask/\\d+$`))
      await page.getByRole('button', { name: `Delete conversation: ${QUESTION}` }).click()
      await expect(page.getByRole('heading', { name: 'Delete conversation?' })).toBeVisible()
      await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/ask$`))
      await expect(page.getByRole('navigation', { name: 'Conversations' }).getByText(QUESTION)).toHaveCount(0)
    } finally {
      scriptLlmAnswer(scenario.id)
      await deleteProjectsByName(page, PROJECT_NAME)
    }
  })
})

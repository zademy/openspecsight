import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress } from '../../shared/types'
import { askFromOverview, scriptLlmAnswer, wrongPasswordScenario } from './helpers/ask-fixtures'
import { login } from './helpers/login'

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

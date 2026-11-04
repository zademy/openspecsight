import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { FeatureDetail, FeatureNode } from '../../../shared/types'

/**
 * The mock LLM re-reads its fixture file on every generate call and resolves
 * a per-project file first, so each test scripts its own
 * `ask-answer-<projectId>.json` and no parallel worker's ask can read it
 * (the shared single-file race is gone). Write the answer with a scenario id
 * captured from the live database and the citation round trip stays real end
 * to end. Script right before asking, and delete the file in cleanup so a
 * later project that reuses the id cannot inherit the script.
 */

/**
 * The preview server reads fixtures from the copy bundled into
 * `.output/fixtures/llm` (nuxt.config's compiled hook; `nuxt preview` runs
 * with cwd = .output). Fall back to the project-root layout for other
 * runners.
 */
function llmFixtureDir(): string {
  for (const candidate of [path.resolve(process.cwd(), '.output', 'fixtures', 'llm'), path.resolve(process.cwd(), 'fixtures', 'llm')]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('LLM fixture folder not found (expected .output/fixtures/llm or fixtures/llm)')
}

function scriptedAnswerPath(projectId: number): string {
  return path.join(llmFixtureDir(), `ask-answer-${projectId}.json`)
}

export function scriptLlmAnswer(projectId: number, scenarioId: number | null): void {
  const fixture = scenarioId === null
    ? { covered: false, answer: 'The spec has nothing about time travel.', citations: [] }
    : {
        covered: true,
        answer: "Submitting the login form with the wrong password shows 'Invalid email or password' [1] and no cookie is set.",
        citations: [{ index: 1, scenarioId, quote: "the form shows 'Invalid email or password' and no cookie is set" }],
      }
  writeFileSync(scriptedAnswerPath(projectId), `${JSON.stringify(fixture, null, 2)}\n`)
}

/** Removes a project's scripted answer so id reuse cannot inherit it. */
export function deleteScriptedAnswer(projectId: number): void {
  const file = scriptedAnswerPath(projectId)
  if (existsSync(file)) {
    unlinkSync(file)
  }
}

/** The wrong-password scenario's live id and code, read from the spec API. */
export async function wrongPasswordScenario(page: Page, projectId: number): Promise<{ id: number, code: string }> {
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

/** Asks from the overview bar: ⌘K focuses it, Enter lands on the conversation. */
export async function askFromOverview(page: Page, projectId: number, question: string): Promise<void> {
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

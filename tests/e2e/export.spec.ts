import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AnalysisProgress, FeatureNode, ScenarioGroupDTO } from '../../shared/types'
import { login } from './helpers/login'

/**
 * Markdown export end to end on the same Task 8 analysis state the spec
 * suite runs on: the spec page's Export button must hand the browser a
 * real download whose file carries the project name and every fixture
 * scenario code. The project is deleted afterwards to keep the persistent
 * e2e database clean.
 */
async function deleteProjectsByName(page: Page, name: string): Promise<void> {
  const response = await page.request.get('/api/projects')
  const projects = (await response.json()) as Array<{ id: number, name: string }>
  for (const stale of projects.filter((p) => p.name === name)) {
    await page.request.delete(`/api/projects/${stale.id}`)
  }
}

/** Creates the project and runs its initial analysis to a terminal `done`. */
async function createAnalyzedProject(page: Page): Promise<number> {
  await deleteProjectsByName(page, 'Export Fixture')
  const create = await page.request.post('/api/projects', {
    data: { name: 'Export Fixture', description: 'Exercises the markdown export', owner: 'acme', repo: 'tasks' },
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

/** Every scenario code of the analyzed fixture, collected through the spec API. */
async function collectScenarioCodes(page: Page, projectId: number): Promise<string[]> {
  const treeResponse = await page.request.get(`/api/projects/${projectId}/features`)
  const tree = (await treeResponse.json()) as FeatureNode[]
  const codes: string[] = []
  for (const root of tree) {
    for (const node of [root, ...root.children]) {
      const detailResponse = await page.request.get(`/api/features/${node.id}`)
      const groups = ((await detailResponse.json()) as { groups: ScenarioGroupDTO[] }).groups
      for (const group of groups) {
        codes.push(...group.scenarios.map((scenario) => scenario.code))
      }
    }
  }
  return codes
}

test.describe('markdown export', () => {
  test('the spec page exports the whole spec as a downloadable markdown file', async ({ page }) => {
    await login(page)
    const projectId = await createAnalyzedProject(page)

    try {
      await page.goto(`/projects/${projectId}/spec`)
      await expect(page.getByRole('treeitem', { name: 'Authentication' })).toBeVisible()
      const codes = await collectScenarioCodes(page, projectId)
      expect(codes.length).toBeGreaterThan(0)

      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('link', { name: 'Export Markdown' }).click()
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe('export-fixture.md')

      const target = path.join(os.tmpdir(), `openspecsight-e2e-${download.suggestedFilename()}`)
      await download.saveAs(target)
      const markdown = await readFile(target, 'utf8')
      expect(markdown).toContain('# Export Fixture')
      // This project has no releases, so no release history renders.
      expect(markdown).not.toContain('## Releases')
      const missing = codes.filter((code) => !markdown.includes(`\`${code}\``))
      expect(missing).toEqual([])
    } finally {
      await deleteProjectsByName(page, 'Export Fixture')
    }
  })

  test('the export answers 404 for an unknown project', async ({ page }) => {
    await login(page)
    const response = await page.request.get('/api/projects/999999/export/markdown')
    expect(response.status()).toBe(404)
  })
})

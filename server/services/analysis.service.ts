import { asc, eq, inArray } from 'drizzle-orm'
import { getDB, type Database } from '../db/client'
import { analyses, featureFiles, features, repositories, scenarios } from '../db/schema'
import { FeatureInventorySchema, FeatureScenariosSchema } from '../../shared/schemas'
import type { FeatureInventory, FeatureScenarios, ScenarioCategory } from '../../shared/types'
import { decryptSecret } from '../utils/crypto'
import { createGithubService, type GithubService } from './github.service'
import { createLlmClient, type LlmClient } from './llm.service'
import { buildFeatureDigest, buildSourceDigest } from './analysis/digest'
import { featureSlug, filterCodeFiles } from './analysis/paths'

/**
 * The initial-analysis pipeline: turn a repository into the product spec.
 *
 * Steps (each reports progress on the `analyses` row as it runs):
 *  1. `tree` — load the project's first repository, list its tree recursively
 *     and filter it down to code files; the GITHUB_MAX_FILES /
 *     GITHUB_MAX_TOTAL_BYTES limits are enforced here, before any LLM call.
 *     Hitting a limit parks the analysis as `error` with a message naming the
 *     limit and ends the run gracefully (a retry would hit the same limit, so
 *     the job is allowed to finish instead of burning its attempts).
 *  2. `blobs` — read the filtered blobs in small batches and render the
 *     compact source digest (size-capped per file, capped as a whole).
 *  3. `inventory` — one structured generate() call returns the feature tree;
 *     features are stored to depth 2 (the shared schema strips deeper
 *     `children` at validation, which is the documented flattening behavior).
 *  4. `scenarios (n/m)` — one generate() call per top-level feature, then the
 *     scenarios are stored grouped by context with stable codes (HP-n / ED-n /
 *     ER-n counters per feature and category).
 *  5. `done` — stats land in `statsJson` and the repository's lastSyncedSha
 *     is set to the branch head.
 *
 * Re-running is safe by design: starting a fresh analysis wipes the project's
 * previous features / scenarios / featureFiles inside the insert transaction,
 * so a clean-slate re-analysis never doubles rows. Any other thrown error —
 * GitHub failures, schema-invalid LLM output — marks the analysis `error` and
 * rethrows so the jobs queue (Task 7 retry logic) handles the attempts.
 */

export interface InitialAnalysisPayload {
  analysisId: number
  projectId: number
}

/** Dependency seams for tests; production builds the real clients per run. */
export interface AnalysisDeps {
  github?: GithubService
  llm?: LlmClient
}

/** Defaults from the spec / .env.example. */
const DEFAULT_MAX_FILES = 10000
const DEFAULT_MAX_TOTAL_BYTES = 157286400

/** Stable scenario codes: HP for happy, ED for edge, ER for error paths. */
const CODE_PREFIX: Record<ScenarioCategory, string> = { happy: 'HP', edge: 'ED', error: 'ER' }

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type RepositoryRow = typeof repositories.$inferSelect

export async function runInitialAnalysis(payload: InitialAnalysisPayload, deps: AnalysisDeps = {}): Promise<void> {
  const analysisId = Number(payload.analysisId)
  if (!Number.isInteger(analysisId) || analysisId <= 0) {
    throw new Error(`initial-analysis job payload has no valid analysisId: ${String(payload.analysisId)}`)
  }

  const analysis = getDB().select().from(analyses).where(eq(analyses.id, analysisId)).get()
  if (!analysis) {
    // The analysis row is gone (its project was deleted after enqueueing).
    // Nothing to update; the queue's stale-project guard ends the job.
    return
  }

  try {
    await analyze(analysisId, analysis.projectId, deps)
  } catch (error) {
    failAnalysis(analysisId, error instanceof Error ? error.message : String(error))
    throw error
  }
}

async function analyze(analysisId: number, projectId: number, deps: AnalysisDeps): Promise<void> {
  const db = getDB()
  const repository = db.select().from(repositories)
    .where(eq(repositories.projectId, projectId))
    .orderBy(asc(repositories.id))
    .limit(1)
    .get()
  if (!repository) {
    failAnalysis(analysisId, 'Project has no repository to scan; add one and start a new analysis.')
    return
  }

  const github = deps.github ?? githubForRepository(repository)
  const llm = deps.llm ?? createLlmClient()

  const setStep = (progress: number, step: string) => {
    db.update(analyses).set({ status: 'running', progress, step }).where(eq(analyses.id, analysisId)).run()
  }

  setStep(10, 'tree')
  const entries = await github.getTree(repository.owner, repository.repo, repository.branch)
  const files = filterCodeFiles(entries)

  const limits = readScanLimits()
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (files.length > limits.maxFiles) {
    failAnalysis(analysisId, `Repository scan found ${files.length} code files, over the limit of ${limits.maxFiles} (GITHUB_MAX_FILES). Raise the limit or scan a smaller repository, then start a new analysis.`)
    return
  }
  if (totalBytes > limits.maxTotalBytes) {
    failAnalysis(analysisId, `Repository scan totals ${totalBytes} bytes of code files, over the limit of ${limits.maxTotalBytes} (GITHUB_MAX_TOTAL_BYTES). Raise the limit or scan a smaller repository, then start a new analysis.`)
    return
  }

  setStep(30, 'blobs')
  const { digest, contentsByPath } = await buildSourceDigest(github, repository.owner, repository.repo, files)

  setStep(50, 'inventory')
  const inventory = await llm.generate('feature-inventory', FeatureInventorySchema, digest)
  const { count, idsByName } = replaceSpec(projectId, inventory)

  const topLevel = inventory.features
  let scenarioCount = 0
  for (const [index, feature] of topLevel.entries()) {
    setStep(60 + Math.round((30 * (index + 1)) / topLevel.length), `scenarios (${index + 1}/${topLevel.length})`)
    const generated = await llm.generate(
      `feature-scenarios:${featureSlug(feature.name)}`,
      FeatureScenariosSchema,
      buildFeatureDigest(feature, contentsByPath),
    )
    const featureId = idsByName.get(feature.name)
    if (featureId !== undefined) {
      scenarioCount += insertScenarios(featureId, generated)
    }
  }

  const head = await github.listCommits(repository.owner, repository.repo, repository.branch, 1)
  if (head[0]) {
    db.update(repositories).set({ lastSyncedSha: head[0].sha }).where(eq(repositories.id, repository.id)).run()
  }

  db.update(analyses).set({
    status: 'done',
    progress: 100,
    step: 'done',
    statsJson: JSON.stringify({ features: count, scenarios: scenarioCount, files: files.length }),
    error: null,
    finishedAt: nowISO(),
  }).where(eq(analyses.id, analysisId)).run()
}

/**
 * Wipes the project's previous spec rows and writes the inventory's features
 * (depth 2) with their featureFiles inside one transaction, so a crashed
 * analysis never leaves a half-wiped spec behind. Feature ids come back keyed
 * by name so the scenario step can attach to the top-level features.
 */
function replaceSpec(projectId: number, inventory: FeatureInventory): { count: number, idsByName: Map<string, number> } {
  return getDB().transaction((tx) => {
    const existingIds = tx.select({ id: features.id })
      .from(features)
      .where(eq(features.projectId, projectId))
      .all()
      .map((row) => row.id)
    if (existingIds.length > 0) {
      tx.delete(scenarios).where(inArray(scenarios.featureId, existingIds)).run()
      tx.delete(featureFiles).where(inArray(featureFiles.featureId, existingIds)).run()
      tx.delete(features).where(eq(features.projectId, projectId)).run()
    }

    const idsByName = new Map<string, number>()
    let count = 0
    inventory.features.forEach((feature, index) => {
      const parent = tx.insert(features).values({
        projectId, parentId: null, name: feature.name, description: feature.description,
        sortOrder: index, source: 'ai',
      }).returning().get()
      idsByName.set(parent.name, parent.id)
      count += 1
      insertFeatureFiles(tx, parent.id, feature.files)

      ;(feature.children ?? []).forEach((child, childIndex) => {
        const childRow = tx.insert(features).values({
          projectId, parentId: parent.id, name: child.name, description: child.description,
          sortOrder: childIndex, source: 'ai',
        }).returning().get()
        idsByName.set(childRow.name, childRow.id)
        count += 1
        insertFeatureFiles(tx, childRow.id, child.files)
      })
    })

    return { count, idsByName }
  })
}

function insertFeatureFiles(tx: Transaction, featureId: number, paths: string[]): void {
  for (const path of new Set(paths)) {
    tx.insert(featureFiles).values({ featureId, path }).run()
  }
}

/** Stores the generated scenarios with stable per-feature, per-category codes. */
function insertScenarios(featureId: number, generated: FeatureScenarios): number {
  const db = getDB()
  const counters: Record<ScenarioCategory, number> = { happy: 0, edge: 0, error: 0 }
  let inserted = 0
  for (const group of generated.groups) {
    for (const scenario of group.scenarios) {
      counters[scenario.category] += 1
      db.insert(scenarios).values({
        featureId,
        context: group.context,
        action: scenario.action,
        outcome: scenario.outcome,
        category: scenario.category,
        code: `${CODE_PREFIX[scenario.category]}-${counters[scenario.category]}`,
        sortOrder: inserted,
        source: 'ai',
      }).run()
      inserted += 1
    }
  }
  return inserted
}

/** Parks the analysis as `error` with a human-readable cause. Terminal. */
function failAnalysis(analysisId: number, message: string): void {
  getDB().update(analyses).set({
    status: 'error',
    step: 'error',
    error: message,
    finishedAt: nowISO(),
  }).where(eq(analyses.id, analysisId)).run()
}

/** GitHub client for the stored repository, decrypting its PAT when present. */
function githubForRepository(repository: RepositoryRow): GithubService {
  const token = repository.patEncrypted ? decryptSecret(repository.patEncrypted) : undefined
  return createGithubService(token ? { token } : {})
}

/** Reads the scan limits fresh per run so tests (and ops) can tune them live. */
function readScanLimits(): { maxFiles: number, maxTotalBytes: number } {
  return {
    maxFiles: positiveIntEnv('GITHUB_MAX_FILES', DEFAULT_MAX_FILES),
    maxTotalBytes: positiveIntEnv('GITHUB_MAX_TOTAL_BYTES', DEFAULT_MAX_TOTAL_BYTES),
  }
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name]?.trim() ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nowISO(): string {
  return new Date().toISOString()
}

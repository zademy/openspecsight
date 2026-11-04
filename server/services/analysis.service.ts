import { asc, eq, inArray } from 'drizzle-orm'
import { getDB, type Database } from '../db/client'
import { analyses, annotations, connections, featureFiles, features, flows, repositories, scenarios } from '../db/schema'
import { ConnectionsSchema, FeatureInventorySchema, FeatureScenariosSchema, FlowGraphSchema } from '../../shared/schemas'
import type { FeatureInventory, FeatureScenarios, FlowGraph, ScenarioCategory } from '../../shared/types'
import { decryptSecret } from '../utils/crypto'
import { createGithubService, type GithubService } from './github.service'
import { createLlmClient, type LlmClient } from './llm.service'
import { buildFeatureDigest, buildSourceDigest } from './analysis/digest'
import { featureSlug, filterCodeFiles } from './analysis/paths'
import { storeConnections, upsertFlow } from './analysis/store-maps'

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
 *  5. `connections` — one generate() call maps how the features relate; rows
 *     referencing unknown features, self-links and duplicate triples are
 *     dropped before insert and counted in the stats.
 *  6. `flows (n/m)` — one generate() call per top-level feature renders its
 *     control-flow graph (nodes reference the stored scenario codes).
 *  7. `done` — stats land in `statsJson` and the repository's lastSyncedSha
 *     is set to the branch head.
 *
 * The map writes commit as one transaction: all LLM calls run first (they
 * cannot run inside a synchronous better-sqlite3 transaction), then the
 * connections insert and the flow upserts land together — a crash mid-write
 * leaves both tables untouched, not connections without flows.
 *
 * Re-running is safe by design: starting a fresh analysis replaces the
 * project's previous features / scenarios / featureFiles — and wipes its
 * connections + flows (pure analysis output, regenerated from scratch) —
 * inside the insert transaction, so a re-analysis never doubles rows — and
 * it spares manual territory the same way sync does (see replaceSpec). Any other thrown
 * error — GitHub failures, schema-invalid LLM output — marks the analysis
 * `error` and rethrows so the jobs queue (Task 7 retry logic) handles the
 * attempts.
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
export const CODE_PREFIX: Record<ScenarioCategory, string> = { happy: 'HP', edge: 'ED', error: 'ER' }

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type FeatureRow = typeof features.$inferSelect
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

  setStep(92, 'connections')
  const generatedConnections = await llm.generate('connections', ConnectionsSchema, buildConnectionsDigest(inventory))

  // Every graph is generated before the write: better-sqlite3 transactions
  // are synchronous, so the async LLM calls cannot run inside one. The
  // progress steps below keep reporting per generated flow.
  const flowGraphs = new Map<number, FlowGraph>()
  for (const [index, feature] of topLevel.entries()) {
    setStep(94 + Math.round((3 * (index + 1)) / topLevel.length), `flows (${index + 1}/${topLevel.length})`)
    const featureId = idsByName.get(feature.name)
    if (featureId !== undefined) {
      flowGraphs.set(featureId, await llm.generate(
        `flow:${featureSlug(feature.name)}`,
        FlowGraphSchema,
        buildFlowDigest(feature.name, feature.description, featureId),
      ))
    }
  }

  // Connections and flows land in one transaction: a crash mid-write leaves
  // both tables untouched instead of connections without flows.
  const { inserted: connectionCount, skipped: connectionsSkipped } = db.transaction((tx) => {
    const stored = storeConnections(tx, projectId, idsByName, generatedConnections.connections)
    for (const [featureId, graph] of flowGraphs) {
      upsertFlow(tx, featureId, graph)
    }
    return stored
  })
  const flowCount = flowGraphs.size

  const head = await github.listCommits(repository.owner, repository.repo, repository.branch, 1)
  if (head[0]) {
    db.update(repositories).set({ lastSyncedSha: head[0].sha }).where(eq(repositories.id, repository.id)).run()
  }

  db.update(analyses).set({
    status: 'done',
    progress: 100,
    step: 'done',
    statsJson: JSON.stringify({ features: count, scenarios: scenarioCount, files: files.length, connections: connectionCount, connectionsSkipped, flows: flowCount }),
    error: null,
    finishedAt: nowISO(),
  }).where(eq(analyses.id, analysisId)).run()
}

/**
 * Replaces the project's spec rows with the inventory's features (depth 2)
 * inside one transaction, so a crashed analysis never leaves a half-replaced
 * spec behind. Manual territory survives the replacement the way sync treats
 * it: manual features are kept untouched, manual scenarios under ai features
 * survive too (so does their feature row — it has to hold the FK), and a
 * wiped ai scenario takes its annotations along — no orphaned notes.
 * Feature ids come back keyed by name so the scenario step can attach to the
 * top-level features, reusing kept rows instead of doubling them.
 */
function replaceSpec(projectId: number, inventory: FeatureInventory): { count: number, idsByName: Map<string, number> } {
  return getDB().transaction((tx) => {
    const existing = tx.select().from(features).where(eq(features.projectId, projectId)).all()
    const keptByName = new Map<string, FeatureRow>()

    if (existing.length > 0) {
      const allIds = existing.map((feature) => feature.id)

      // Connections and flows are pure analysis output with no manual
      // variants, so a re-analysis regenerates them from scratch. The wipe
      // must precede any feature delete — both tables reference features by
      // foreign key, and better-sqlite3 enforces that (PRAGMA foreign_keys
      // defaults ON in this driver; the explicit order stays deliberate
      // regardless).
      tx.delete(connections).where(eq(connections.projectId, projectId)).run()
      tx.delete(flows).where(inArray(flows.featureId, allIds)).run()

      const allScenarios = tx.select({
        id: scenarios.id,
        featureId: scenarios.featureId,
        source: scenarios.source,
      }).from(scenarios).where(inArray(scenarios.featureId, allIds)).all()

      // A feature survives when the operator owns it (source manual) or when
      // a manual scenario lives under it — sync semantics never delete manual
      // rows, and a scenario cannot outlive its feature.
      const manualScenarioFeatures = new Set(
        allScenarios.filter((row) => row.source === 'manual').map((row) => row.featureId),
      )
      const wipedIds = existing
        .filter((feature) => feature.source === 'ai' && !manualScenarioFeatures.has(feature.id))
        .map((feature) => feature.id)
      const wipedScenarioIds = allScenarios
        .filter((row) => row.source === 'ai' || wipedIds.includes(row.featureId))
        .map((row) => row.id)

      if (wipedScenarioIds.length > 0) {
        tx.delete(annotations).where(inArray(annotations.scenarioId, wipedScenarioIds)).run()
        tx.delete(scenarios).where(inArray(scenarios.id, wipedScenarioIds)).run()
      }
      if (wipedIds.length > 0) {
        tx.delete(featureFiles).where(inArray(featureFiles.featureId, wipedIds)).run()
        tx.delete(features).where(inArray(features.id, wipedIds)).run()
      }

      for (const feature of existing) {
        if (!wipedIds.includes(feature.id)) {
          keptByName.set(feature.name, feature)
        }
      }
    }

    const idsByName = new Map<string, number>()

    /** Reuses a kept row when the inventory still lists it, else inserts fresh. */
    const upsertFeature = (
      name: string,
      description: string,
      files: string[],
      parentId: number | null,
      sortOrder: number,
    ): number => {
      const kept = keptByName.get(name)
      if (kept) {
        if (kept.source === 'ai') {
          // Same feature, still ai territory: refresh the ai-owned fields in
          // place. A manual feature is the operator's — untouched.
          tx.update(features).set({ description, sortOrder }).where(eq(features.id, kept.id)).run()
          tx.delete(featureFiles).where(eq(featureFiles.featureId, kept.id)).run()
          insertFeatureFiles(tx, kept.id, files)
        }
        return kept.id
      }
      const row = tx.insert(features).values({
        projectId, parentId, name, description, sortOrder, source: 'ai',
      }).returning().get()
      insertFeatureFiles(tx, row.id, files)
      return row.id
    }

    let count = keptByName.size
    inventory.features.forEach((feature, index) => {
      const parentId = upsertFeature(feature.name, feature.description, feature.files, null, index)
      idsByName.set(feature.name, parentId)
      if (!keptByName.has(feature.name)) {
        count += 1
      }
      ;(feature.children ?? []).forEach((child, childIndex) => {
        const childId = upsertFeature(child.name, child.description, child.files, parentId, childIndex)
        idsByName.set(child.name, childId)
        if (!keptByName.has(child.name)) {
          count += 1
        }
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

/**
 * Stores the generated scenarios with stable per-feature, per-category codes.
 * The counters start past the feature's surviving codes (re-analysis keeps
 * manual rows), so generated codes never collide with the operator's.
 */
function insertScenarios(featureId: number, generated: FeatureScenarios): number {
  const db = getDB()
  const counters: Record<ScenarioCategory, number> = { happy: 0, edge: 0, error: 0 }
  let nextOrder = 0
  for (const row of db.select({ code: scenarios.code, sortOrder: scenarios.sortOrder }).from(scenarios).where(eq(scenarios.featureId, featureId)).all()) {
    for (const category of Object.keys(counters) as ScenarioCategory[]) {
      if (row.code.startsWith(`${CODE_PREFIX[category]}-`)) {
        counters[category] = Math.max(counters[category], codeNumber(row.code, category))
      }
    }
    nextOrder = Math.max(nextOrder, row.sortOrder + 1)
  }
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
        sortOrder: nextOrder + inserted,
        source: 'ai',
      }).run()
      inserted += 1
    }
  }
  return inserted
}

/**
 * Prompt for the connections step: every stored feature name with its
 * description (children indented), since relations may reference them too.
 */
function buildConnectionsDigest(inventory: FeatureInventory): string {
  const lines: string[] = []
  for (const feature of inventory.features) {
    lines.push(`- ${feature.name}: ${feature.description}`)
    for (const child of feature.children ?? []) {
      lines.push(`  - ${child.name}: ${child.description}`)
    }
  }
  return [
    'Features of the repository (indented lines are sub-features):',
    ...lines,
    '',
    'Describe how these features relate to each other. Use each feature\'s exact name as spelled above.',
  ].join('\n')
}

/**
 * Prompt for one feature's flow graph: the stored scenarios carry their final
 * codes (HP-1 / ED-1 / ER-1…), so generated nodes can reference them — manual
 * scenarios included, a flow may legitimately run through operator territory.
 */
function buildFlowDigest(name: string, description: string, featureId: number): string {
  const rows = getDB().select({
    code: scenarios.code,
    category: scenarios.category,
    action: scenarios.action,
    outcome: scenarios.outcome,
  }).from(scenarios).where(eq(scenarios.featureId, featureId)).orderBy(asc(scenarios.sortOrder)).all()
  const lines = rows.map((row) => `- [${row.code}] (${row.category}) ${row.action} → ${row.outcome}`)
  return [
    `Feature: ${name} — ${description}`,
    '',
    'Scenarios (code in brackets):',
    ...lines,
    '',
    'Draw the feature\'s control flow: a start node, concrete steps, at least one decision with labeled branches, the error paths, and an end node. Set scenarioCode on the nodes that implement a bracketed scenario.',
  ].join('\n')
}

/** Numeric suffix of a scenario code (`HP-12` → 12); 0 for alien shapes. */
function codeNumber(code: string, category: ScenarioCategory): number {
  const suffix = code.slice(CODE_PREFIX[category].length + 1)
  const parsed = Number.parseInt(suffix, 10)
  return Number.isInteger(parsed) ? parsed : 0
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

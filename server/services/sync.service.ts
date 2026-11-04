import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getDB, type Database } from '../db/client'
import {
  analyses,
  annotations,
  featureFiles,
  features,
  jobs,
  releases,
  repositories,
  scenarioRevisions,
  scenarios,
} from '../db/schema'
import { SyncUpdateSchema } from '../../shared/schemas'
import type { ScenarioCategory, SyncFeatureUpdate, SyncUpdate } from '../../shared/types'
import { decryptSecret } from '../utils/crypto'
import { CODE_PREFIX } from './analysis.service'
import { featureSlug } from './analysis/paths'
import { enqueueJob } from './jobs.service'
import { createGithubService, type GithubService } from './github.service'
import { createLlmClient, type LlmClient } from './llm.service'
import { projectExists } from './projects.service'

/**
 * The incremental sync pipeline: diff the repository since the last synced
 * sha, revise the stored spec and record a release.
 *
 * Steps (each reports progress on the `analyses` row — type `sync` — as it
 * runs, so the existing analyses endpoint shows sync progress too):
 *  1. `head` — branch head via `listCommits(owner, repo, branch, 1)`;
 *     head === `lastSyncedSha` → nothing to do, the run finishes
 *     `up-to-date` with zero LLM calls and no release.
 *  2. `diff` — `compareCommits(base, head)`; the base is the last synced sha,
 *     or the earliest available commit of the full list on a first-ever sync.
 *  3. `features` — affected features via the `featureFiles` join (a changed
 *     file maps to its feature's top-level ancestor), then one
 *     `generate('sync-update:<slug>')` call per affected feature; the LLM may
 *     flag extra features by name in its response and their updates apply too.
 *  4. `apply` — one transaction stores the release row, the scenario
 *     revisions and the new `lastSyncedSha`, so a crash never leaves a
 *     half-applied sync behind:
 *     - `new` inserts a `source='ai'` scenario with the next stable code;
 *     - `changed`/`fixed` rewrite `source='ai'` rows in place;
 *     - `gone` deletes `source='ai'` rows together with their annotations;
 *     - any match against a `source='manual'` scenario NEVER touches the row
 *       (spec §6.3): the proposed outcome is stored as a `scenarioRevisions`
 *       row with `state='proposed'` for the operator to review.
 *  5. `done` — stats land in `statsJson`.
 *
 * Errors — GitHub failures, schema-invalid LLM output — mark the analysis
 * `error` and rethrow so the jobs queue retry logic handles the attempts.
 */

export interface SyncResult {
  releaseId: number | null
}

/** Dependency seams for tests; production builds the real clients per run. */
export interface SyncDeps {
  github?: GithubService
  llm?: LlmClient
}

/** Error thrown when the project already has a queued or running sync job. */
export class SyncInProgressError extends Error {
  constructor(
    readonly projectId: number,
  ) {
    super(`Project ${projectId} already has a queued or running sync`)
    this.name = 'SyncInProgressError'
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type ScenarioRow = typeof scenarios.$inferSelect
type RepositoryRow = typeof repositories.$inferSelect

/** Stable snapshot of a scenario row, stored on revision rows as JSON. */
function snapshot(row: ScenarioRow): string {
  return JSON.stringify({
    code: row.code,
    context: row.context,
    action: row.action,
    outcome: row.outcome,
    category: row.category,
    source: row.source,
  })
}

function nowISO(): string {
  return new Date().toISOString()
}

/**
 * Starts a sync for the project: creates the queued `sync` analyses row,
 * enqueues its job and answers with the job id. Returns `null` when the
 * project does not exist and throws SyncInProgressError when a sync job for
 * the project is already `queued|running` in the jobs table.
 */
export function startSync(projectId: number): number | null {
  const db = getDB()
  if (!projectExists(projectId)) {
    return null
  }

  const activeJobs = db.select({ id: jobs.id, payloadJson: jobs.payloadJson })
    .from(jobs)
    .where(and(eq(jobs.type, 'sync'), inArray(jobs.status, ['queued', 'running'])))
    .all()
  if (activeJobs.some((job) => safeProjectId(job.payloadJson) === projectId)) {
    throw new SyncInProgressError(projectId)
  }

  db.insert(analyses).values({
    projectId,
    type: 'sync',
    status: 'queued',
    progress: 0,
    step: 'queued',
    statsJson: '{}',
    error: null,
    createdAt: nowISO(),
    finishedAt: null,
  }).run()

  return enqueueJob('sync', { projectId })
}

/** Best-effort projectId out of a stored job payload; NaN when malformed. */
function safeProjectId(payloadJson: string): number {
  try {
    return Number((JSON.parse(payloadJson) as { projectId?: unknown }).projectId)
  } catch {
    return Number.NaN
  }
}

/**
 * Runs the sync pipeline. The analyses row it reports progress on is the
 * newest queued/running `sync` row of the project (the one startSync created);
 * when there is none — a manual run, or a retry after a failure — a fresh row
 * is created so progress is always visible.
 */
export async function runSync(payload: { projectId: number }, deps: SyncDeps = {}): Promise<SyncResult> {
  const projectId = Number(payload.projectId)
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error(`sync job payload has no valid projectId: ${String(payload.projectId)}`)
  }

  const db = getDB()
  let analysis = db.select()
    .from(analyses)
    .where(and(
      eq(analyses.projectId, projectId),
      eq(analyses.type, 'sync'),
      inArray(analyses.status, ['queued', 'running']),
    ))
    .orderBy(desc(analyses.id))
    .get()
  if (!analysis) {
    analysis = db.insert(analyses).values({
      projectId,
      type: 'sync',
      status: 'queued',
      progress: 0,
      step: 'queued',
      statsJson: '{}',
      error: null,
      createdAt: nowISO(),
      finishedAt: null,
    }).returning().get()
  }

  try {
    return await syncRun(analysis.id, projectId, deps)
  } catch (error) {
    failSync(analysis.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

async function syncRun(analysisId: number, projectId: number, deps: SyncDeps): Promise<SyncResult> {
  const db = getDB()
  const repository = db.select().from(repositories)
    .where(eq(repositories.projectId, projectId))
    .orderBy(asc(repositories.id))
    .limit(1)
    .get()
  if (!repository) {
    failSync(analysisId, 'Project has no repository to sync; add one and start a new sync.')
    return { releaseId: null }
  }

  const github = deps.github ?? githubForRepository(repository)
  const llm = deps.llm ?? createLlmClient()

  const setStep = (progress: number, step: string) => {
    db.update(analyses).set({ status: 'running', progress, step }).where(eq(analyses.id, analysisId)).run()
  }

  setStep(10, 'head')
  const head = (await github.listCommits(repository.owner, repository.repo, repository.branch, 1))[0]
  if (!head) {
    failSync(analysisId, `Branch ${repository.branch} of ${repository.owner}/${repository.repo} has no commits to sync.`)
    return { releaseId: null }
  }
  if (head.sha === repository.lastSyncedSha) {
    finishSync(analysisId, 100, 'up-to-date', { features: 0, scenarios: 0, files: 0 })
    return { releaseId: null }
  }

  setStep(30, 'diff')
  let base = repository.lastSyncedSha
  if (!base) {
    // First-ever sync: diff from the earliest available commit of the full
    // list (the list is newest-first, so the last entry is the oldest).
    const fullList = await github.listCommits(repository.owner, repository.repo, repository.branch)
    base = fullList[fullList.length - 1]?.sha ?? head.sha
  }
  const comparison = await github.compareCommits(repository.owner, repository.repo, base, head.sha)
  const changedFiles = comparison.files.map((file) => file.filename)

  setStep(50, 'features')
  const affected = affectedFeatures(projectId, changedFiles)
  const updatesByFeature = new Map<number, SyncFeatureUpdate[]>()
  let firstUpdate: SyncUpdate | undefined
  for (const feature of affected) {
    const ownPaths = new Set(
      db.select({ path: featureFiles.path }).from(featureFiles)
        .where(eq(featureFiles.featureId, feature.id))
        .all()
        .map((row) => row.path),
    )
    const patches = comparison.files.filter((file) => ownPaths.has(file.filename))
    const featureScenarios = db.select().from(scenarios)
      .where(eq(scenarios.featureId, feature.id))
      .orderBy(asc(scenarios.sortOrder))
      .all()
    const update = await llm.generate(
      `sync-update:${featureSlug(feature.name)}`,
      SyncUpdateSchema,
      buildSyncPrompt(feature.name, feature.description, featureScenarios, patches),
    )
    firstUpdate ??= update
    collectUpdates(projectId, update, updatesByFeature)
  }

  setStep(70, 'apply')
  const authors = [...new Set(comparison.commits.map((commit) => commit.authorName).filter((name) => name !== ''))]
  const releaseValues = {
    sha: head.sha,
    title: firstUpdate?.title ?? head.message.split('\n')[0] ?? head.message,
    category: firstUpdate?.category ?? 'maintenance',
    highlight: (firstUpdate?.highlight ?? false) ? 1 : 0,
    summary: firstUpdate?.summary ?? head.message,
    authorsJson: JSON.stringify(authors),
    message: head.message,
    committedAt: head.committedAt,
  }

  const result = db.transaction((tx): { releaseId: number, revisions: number } => {
    const release = tx.insert(releases).values({
      projectId,
      repositoryId: repository.id,
      ...releaseValues,
    }).returning().get()

    let revisions = 0
    for (const [featureId, updates] of updatesByFeature) {
      revisions += applyFeatureUpdates(tx, featureId, updates, release.id)
    }
    tx.update(repositories)
      .set({ lastSyncedSha: head.sha })
      .where(eq(repositories.id, repository.id))
      .run()

    return { releaseId: release.id, revisions }
  })

  finishSync(analysisId, 100, 'done', {
    features: updatesByFeature.size,
    scenarios: result.revisions,
    files: changedFiles.length,
  })
  return { releaseId: result.releaseId }
}

/**
 * Top-level features affected by the changed files: a featureFiles row on any
 * feature (including sub-features) maps the change to its top-level ancestor,
 * matching the analysis pipeline which stores scenarios on top-level features.
 */
function affectedFeatures(projectId: number, changedFiles: string[]): Array<typeof features.$inferSelect> {
  const db = getDB()
  const allFeatures = db.select().from(features).where(eq(features.projectId, projectId)).all()
  if (changedFiles.length === 0 || allFeatures.length === 0) {
    return []
  }
  const byId = new Map(allFeatures.map((feature) => [feature.id, feature]))
  const topAncestor = (featureId: number): number => {
    let current = byId.get(featureId)
    while (current?.parentId !== null && current?.parentId !== undefined) {
      current = byId.get(current.parentId)
    }
    return current?.id ?? featureId
  }

  const changed = new Set(changedFiles)
  const touchedIds = db.select({ featureId: featureFiles.featureId })
    .from(featureFiles)
    .where(inArray(featureFiles.path, [...changed]))
    .all()
    .map((row) => topAncestor(row.featureId))

  return [...new Set(touchedIds)]
    .map((id) => byId.get(id))
    .filter((feature): feature is typeof features.$inferSelect => feature !== undefined)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/** Files a feature's update slice from the LLM under its name, deduplicated. */
function collectUpdates(projectId: number, update: SyncUpdate, into: Map<number, SyncFeatureUpdate[]>): void {
  const allFeatures = getDB().select().from(features).where(eq(features.projectId, projectId)).all()
  for (const featureUpdate of update.featureUpdates) {
    const target = allFeatures.find((feature) => feature.name === featureUpdate.featureName)
    if (!target) {
      // The LLM named a feature this project does not have; nothing to update.
      continue
    }
    into.set(target.id, [...into.get(target.id) ?? [], featureUpdate])
  }
}

/**
 * Applies one feature's scenario updates inside the caller's transaction and
 * returns the number of revision rows written. Manual scenarios are never
 * modified: their updates become `proposed` revisions only.
 */
function applyFeatureUpdates(tx: Transaction, featureId: number, updates: SyncFeatureUpdate[], releaseId: number): number {
  let written = 0
  for (const update of updates) {
    for (const scenario of update.scenarios) {
      if (scenario.kind === 'new') {
        const row = tx.insert(scenarios).values({
          featureId,
          context: scenario.context,
          action: scenario.action,
          outcome: scenario.outcome,
          category: scenario.category,
          code: nextScenarioCode(tx, featureId, scenario.category),
          sortOrder: nextScenarioOrder(tx, featureId),
          source: 'ai',
        }).returning().get()
        tx.insert(scenarioRevisions).values({
          releaseId,
          scenarioId: row.id,
          featureId,
          kind: 'new',
          state: 'applied',
          beforeJson: null,
          afterJson: snapshot(row),
        }).run()
        written += 1
        continue
      }

      if (!scenario.matchCode) {
        // changed/fixed/gone need the stable code to address the row.
        continue
      }
      const target = tx.select().from(scenarios)
        .where(and(eq(scenarios.featureId, featureId), eq(scenarios.code, scenario.matchCode)))
        .get()
      if (!target) {
        continue
      }

      if (scenario.kind === 'gone') {
        if (target.source === 'ai') {
          tx.delete(annotations).where(eq(annotations.scenarioId, target.id)).run()
          tx.delete(scenarios).where(eq(scenarios.id, target.id)).run()
          // scenarioId stays null: the row is gone and the FK has no cascade —
          // the beforeJson snapshot (with the code) identifies the scenario.
          tx.insert(scenarioRevisions).values({
            releaseId,
            scenarioId: null,
            featureId,
            kind: 'gone',
            state: 'applied',
            beforeJson: snapshot(target),
            afterJson: null,
          }).run()
        } else {
          // A manual scenario is never deleted — the removal is proposed only.
          tx.insert(scenarioRevisions).values({
            releaseId,
            scenarioId: target.id,
            featureId,
            kind: 'gone',
            state: 'proposed',
            beforeJson: snapshot(target),
            afterJson: null,
          }).run()
        }
        written += 1
        continue
      }

      // kind === 'changed' | 'fixed'
      const proposed = {
        context: scenario.context,
        action: scenario.action,
        outcome: scenario.outcome,
        category: scenario.category,
      }
      if (target.source === 'ai') {
        const updated: ScenarioRow = { ...target, ...proposed }
        tx.update(scenarios).set(proposed).where(eq(scenarios.id, target.id)).run()
        tx.insert(scenarioRevisions).values({
          releaseId,
          scenarioId: target.id,
          featureId,
          kind: scenario.kind,
          state: 'applied',
          beforeJson: snapshot(target),
          afterJson: snapshot(updated),
        }).run()
      } else {
        tx.insert(scenarioRevisions).values({
          releaseId,
          scenarioId: target.id,
          featureId,
          kind: scenario.kind,
          state: 'proposed',
          beforeJson: snapshot(target),
          afterJson: snapshot({ ...target, ...proposed }),
        }).run()
      }
      written += 1
    }
  }
  return written
}

/**
 * Next stable per-feature, per-category code (`HP-3`): one more than the
 * highest existing number across all of the feature's scenarios, manual ones
 * included, so codes stay unique within the feature.
 */
function nextScenarioCode(tx: Transaction, featureId: number, category: ScenarioCategory): string {
  const prefix = CODE_PREFIX[category]
  const siblings = tx.select({ code: scenarios.code }).from(scenarios)
    .where(eq(scenarios.featureId, featureId))
    .all()
    .filter((row) => row.code.startsWith(`${prefix}-`))
  const next = siblings.reduce((max, row) => {
    const parsed = Number.parseInt(row.code.slice(prefix.length + 1), 10)
    return Number.isInteger(parsed) ? Math.max(max, parsed) : max
  }, 0) + 1
  return `${prefix}-${next}`
}

/** Next free sortOrder of a feature's scenarios (max + 1, starting at 0). */
function nextScenarioOrder(tx: Transaction, featureId: number): number {
  const siblings = tx.select({ sortOrder: scenarios.sortOrder }).from(scenarios)
    .where(eq(scenarios.featureId, featureId))
    .all()
  return siblings.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1
}

/** The prompt one affected feature's update is generated from. */
function buildSyncPrompt(
  name: string,
  description: string,
  featureScenarios: ScenarioRow[],
  patches: Array<{ filename: string, patch?: string }>,
): string {
  const scenarioLines = featureScenarios.map((scenario) =>
    `- [${scenario.code}] (${scenario.source}) ${scenario.category} | ${scenario.context} :: ${scenario.action} → ${scenario.outcome}`,
  )
  const patchLines = patches.map((file) => `--- ${file.filename}\n${file.patch ?? '(no patch available)'}`)
  return [
    `Feature: ${name}`,
    `Description: ${description}`,
    'Stored scenarios:',
    ...scenarioLines,
    'Changed files with patches:',
    ...patchLines,
    'Produce the scenario revisions (new / changed / fixed / gone) this diff implies for the feature.',
    'changed, fixed and gone entries must carry the matchCode of the stored scenario they address.',
  ].join('\n')
}

/** Parks the sync analyses row as `error` with a human-readable cause. */
function failSync(analysisId: number, message: string): void {
  getDB().update(analyses).set({
    status: 'error',
    step: 'error',
    error: message,
    finishedAt: nowISO(),
  }).where(eq(analyses.id, analysisId)).run()
}

/** Finishes the sync analyses row as `done` with the given step and stats. */
function finishSync(
  analysisId: number,
  progress: number,
  step: string,
  stats: { features: number, scenarios: number, files: number },
): void {
  getDB().update(analyses).set({
    status: 'done',
    progress,
    step,
    statsJson: JSON.stringify(stats),
    finishedAt: nowISO(),
  }).where(eq(analyses.id, analysisId)).run()
}

/** GitHub client for the stored repository, decrypting its PAT when present. */
function githubForRepository(repository: RepositoryRow): GithubService {
  const token = repository.patEncrypted ? decryptSecret(repository.patEncrypted) : undefined
  return createGithubService(token ? { token } : {})
}

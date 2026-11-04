import { and, asc, eq, inArray } from 'drizzle-orm'
import { getDB, type Database } from '../db/client'
import { annotations, features, scenarioRevisions, scenarios } from '../db/schema'
import { CODE_PREFIX } from './analysis.service'
import type {
  AnnotationDTO,
  CreateAnnotationInput,
  CreateScenarioInput,
  FeatureDetail,
  FeatureNode,
  ScenarioCategory,
  ScenarioDTO,
  ScenarioGroupDTO,
  UpdateScenarioInput,
} from '../../shared/types'

/**
 * Spec browsing: the feature tree, scenario groups, operator edits and
 * annotations. Read APIs shape analysis rows for the UI; write APIs follow
 * the manual-edit rules Task 10's sync relies on — anything an operator
 * creates or touches is `manual` and keeps its stable per-category code
 * (HP-n / ED-n / ER-n) across syncs.
 */

type ScenarioRow = typeof scenarios.$inferSelect
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** Numeric suffix of a scenario code (`HP-12` → 12); 0 for alien shapes. */
function codeNumber(code: string, category: ScenarioCategory): number {
  const suffix = code.slice(CODE_PREFIX[category].length + 1)
  const parsed = Number.parseInt(suffix, 10)
  return Number.isInteger(parsed) ? parsed : 0
}

/** Anything that can run a select: the db handle or a transaction handle. */
type QueryRunner = Database | Transaction

/**
 * Next free scenario code in a category within a feature (highest existing
 * suffix + 1, so a deleted code may be reused but a live one is never
 * collided with).
 */
function nextCodeInCategory(runner: QueryRunner, featureId: number, category: ScenarioCategory): string {
  const siblings = runner.select({ code: scenarios.code }).from(scenarios).where(eq(scenarios.featureId, featureId)).all()
    .filter((row) => row.code.startsWith(`${CODE_PREFIX[category]}-`))
  const nextNumber = siblings.reduce((max, row) => Math.max(max, codeNumber(row.code, category)), 0) + 1
  return `${CODE_PREFIX[category]}-${nextNumber}`
}

/**
 * Shapes a scenario row for the API. `hasProposal`/`proposalId` mark
 * scenarios whose pending sync revision is parked as "suggested" — only the
 * feature detail passes the parked revision id, so the spec page can offer
 * Apply/Dismiss on the row.
 */
function toScenarioDTO(row: ScenarioRow, proposalId?: number): ScenarioDTO {
  return {
    id: row.id,
    code: row.code,
    context: row.context,
    action: row.action,
    outcome: row.outcome,
    category: row.category,
    source: row.source,
    ...(proposalId !== undefined ? { hasProposal: true, proposalId } : {}),
  }
}

/**
 * The project's feature tree in analysis order (sortOrder), each node with
 * its total scenario count. Analysis stores one level of sub-features; the
 * builder stays recursive so deeper inventories render too.
 */
export function getFeatureTree(projectId: number): FeatureNode[] {
  const db = getDB()
  const rows = db.select({
    id: features.id,
    parentId: features.parentId,
    name: features.name,
    description: features.description,
    sortOrder: features.sortOrder,
  }).from(features).where(eq(features.projectId, projectId)).orderBy(asc(features.sortOrder)).all()

  const counts = new Map<number, number>()
  const featureIds = rows.map((row) => row.id)
  if (featureIds.length > 0) {
    for (const row of db.select({ featureId: scenarios.featureId }).from(scenarios).where(inArray(scenarios.featureId, featureIds)).all()) {
      counts.set(row.featureId, (counts.get(row.featureId) ?? 0) + 1)
    }
  }

  const nodes = new Map<number, FeatureNode>(rows.map((row) => [row.id, {
    id: row.id,
    name: row.name,
    description: row.description,
    parentId: row.parentId,
    scenarioCount: counts.get(row.id) ?? 0,
    children: [],
  }]))

  const roots: FeatureNode[] = []
  for (const row of rows) {
    const node = nodes.get(row.id)
    if (!node) {
      continue
    }
    const parent = row.parentId === null ? undefined : nodes.get(row.parentId)
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

/**
 * One feature with its scenarios grouped by context, groups and rows in
 * stored order. Null when the feature does not exist.
 */
export function getFeatureDetail(featureId: number): FeatureDetail | null {
  const db = getDB()
  const feature = db.select({
    id: features.id,
    name: features.name,
    description: features.description,
  }).from(features).where(eq(features.id, featureId)).get()
  if (!feature) {
    return null
  }

  const groups: ScenarioGroupDTO[] = []
  const byContext = new Map<string, ScenarioGroupDTO>()
  const rows = db.select().from(scenarios).where(eq(scenarios.featureId, featureId)).orderBy(asc(scenarios.sortOrder)).all()

  // Scenario ids with a parked "suggested" revision → that revision's id, in
  // one query for the whole feature (what the spec page badges and what its
  // Apply/Dismiss actions address).
  const proposalsByScenario = new Map<number, number>()
  if (rows.length > 0) {
    const pending = db.select({ id: scenarioRevisions.id, scenarioId: scenarioRevisions.scenarioId })
      .from(scenarioRevisions)
      .where(and(
        inArray(scenarioRevisions.scenarioId, rows.map((row) => row.id)),
        eq(scenarioRevisions.state, 'proposed'),
      ))
      .all()
    for (const row of pending) {
      if (row.scenarioId !== null) {
        proposalsByScenario.set(row.scenarioId, row.id)
      }
    }
  }

  for (const row of rows) {
    let group = byContext.get(row.context)
    if (!group) {
      group = { context: row.context, scenarios: [] }
      byContext.set(row.context, group)
      groups.push(group)
    }
    group.scenarios.push(toScenarioDTO(row, proposalsByScenario.get(row.id)))
  }

  return { feature, groups }
}

/**
 * Creates an operator-written scenario with `source='manual'` and the next
 * free code in its category (highest existing suffix + 1, so a deleted code
 * may be reused but a live one is never collided with). Null when the
 * feature does not exist.
 */
export function createManualScenario(featureId: number, input: CreateScenarioInput): ScenarioDTO | null {
  const db = getDB()
  const feature = db.select({ id: features.id }).from(features).where(eq(features.id, featureId)).get()
  if (!feature) {
    return null
  }

  return db.transaction((tx: Transaction): ScenarioDTO => {
    const siblings = tx.select({ code: scenarios.code, sortOrder: scenarios.sortOrder }).from(scenarios).where(
      eq(scenarios.featureId, featureId),
    ).all().filter((row) => row.code.startsWith(`${CODE_PREFIX[input.category]}-`))

    const nextOrder = siblings.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1
    const code = nextCodeInCategory(tx, featureId, input.category)

    const row = tx.insert(scenarios).values({
      featureId,
      context: input.context,
      action: input.action,
      outcome: input.outcome,
      category: input.category,
      code,
      sortOrder: nextOrder,
      source: 'manual',
    }).run()

    return {
      id: row.lastInsertRowid as number,
      code,
      context: input.context,
      action: input.action,
      outcome: input.outcome,
      category: input.category,
      source: 'manual',
    }
  })
}

/**
 * Applies an operator edit to a scenario. A real change flips the row to
 * `source='manual'` — sync then protects the operator's version; an empty or
 * no-op patch leaves the row exactly as it was (no spurious ownership flip).
 * A category change also regenerates the code for the new category (next
 * free code), so a scenario that became an error path no longer rides its
 * stale HP-n code. Null when the scenario does not exist.
 */
export function updateScenario(id: number, patch: UpdateScenarioInput): ScenarioDTO | null {
  const db = getDB()
  const existing = db.select().from(scenarios).where(eq(scenarios.id, id)).get()
  if (!existing) {
    return null
  }

  const updated: ScenarioRow = {
    ...existing,
    context: patch.context ?? existing.context,
    action: patch.action ?? existing.action,
    outcome: patch.outcome ?? existing.outcome,
    category: patch.category ?? existing.category,
    code: patch.category === undefined || patch.category === existing.category
      ? existing.code
      : nextCodeInCategory(db, existing.featureId, patch.category),
  }
  const changed = updated.context !== existing.context || updated.action !== existing.action
    || updated.outcome !== existing.outcome || updated.category !== existing.category
    || updated.code !== existing.code
  if (changed) {
    // A real edit hands the row to the operator: sync then proposes instead
    // of overwriting. A no-op patch leaves ownership exactly as it was.
    updated.source = 'manual'
  }

  if (changed) {
    db.update(scenarios).set({
      context: updated.context,
      action: updated.action,
      outcome: updated.outcome,
      category: updated.category,
      code: updated.code,
      source: 'manual',
    }).where(eq(scenarios.id, id)).run()
  }

  return toScenarioDTO(updated)
}

/**
 * Removes a scenario together with its annotations — `annotations.scenarioId`
 * has no DB-level cascade, so the service does the cleanup in one
 * transaction, annotations first. False when it was already gone.
 */
export function deleteScenario(id: number): boolean {
  const db = getDB()
  return db.transaction((tx: Transaction): boolean => {
    tx.delete(annotations).where(eq(annotations.scenarioId, id)).run()
    const row = tx.delete(scenarios).where(eq(scenarios.id, id)).run()
    return row.changes > 0
  })
}

/** True while the scenario row exists. */
export function scenarioExists(id: number): boolean {
  return getDB().select({ id: scenarios.id }).from(scenarios).where(eq(scenarios.id, id)).get() !== undefined
}

/** An operator's annotations on one scenario, oldest first. */
export function listAnnotations(scenarioId: number): AnnotationDTO[] {
  return getDB().select({
    id: annotations.id,
    scenarioId: annotations.scenarioId,
    body: annotations.body,
    author: annotations.author,
    createdAt: annotations.createdAt,
  }).from(annotations).where(eq(annotations.scenarioId, scenarioId)).orderBy(asc(annotations.id)).all()
}

/**
 * Adds an operator note to a scenario. Null when the scenario does not
 * exist. The author is fixed for now — single-operator tool, no accounts
 * beyond the session gate.
 */
export function addAnnotation(scenarioId: number, input: CreateAnnotationInput, author = 'operator'): AnnotationDTO | null {
  const db = getDB()
  const scenario = db.select({ id: scenarios.id }).from(scenarios).where(eq(scenarios.id, scenarioId)).get()
  if (!scenario) {
    return null
  }

  const createdAt = new Date().toISOString()
  const row = db.insert(annotations).values({
    scenarioId,
    body: input.body,
    author,
    createdAt,
  }).run()

  return {
    id: row.lastInsertRowid as number,
    scenarioId,
    body: input.body,
    author,
    createdAt,
  }
}

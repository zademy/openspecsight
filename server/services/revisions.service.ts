import { eq } from 'drizzle-orm'
import { getDB, type Database } from '../db/client'
import { annotations, scenarioRevisions, scenarios } from '../db/schema'
import type { ScenarioCategory } from '../../shared/types'

/**
 * Operator decisions on sync proposals (design §6.3): a parked `proposed`
 * revision can be applied onto its scenario or dismissed. Both outcomes end
 * the proposal's `proposed` state — `applied` when the operator adopted the
 * suggested text, `discarded` when they kept their own. The scenario stays
 * `source='manual'` either way: the operator owns the row now, so future
 * syncs keep proposing changes rather than overwriting it.
 */

type RevisionRow = typeof scenarioRevisions.$inferSelect
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** Outcome of an apply/discard attempt on one revision row. */
export type RevisionDecision = 'ok' | 'not_found' | 'not_proposed'

/** Scenario fields a proposal carries in its afterJson snapshot. */
interface ScenarioSnapshot {
  context: string
  action: string
  outcome: string
  category: ScenarioCategory
}

/** Parses a stored afterJson snapshot; null when absent or off-invariant. */
function parseSnapshot(raw: string | null): ScenarioSnapshot | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScenarioSnapshot>
    const validCategory = parsed.category === 'happy' || parsed.category === 'edge' || parsed.category === 'error'
    if (
      typeof parsed.context === 'string' && typeof parsed.action === 'string'
      && typeof parsed.outcome === 'string' && validCategory
    ) {
      return parsed as ScenarioSnapshot
    }
  } catch {
    // Fall through: a malformed snapshot must not corrupt the spec row.
  }
  return null
}

/**
 * Applies a proposed revision onto its scenario: the suggested context,
 * action, outcome and category overwrite the operator's text (reversible by
 * editing). An applied removal deletes the scenario with its annotations —
 * the same cleanup the sync itself performs. `not_proposed` for a revision
 * that is not parked (already applied, discarded, or an applied-by-sync row),
 * so a double-click never double-applies.
 */
export function applyScenarioRevision(id: number): RevisionDecision {
  const db = getDB()
  const revision = db.select().from(scenarioRevisions).where(eq(scenarioRevisions.id, id)).get()
  if (!revision) {
    return 'not_found'
  }
  if (revision.state !== 'proposed') {
    return 'not_proposed'
  }

  return db.transaction((tx: Transaction): RevisionDecision => {
    if (revision.kind === 'gone') {
      // A removal proposal carries no afterJson: applying it removes the row
      // and its annotations. The revision detaches first — the FK has no
      // cascade — and the beforeJson snapshot keeps identifying the revision.
      if (revision.scenarioId !== null) {
        tx.delete(annotations).where(eq(annotations.scenarioId, revision.scenarioId)).run()
        tx.update(scenarioRevisions).set({ state: 'applied', scenarioId: null })
          .where(eq(scenarioRevisions.id, id)).run()
        tx.delete(scenarios).where(eq(scenarios.id, revision.scenarioId)).run()
      } else {
        tx.update(scenarioRevisions).set({ state: 'applied' })
          .where(eq(scenarioRevisions.id, id)).run()
      }
      return 'ok'
    }

    const scenario = revision.scenarioId === null
      ? undefined
      : tx.select().from(scenarios).where(eq(scenarios.id, revision.scenarioId)).get()
    const proposed = parseSnapshot(revision.afterJson)
    if (!scenario || !proposed) {
      // The scenario or its snapshot vanished underneath the proposal — park
      // the row as discarded rather than half-apply unverifiable data.
      tx.update(scenarioRevisions).set({ state: 'discarded' }).where(eq(scenarioRevisions.id, id)).run()
      return 'ok'
    }

    tx.update(scenarios).set({
      context: proposed.context,
      action: proposed.action,
      outcome: proposed.outcome,
      category: proposed.category,
      // Manual territory stays manual: the operator adopted the text, not
      // surrendered ownership.
      source: 'manual',
    }).where(eq(scenarios.id, scenario.id)).run()
    tx.update(scenarioRevisions).set({ state: 'applied' }).where(eq(scenarioRevisions.id, id)).run()
    return 'ok'
  })
}

/**
 * Dismisses a proposed revision: the proposal is parked as `discarded` and
 * the scenario stays untouched. `not_proposed` for a revision that is not
 * parked, so dismissing twice (or after applying) is rejected.
 */
export function discardScenarioRevision(id: number): RevisionDecision {
  const db = getDB()
  const revision: RevisionRow | undefined = db.select().from(scenarioRevisions).where(eq(scenarioRevisions.id, id)).get()
  if (!revision) {
    return 'not_found'
  }
  if (revision.state !== 'proposed') {
    return 'not_proposed'
  }

  db.update(scenarioRevisions).set({ state: 'discarded' }).where(eq(scenarioRevisions.id, id)).run()
  return 'ok'
}

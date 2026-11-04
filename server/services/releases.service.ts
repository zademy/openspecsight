import { eq, inArray } from 'drizzle-orm'
import { getDB } from '../db/client'
import { features, releases, scenarioRevisions, scenarios } from '../db/schema'
import type {
  ReleaseCounts,
  ReleaseDayGroup,
  ReleaseDetail,
  ReleaseListQuery,
} from '../../shared/types'

/**
 * Changes: releases recorded by the sync pipeline and their scenario
 * revisions. The list API groups releases by UTC calendar day with per-kind
 * counts; the detail API resolves each revision row back into the scenario
 * snapshot it changed (beforeJson/afterJson written by the sync).
 *
 * Source-filter semantics (GET /api/projects/:id/releases?source=):
 * - `ai` — every revision row of the release resolves to an ai scenario:
 *   applied rows whose scenario is live with source `ai`, applied `gone`
 *   rows (scenarioId null — the sync only hard-deletes ai scenarios), and
 *   releases without revision rows at all.
 * - `manual` — at least one revision row involves manual territory: a live
 *   scenario with source `manual`, or a `proposed` row (proposals only ever
 *   target manual scenarios).
 */

type RevisionRow = typeof scenarioRevisions.$inferSelect
type ReleaseRow = typeof releases.$inferSelect

/** Scenario fields the sync stores in beforeJson/afterJson. */
interface ScenarioSnapshot {
  code: string
  action: string
  outcome: string
}

/** Parses a stored snapshot; null when absent or not matching the invariant. */
function parseSnapshot(raw: string | null): ScenarioSnapshot | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScenarioSnapshot>
    if (typeof parsed.code !== 'string' || typeof parsed.action !== 'string' || typeof parsed.outcome !== 'string') {
      return null
    }
    return parsed as ScenarioSnapshot
  } catch {
    return null
  }
}

function releaseDTO(row: ReleaseRow): Omit<ReleaseDetail, 'sections'> {
  let authors: string[] = []
  try {
    const parsed = JSON.parse(row.authorsJson) as unknown
    if (Array.isArray(parsed)) {
      authors = parsed.filter((author): author is string => typeof author === 'string')
    }
  } catch {
    authors = []
  }

  return {
    id: row.id,
    sha: row.sha,
    title: row.title,
    category: row.category,
    highlight: row.highlight !== 0,
    summary: row.summary,
    authors,
    message: row.message,
    committedAt: row.committedAt,
  }
}

function emptyCounts(): ReleaseCounts {
  return { new: 0, changed: 0, gone: 0, fixed: 0 }
}

/**
 * Whether the revision touches manual territory: a proposal (they only ever
 * target manual scenarios) or a live manual scenario row.
 */
function isManualRevision(row: { state: RevisionRow['state'], scenarioSource: typeof scenarios.$inferSelect['source'] | null }): boolean {
  return row.state === 'proposed' || row.scenarioSource === 'manual'
}

export function listReleaseDays(projectId: number, query: ReleaseListQuery = {}): ReleaseDayGroup[] {
  const db = getDB()
  const releaseRows = db.select().from(releases).where(eq(releases.projectId, projectId)).all()
  if (releaseRows.length === 0) {
    return []
  }

  const revisionRows = db.select({
    releaseId: scenarioRevisions.releaseId,
    featureId: scenarioRevisions.featureId,
    kind: scenarioRevisions.kind,
    state: scenarioRevisions.state,
    scenarioSource: scenarios.source,
  })
    .from(scenarioRevisions)
    .leftJoin(scenarios, eq(scenarioRevisions.scenarioId, scenarios.id))
    .where(inArray(scenarioRevisions.releaseId, releaseRows.map((row) => row.id)))
    .all()

  const revisionsByRelease = new Map<number, typeof revisionRows>()
  for (const row of revisionRows) {
    revisionsByRelease.set(row.releaseId, [...revisionsByRelease.get(row.releaseId) ?? [], row])
  }

  const source = query.source ?? 'all'
  const q = query.q?.toLowerCase()

  const items = releaseRows
    .filter((row) => {
      const revisions = revisionsByRelease.get(row.id) ?? []
      if (source === 'ai' && revisions.some(isManualRevision)) {
        return false
      }
      if (source === 'manual' && !revisions.some(isManualRevision)) {
        return false
      }
      if (query.featureId !== undefined && !revisions.some((revision) => revision.featureId === query.featureId)) {
        return false
      }
      if (q !== undefined && !row.title.toLowerCase().includes(q) && !row.summary.toLowerCase().includes(q)) {
        return false
      }
      return true
    })
    .map((row) => {
      const counts = emptyCounts()
      for (const revision of revisionsByRelease.get(row.id) ?? []) {
        counts[revision.kind] += 1
      }
      return { ...releaseDTO(row), counts }
    })
    .sort((a, b) => b.committedAt.localeCompare(a.committedAt) || b.id - a.id)

  // Group by the UTC calendar day of committedAt (ISO strings compare by date prefix).
  const byDate = new Map<string, ReleaseDayGroup>()
  for (const item of items) {
    const date = item.committedAt.slice(0, 10)
    if (!byDate.has(date)) {
      byDate.set(date, { date, releases: [] })
    }
    byDate.get(date)!.releases.push(item)
  }

  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
}

export function getReleaseDetail(releaseId: number): ReleaseDetail | null {
  const db = getDB()
  const row = db.select().from(releases).where(eq(releases.id, releaseId)).get()
  if (!row) {
    return null
  }

  const sections: ReleaseDetail['sections'] = { new: [], changed: [], gone: [], fixed: [] }

  const revisionRows = db.select({
    revision: scenarioRevisions,
    featureName: features.name,
  })
    .from(scenarioRevisions)
    .innerJoin(features, eq(scenarioRevisions.featureId, features.id))
    .where(eq(scenarioRevisions.releaseId, releaseId))
    .all()

  for (const { revision, featureName } of revisionRows) {
    // The state a release leaves the scenario in: applied removals only keep
    // the old snapshot, every other kind reads the after snapshot.
    const display = parseSnapshot(revision.kind === 'gone' ? revision.beforeJson : revision.afterJson)
    if (!display) {
      continue
    }
    const before = revision.kind === 'gone' ? null : parseSnapshot(revision.beforeJson)
    sections[revision.kind].push({
      kind: revision.kind,
      state: revision.state,
      scenarioId: revision.scenarioId,
      code: display.code,
      featureId: revision.featureId,
      featureName,
      action: display.action,
      outcome: display.outcome,
      ...(before ? { before: { action: before.action, outcome: before.outcome } } : {}),
    })
  }

  return { ...releaseDTO(row), sections }
}

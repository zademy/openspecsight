import { asc, eq, inArray } from 'drizzle-orm'
import { getDB } from '../db/client'
import { connections, features, projects, scenarios } from '../db/schema'
import type { MapData, MapEdge, MapNode } from '../../shared/types'

/**
 * The project map: every feature as a node, every stored connection as one
 * collapsed edge. Pure read — the service shapes rows for GET
 * /api/projects/:id/map so the visualization page stays dumb. `empty` marks
 * projects without connections (pre-Plan-2 analyses) so the page can show
 * its empty state instead of a bare canvas.
 */
export function getMap(projectId: number): MapData | null {
  const db = getDB()
  if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()) {
    return null
  }

  const featureRows = db.select({
    id: features.id,
    parentId: features.parentId,
    name: features.name,
  }).from(features).where(eq(features.projectId, projectId)).orderBy(asc(features.sortOrder)).all()
  const featureIds = featureRows.map((row) => row.id)
  const knownIds = new Set(featureIds)

  const scenarioRows = featureIds.length
    ? db.select({ featureId: scenarios.featureId }).from(scenarios).where(inArray(scenarios.featureId, featureIds)).all()
    : []
  const countsById = new Map<number, number>()
  for (const row of scenarioRows) {
    countsById.set(row.featureId, (countsById.get(row.featureId) ?? 0) + 1)
  }

  const nodes: MapNode[] = featureRows.map((row) => ({
    id: row.id,
    featureId: row.id,
    name: row.name,
    scenarioCount: countsById.get(row.id) ?? 0,
    isChild: row.parentId !== null,
  }))

  const connectionRows = featureIds.length
    ? db.select().from(connections).where(eq(connections.projectId, projectId)).all()
    : []

  // All connections between the same feature pair share one edge, from the
  // lower feature id — direction is not drawn, only the relation types are.
  const pairs = new Map<string, { from: number, to: number, types: Set<string> }>()
  for (const row of connectionRows) {
    if (!knownIds.has(row.fromFeatureId) || !knownIds.has(row.toFeatureId)) {
      continue
    }
    const from = Math.min(row.fromFeatureId, row.toFeatureId)
    const to = Math.max(row.fromFeatureId, row.toFeatureId)
    const key = `${from}:${to}`
    const pair = pairs.get(key) ?? { from, to, types: new Set<string>() }
    pair.types.add(row.type)
    pairs.set(key, pair)
  }

  const edges: MapEdge[] = [...pairs.values()]
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((pair) => ({ from: pair.from, to: pair.to, types: [...pair.types].sort() }))

  return { nodes, edges, empty: edges.length === 0 }
}

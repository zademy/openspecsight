import { eq, or } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { connections, flows } from '../../db/schema'
import type { ConnectionEdge, FlowGraph } from '../../../shared/types'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** The write handle the map helpers run on: the plain database or a transaction. */
type WriteHandle = Database | Transaction

/**
 * Stores the given relations, dropping everything the map cannot draw:
 * self-links, unknown feature names and repeated (from, to, type) triples.
 * Returns the kept and dropped counts for the stats badge. Shared by the
 * initial analysis (fresh tables) and sync (one feature's refreshed set).
 */
export function storeConnections(
  handle: WriteHandle,
  projectId: number,
  idsByName: Map<string, number>,
  edges: ConnectionEdge[],
): { inserted: number, skipped: number } {
  const seen = new Set<string>()
  let inserted = 0
  let skipped = 0
  for (const edge of edges) {
    const fromId = idsByName.get(edge.fromFeature)
    const toId = idsByName.get(edge.toFeature)
    const key = `${edge.fromFeature}|${edge.toFeature}|${edge.type}`
    if (fromId === undefined || toId === undefined || fromId === toId || seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    handle.insert(connections).values({ projectId, fromFeatureId: fromId, toFeatureId: toId, type: edge.type }).run()
    inserted += 1
  }
  return { inserted, skipped }
}

/** Upsert keyed by the flow's unique featureId: one graph per feature. */
export function upsertFlow(handle: WriteHandle, featureId: number, graph: FlowGraph): void {
  const graphJson = JSON.stringify(graph)
  handle.insert(flows).values({ featureId, graphJson })
    .onConflictDoUpdate({ target: flows.featureId, set: { graphJson } })
    .run()
}

/** Removes every relation touching the feature — the sync connection refresh's delete half. */
export function deleteConnectionsTouching(handle: WriteHandle, featureId: number): void {
  handle.delete(connections).where(or(
    eq(connections.fromFeatureId, featureId),
    eq(connections.toFeatureId, featureId),
  )).run()
}

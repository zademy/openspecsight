import { sql } from 'drizzle-orm'
import type { Database } from './client'

/** One retrieval hit feeding the Ask pipeline: a scenario plus its feature name. */
export interface ScenarioSearchHit {
  scenarioId: number
  featureId: number
  code: string
  context: string
  action: string
  outcome: string
  featureName: string
}

/**
 * Turns free text into a safe FTS5 query: every whitespace-separated token
 * becomes a quoted prefix phrase ("tok"*). Quoting makes FTS5 treat the
 * token literally, so operators in user input (AND OR NOT, parentheses,
 * colons, stray quotes) are never parsed as query syntax; embedded quotes
 * are stripped first to keep the quoting intact. No tokens left means
 * nothing to search.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replaceAll('"', ''))
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    return null
  }
  return tokens.map((token) => `"${token}"*`).join(' ')
}

/**
 * Full-text search over the scenario spec of one project: FTS5 MATCH on
 * scenarios_fts (context/action/outcome + owning feature name), ranked by
 * bm25, best first. Returns at most `limit` hits, [] for empty or
 * non-matching input — never throws on odd query syntax.
 */
export async function searchScenarios(db: Database, projectId: number, query: string, limit = 8): Promise<ScenarioSearchHit[]> {
  const ftsQuery = toFtsQuery(query)
  if (ftsQuery === null) {
    return []
  }

  return db.all<ScenarioSearchHit>(sql`
    SELECT s.id AS scenarioId,
           s.featureId AS featureId,
           s.code AS code,
           s.context AS context,
           s.action AS action,
           s.outcome AS outcome,
           f.name AS featureName
    FROM scenarios_fts
    JOIN scenarios s ON s.id = scenarios_fts.rowid
    JOIN features f ON f.id = s.featureId
    WHERE scenarios_fts MATCH ${ftsQuery}
      AND f.projectId = ${projectId}
    ORDER BY bm25(scenarios_fts)
    LIMIT ${limit}
  `)
}

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

/** Every whitespace-separated token as a safe FTS5 prefix term ("tok"*). */
function toFtsTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => token.replaceAll('"', ''))
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"*`)
}

/**
 * Turns free text into a safe FTS5 query: every whitespace-separated token
 * becomes a quoted prefix phrase ("tok"*), joined by spaces (implicit AND).
 * Quoting makes FTS5 treat the token literally, so operators in user input
 * (AND OR NOT, parentheses, colons, stray quotes) are never parsed as query
 * syntax; embedded quotes are stripped first to keep the quoting intact.
 * No tokens left means nothing to search.
 */
export function toFtsQuery(query: string): string | null {
  const terms = toFtsTerms(query)
  if (terms.length === 0) {
    return null
  }
  return terms.join(' ')
}

/**
 * Full-text search over the scenario spec of one project: FTS5 MATCH on
 * scenarios_fts (context/action/outcome + owning feature name), ranked by
 * bm25, best first. Returns at most `limit` hits, [] for empty or
 * non-matching input — never throws on odd query syntax.
 *
 * AND first, then one OR retry over the same terms on zero rows, so
 * natural questions survive the function words that starve an AND match
 * while bm25 keeps the rows matching more or rarer terms first. No
 * stopword stripping: bm25 already clamps high-frequency terms near zero
 * weight, and a word list would hardcode one language into the matcher.
 */
export async function searchScenarios(db: Database, projectId: number, query: string, limit = 8): Promise<ScenarioSearchHit[]> {
  const terms = toFtsTerms(query)
  if (terms.length === 0) {
    return []
  }

  const hits = await matchScenarios(db, projectId, terms.join(' '), limit)
  if (hits.length > 0 || terms.length === 1) {
    return hits
  }
  // A single term would only retry against itself, so only broader queries pass.
  return matchScenarios(db, projectId, terms.join(' OR '), limit)
}

/** One FTS5 match over the scenario spec; odd syntax matches nothing, never throws. */
async function matchScenarios(db: Database, projectId: number, match: string, limit: number): Promise<ScenarioSearchHit[]> {
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
    WHERE scenarios_fts MATCH ${match}
      AND f.projectId = ${projectId}
    ORDER BY bm25(scenarios_fts)
    LIMIT ${limit}
  `)
}

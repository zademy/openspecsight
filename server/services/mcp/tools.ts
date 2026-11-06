import { and, desc, eq } from 'drizzle-orm'
import { getDB } from '../../db/client'
import { features, flows, projects, releases, repositories, scenarioRevisions, scenarios } from '../../db/schema'
import { searchScenarios } from '../../db/search'
import { ask, type AskDeps } from '../ask.service'
import { getFeatureTree } from '../spec.service'
import type { FlowGraph } from '../../../shared/types'
import type { McpTool } from './protocol'

/**
 * The six read-only spec tools served over /mcp: list_projects,
 * list_features, get_feature, search_spec, recent_changes, ask. Every
 * handler that takes a `project` argument resolves it through
 * resolveProjectRef (repositories "owner/repo" first, exact project name
 * second) and then only reads. Nothing here writes, not even bookkeeping
 * (that already happens once at auth time), and no error message ever
 * carries key material or SQL: messages are fixed text plus ref/feature
 * identifiers.
 *
 * Handler failures throw plain Errors; the server core turns them into
 * isError CallToolResults with the message as text, which is the tool-error
 * path for unknown projects/features and malformed arguments alike.
 */

/** Upper bound for any limit argument, so one call cannot dump a whole spec. */
const MAX_LIMIT = 100

export interface ProjectSummary {
  id: number
  name: string
  ownerRepo: string | null
  branch: string | null
  description: string
}

interface ResolvedProject {
  projectId: number
  name: string
  ownerRepo: string | null
}

/**
 * Matches `ref` against every project's repository "owner/repo" string
 * first, then against the exact project name. One match resolves; zero
 * matches and several matches both raise a tool error that lists the valid
 * refs so the agent can correct itself from list_projects output.
 */
export function resolveProjectRef(ref: string): ResolvedProject {
  const rows = getDB().select({
    id: projects.id,
    name: projects.name,
    owner: repositories.owner,
    repo: repositories.repo,
  }).from(projects).leftJoin(repositories, eq(repositories.projectId, projects.id)).all()

  const known = new Map<number, ProjectSummary>()
  for (const row of rows) {
    const summary = known.get(row.id) ?? {
      id: row.id,
      name: row.name,
      ownerRepo: null,
      branch: null,
      description: '',
    }
    if (row.owner !== null && row.repo !== null) {
      summary.ownerRepo = `${row.owner}/${row.repo}`
    }
    known.set(row.id, summary)
  }

  const refsOf = (project: ProjectSummary): string[] =>
    project.ownerRepo !== null ? [project.ownerRepo, project.name] : [project.name]

  const matches = [...known.values()].filter((project) => refsOf(project).includes(ref))
  if (matches.length === 1) {
    const project = matches[0]!
    return { projectId: project.id, name: project.name, ownerRepo: project.ownerRepo }
  }
  if (matches.length > 1) {
    throw new Error(
      `Project ref '${ref}' is ambiguous and matches projects with ids ${matches.map((p) => p.id).join(', ')}. `
      + 'Ask the operator to rename one of them, or pass a ref unique to one project.',
    )
  }

  const validRefs = [...known.values()].flatMap(refsOf)
  const refList = validRefs.length > 0 ? validRefs.join(', ') : 'none (no projects exist yet)'
  throw new Error(`Unknown project '${ref}'. Valid refs: ${refList}. Call list_projects for ids and refs.`)
}

/** Reads a required non-empty string argument, tool error otherwise. */
function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Argument '${key}' must be a non-empty string.`)
  }
  return value
}

/** Reads an optional integer limit argument within sane bounds. */
function readLimit(args: Record<string, unknown>, fallback: number): number {
  const value = args.limit
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`Argument 'limit' must be an integer between 1 and ${MAX_LIMIT}.`)
  }
  return value
}

/**
 * Mermaid-safe text: one line, no quotes or pipe characters that would
 * terminate the node/edge syntax early.
 */
function mermaidText(text: string): string {
  return text.replaceAll('"', "'").replaceAll('|', '/').replaceAll('\n', ' ').trim()
}

/** Mermaid node id: quotes are dropped outright, ids must stay identifiers. */
function mermaidId(id: string): string {
  return id.replaceAll(/['"]/g, '').trim()
}

/**
 * Renders a stored flow graph as a Mermaid flowchart: nodes as id["label"],
 * edges as a -->|type| b (plain a --> b when the edge carries no type).
 * Pure text shaping; the graphJson was schema-validated when written.
 */
export function flowToMermaid(graph: FlowGraph): string {
  const lines = ['flowchart TD']
  for (const node of graph.nodes) {
    lines.push(`    ${mermaidId(node.id)}["${mermaidText(node.label)}"]`)
  }
  for (const edge of graph.edges) {
    const arrow = edge.label === undefined ? '-->' : `-->|${mermaidText(edge.label)}|`
    lines.push(`    ${mermaidId(edge.from)} ${arrow} ${mermaidId(edge.to)}`)
  }
  return lines.join('\n')
}

/** The feature's flow as Mermaid text, or the explicit no-flow note. */
function featureMermaid(featureId: number): string {
  const row = getDB().select({ graphJson: flows.graphJson }).from(flows)
    .where(eq(flows.featureId, featureId)).get()
  if (!row) {
    return 'No flow diagram recorded for this feature.'
  }
  return flowToMermaid(JSON.parse(row.graphJson) as FlowGraph)
}

/** Flat feature detail for agents: description, scenarios and Mermaid flow. */
function featureDetailHandler(featureId: number): unknown {
  const feature = getDB().select({
    id: features.id,
    name: features.name,
    description: features.description,
  }).from(features).where(eq(features.id, featureId)).get()
  if (!feature) {
    return null
  }

  const rows = getDB().select({
    id: scenarios.id,
    code: scenarios.code,
    context: scenarios.context,
    action: scenarios.action,
    outcome: scenarios.outcome,
    category: scenarios.category,
    source: scenarios.source,
  }).from(scenarios).where(eq(scenarios.featureId, featureId)).orderBy(scenarios.sortOrder).all()

  return {
    id: feature.id,
    name: feature.name,
    description: feature.description,
    scenarios: rows.map((row) => ({ ...row, manual: row.source === 'manual' })),
    flow: featureMermaid(featureId),
  }
}

/**
 * Resolves the `feature` argument inside an already-resolved project: an
 * exact case-insensitive name, or a numeric id passed as a string or
 * number. Zero matches is a tool error; several name matches (a duplicate
 * rename away) refuse to guess and list the colliding ids.
 */
function resolveFeature(project: ResolvedProject, featureArg: unknown): { id: number, name: string } {
  let idWanted: number | null = null
  let nameWanted: string | null = null
  if (typeof featureArg === 'number' && Number.isInteger(featureArg)) {
    idWanted = featureArg
  } else if (typeof featureArg === 'string' && /^\d+$/.test(featureArg.trim())) {
    idWanted = Number.parseInt(featureArg.trim(), 10)
  } else if (typeof featureArg === 'string' && featureArg.trim().length > 0) {
    nameWanted = featureArg.trim().toLowerCase()
  } else {
    throw new Error("Argument 'feature' must be a feature name or a numeric feature id.")
  }

  const rows = getDB().select({ id: features.id, name: features.name })
    .from(features).where(eq(features.projectId, project.projectId)).all()
  const matches = rows.filter((row) =>
    idWanted !== null ? row.id === idWanted : row.name.toLowerCase() === nameWanted)
  if (matches.length === 0) {
    throw new Error(
      `No feature '${String(featureArg)}' in project '${project.ownerRepo ?? project.name}'. `
      + 'Use list_features to see the feature tree.',
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Feature name '${String(featureArg)}' is ambiguous in this project; matching ids: `
      + `${matches.map((row) => row.id).join(', ')}.`,
    )
  }
  return matches[0]!
}

function listProjectsHandler(): ProjectSummary[] {
  const rows = getDB().select({
    id: projects.id,
    name: projects.name,
    description: projects.description,
    owner: repositories.owner,
    repo: repositories.repo,
    branch: repositories.branch,
  }).from(projects).leftJoin(repositories, eq(repositories.projectId, projects.id))
    .orderBy(projects.id).all()

  const summaries = new Map<number, ProjectSummary>()
  for (const row of rows) {
    const summary = summaries.get(row.id) ?? {
      id: row.id,
      name: row.name,
      ownerRepo: null,
      branch: null,
      description: row.description,
    }
    if (row.owner !== null && row.repo !== null) {
      summary.ownerRepo = `${row.owner}/${row.repo}`
      summary.branch = row.branch
    }
    summaries.set(row.id, summary)
  }
  return [...summaries.values()]
}

const projectArg = {
  description: 'Project ref: "owner/repo" or the exact project name.',
  type: 'string',
} as const

/** Search results labeled by kind: ranked scenario hits first, name-matched features after. */
async function searchSpecHandler(args: Record<string, unknown>): Promise<unknown> {
  const project = resolveProjectRef(readString(args, 'project'))
  const query = readString(args, 'query')
  const limit = readLimit(args, 10)

  const hits = await searchScenarios(getDB(), project.projectId, query, limit)
  const results: Array<Record<string, unknown>> = hits.map((hit) => ({
    kind: 'scenario',
    scenarioId: hit.scenarioId,
    code: hit.code,
    featureName: hit.featureName,
    context: hit.context,
    action: hit.action,
    outcome: hit.outcome,
  }))

  const lowered = query.toLowerCase()
  const featureRows = getDB().select({
    id: features.id,
    name: features.name,
    description: features.description,
  }).from(features).where(eq(features.projectId, project.projectId)).orderBy(features.sortOrder).all()
  for (const row of featureRows.filter((row) => row.name.toLowerCase().includes(lowered)).slice(0, limit)) {
    results.push({ kind: 'feature', featureId: row.id, name: row.name, description: row.description })
  }
  return { query, results }
}

/** Applied scenario revisions of one project, newest release first. */
function recentChangesHandler(args: Record<string, unknown>): unknown {
  const project = resolveProjectRef(readString(args, 'project'))
  const limit = readLimit(args, 20)

  return getDB().select({
    releaseTitle: releases.title,
    sha: releases.sha,
    committedAt: releases.committedAt,
    featureName: features.name,
    kind: scenarioRevisions.kind,
    scenarioCode: scenarios.code,
    action: scenarios.action,
    outcome: scenarios.outcome,
  }).from(scenarioRevisions)
    .innerJoin(releases, eq(scenarioRevisions.releaseId, releases.id))
    .innerJoin(features, eq(scenarioRevisions.featureId, features.id))
    .leftJoin(scenarios, eq(scenarioRevisions.scenarioId, scenarios.id))
    .where(and(eq(scenarioRevisions.state, 'applied'), eq(releases.projectId, project.projectId)))
    .orderBy(desc(releases.committedAt), desc(scenarioRevisions.id))
    .limit(limit)
    .all()
}

/**
 * The registry the /mcp route serves. Fresh array per call, read-only
 * handlers. `askDeps` exists for tests: the mocked-LLM fixture from the
 * ask tests plugs in there, while the route calls buildMcpTools() and the
 * handler builds the real LLM client.
 */
export function buildMcpTools(askDeps: AskDeps = {}): McpTool[] {
  return [
    {
      name: 'list_projects',
      title: 'List projects',
      description: 'List the indexed projects with their ids, names, owner/repo refs, branches and descriptions.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: async () => listProjectsHandler(),
    },
    {
      name: 'list_features',
      title: 'List features',
      description: 'The feature tree of one project: ids, names, descriptions, scenario counts and child features.',
      inputSchema: {
        type: 'object',
        properties: { project: projectArg },
        required: ['project'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const project = resolveProjectRef(readString(args, 'project'))
        return getFeatureTree(project.projectId)
      },
    },
    {
      name: 'get_feature',
      title: 'Get feature',
      description: 'One feature in detail: description, every scenario (code, context/action/outcome, category, manual flag) and the flow diagram as Mermaid text.',
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArg,
          feature: {
            type: 'string',
            description: 'Feature name (exact, case-insensitive) or numeric feature id.',
          },
        },
        required: ['project', 'feature'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const project = resolveProjectRef(readString(args, 'project'))
        const feature = resolveFeature(project, args.feature)
        return featureDetailHandler(feature.id)
      },
    },
    {
      name: 'search_spec',
      title: 'Search spec',
      description: 'Full-text search of one project: ranked scenario hits plus features whose name matches, labeled by kind.',
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArg,
          query: { type: 'string', description: 'Free-text query over scenario text and feature names.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Max results (default 10).' },
        },
        required: ['project', 'query'],
        additionalProperties: false,
      },
      handler: async (args) => searchSpecHandler(args),
    },
    {
      name: 'recent_changes',
      title: 'Recent changes',
      description: 'Applied scenario revisions of one project, newest first: kind (new/changed/gone/fixed), feature name and the release (title, sha, committedAt) that carried each.',
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArg,
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Max results (default 20).' },
        },
        required: ['project'],
        additionalProperties: false,
      },
      handler: async (args) => recentChangesHandler(args),
    },
    {
      name: 'ask',
      title: 'Ask the spec',
      description: 'Answer a question strictly from one project\'s stored scenarios, with grounded citations; refusals are explicit.',
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArg,
          question: { type: 'string', description: 'The question to answer from the spec.' },
        },
        required: ['project', 'question'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const project = resolveProjectRef(readString(args, 'project'))
        const question = readString(args, 'question')
        // ask() reads only: retrieval plus the LLM call; conversation
        // persistence lives in the operator API route, not here.
        const result = await ask(project.projectId, question, askDeps)
        return { answer: result.answer, refused: result.refused, citations: result.citations }
      },
    },
  ]
}

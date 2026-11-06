import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { features, flows, projects, releases, repositories, scenarioRevisions, scenarios } from '../../server/db/schema'
import { buildMcpTools, flowToMermaid, type ProjectSummary } from '../../server/services/mcp/tools'
import { NO_COVERAGE_ANSWER } from '../../server/services/ask.service'
import { fakeLlm } from './helpers/analysis-fakes'
import type { FlowGraph } from '../../shared/types'
import type { McpTool } from '../../server/services/mcp/protocol'

/**
 * The six read-only MCP tools run against a :memory: database seeded the
 * way the pipeline leaves it: one project with a repository (so "owner/repo"
 * refs resolve), a feature tree with scenarios (one manual), a flow row,
 * and two releases carrying applied and proposed revisions. Handlers are
 * called directly; the JSON-RPC envelope around them is the protocol core's
 * job and is pinned in mcp-protocol.spec.ts. Result types mirror the tool
 * payloads (handlers return unknown) so assertions stay honest.
 */

/** One node of the list_features tree (the getFeatureTree shape). */
interface FeatureTreeRow {
  id: number
  name: string
  description: string
  parentId: number | null
  scenarioCount: number
  children: FeatureTreeRow[]
}

interface ScenarioDetailRow {
  id: number
  code: string
  context: string
  action: string
  outcome: string
  category: 'happy' | 'edge' | 'error'
  source: 'ai' | 'manual'
  manual: boolean
}

interface FeatureDetailRow {
  id: number
  name: string
  description: string
  scenarios: ScenarioDetailRow[]
  flow: string
}

type SearchResultRow =
  | { kind: 'scenario', scenarioId: number, code: string, featureName: string, context: string, action: string, outcome: string }
  | { kind: 'feature', featureId: number, name: string, description: string }

interface RevisionRow {
  releaseTitle: string
  sha: string
  committedAt: string
  featureName: string
  kind: 'new' | 'changed' | 'gone' | 'fixed'
  scenarioCode: string | null
  action: string | null
  outcome: string | null
}

interface AskToolResult {
  answer: string
  refused: boolean
  citations: Array<{ index: number, scenarioId: number, code: string, featureId: number, featureName: string, quote: string }>
}

let projectId: number
let authId: number
let sessionsId: number
let exportId: number
let hp1Id: number
let er2Id: number

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'start', kind: 'start', label: 'Open app' },
    { id: 'login', kind: 'step', label: 'Enter credentials', scenarioCode: 'HP-1' },
    { id: 'done', kind: 'end', label: 'Dashboard' },
  ],
  edges: [
    { from: 'start', to: 'login' },
    { from: 'login', to: 'done', label: 'valid' },
  ],
}

function handler(name: string): McpTool['handler'] {
  const tool = buildMcpTools().find((candidate) => candidate.name === name)
  if (!tool) {
    throw new Error(`test setup: no tool named ${name}`)
  }
  return tool.handler
}

/** Runs one tool and casts its structured result; failures propagate as throwns. */
async function toolResult<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return await handler(name)(args) as T
}

async function toolError(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    await handler(name)(args)
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  throw new Error(`expected tool ${name} to fail`)
}

/** One project (acme/tasks with features + flow + revisions) and one repo-less project. */
function seedWorld(): void {
  const db = getDB()
  const project = db.insert(projects).values({
    name: 'Task Tracker',
    description: 'Track tasks',
    createdAt: '2026-01-01T00:00:00.000Z',
  }).returning().get()
  projectId = project.id
  const repository = db.insert(repositories).values({
    projectId,
    owner: 'acme',
    repo: 'tasks',
    branch: 'main',
    patEncrypted: null,
    lastSyncedSha: null,
  }).returning().get()
  db.insert(projects).values({
    name: 'Solo Project',
    description: 'No repository attached',
    createdAt: '2026-02-01T00:00:00.000Z',
  }).run()

  const auth = db.insert(features).values({
    projectId,
    parentId: null,
    name: 'Authentication',
    description: 'Sign in and out',
    sortOrder: 0,
    source: 'ai',
  }).returning().get()
  authId = auth.id
  const sessions = db.insert(features).values({
    projectId,
    parentId: authId,
    name: 'Sessions',
    description: 'Keep users signed in',
    sortOrder: 1,
    source: 'ai',
  }).returning().get()
  sessionsId = sessions.id
  const exp = db.insert(features).values({
    projectId,
    parentId: null,
    name: 'Export',
    description: 'Download the spec',
    sortOrder: 2,
    source: 'ai',
  }).returning().get()
  exportId = exp.id

  const hp1 = db.insert(scenarios).values({
    featureId: authId,
    context: 'user on the login page',
    action: 'submits valid credentials',
    outcome: 'dashboard loads',
    category: 'happy',
    code: 'HP-1',
    sortOrder: 0,
    source: 'ai',
  }).returning().get()
  hp1Id = hp1.id
  const er2 = db.insert(scenarios).values({
    featureId: authId,
    context: 'user on the login page',
    action: 'submits an unknown email',
    outcome: 'error message appears',
    category: 'error',
    code: 'ER-2',
    sortOrder: 1,
    source: 'manual',
  }).returning().get()
  er2Id = er2.id

  db.insert(flows).values({ featureId: authId, graphJson: JSON.stringify(GRAPH) }).run()

  const first = db.insert(releases).values({
    projectId,
    repositoryId: repository.id,
    sha: 'sha-aaa',
    title: 'First drop',
    category: 'feature',
    highlight: 0,
    summary: '',
    authorsJson: '[]',
    message: '',
    committedAt: '2026-01-05T00:00:00.000Z',
  }).returning().get()
  const second = db.insert(releases).values({
    projectId,
    repositoryId: repository.id,
    sha: 'sha-bbb',
    title: 'Second drop',
    category: 'fix',
    highlight: 0,
    summary: '',
    authorsJson: '[]',
    message: '',
    committedAt: '2026-06-01T00:00:00.000Z',
  }).returning().get()

  db.insert(scenarioRevisions).values([
    { releaseId: first.id, scenarioId: hp1Id, featureId: authId, kind: 'new', state: 'applied', beforeJson: null, afterJson: null },
    { releaseId: first.id, scenarioId: er2Id, featureId: authId, kind: 'new', state: 'proposed', beforeJson: null, afterJson: null },
    { releaseId: second.id, scenarioId: er2Id, featureId: authId, kind: 'changed', state: 'applied', beforeJson: null, afterJson: null },
    { releaseId: second.id, scenarioId: null, featureId: sessionsId, kind: 'gone', state: 'applied', beforeJson: null, afterJson: null },
  ]).run()
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
  seedWorld()
})

describe('flowToMermaid', () => {
  test('renders nodes as id["label"] and typed edges as a -->|type| b', () => {
    const mermaid = flowToMermaid(GRAPH)
    expect(mermaid).toContain('flowchart TD')
    expect(mermaid).toContain('    start["Open app"]')
    expect(mermaid).toContain('    login["Enter credentials"]')
    expect(mermaid).toContain('    start --> login')
    expect(mermaid).toContain('    login -->|valid| done')
  })

  test('keeps labels one-line and Mermaid-safe', () => {
    const mermaid = flowToMermaid({
      nodes: [{ id: 'n"1', kind: 'step', label: 'line one\nline "two" | done' }],
      edges: [{ from: 'n"1', to: 'n"1', label: 'a|b' }],
    })
    expect(mermaid).toContain('n1["line one line \'two\' / done"]')
    expect(mermaid).toContain('n1 -->|a/b| n1')
  })
})

describe('list_projects', () => {
  test('lists projects with ownerRepo refs and branch', async () => {
    const rows = await toolResult<ProjectSummary[]>('list_projects', {})
    expect(rows.map((row) => row.name)).toEqual(['Task Tracker', 'Solo Project'])
    expect(rows[0]).toMatchObject({ id: projectId, ownerRepo: 'acme/tasks', branch: 'main' })
    expect(rows[1]).toMatchObject({ ownerRepo: null, branch: null })
  })
})

describe('list_features', () => {
  test('returns the feature tree with scenario counts and children', async () => {
    const tree = await toolResult<FeatureTreeRow[]>('list_features', { project: 'acme/tasks' })
    expect(tree).toHaveLength(2)
    const auth = tree.find((node) => node.name === 'Authentication')
    expect(auth).toMatchObject({ id: authId, scenarioCount: 2 })
    expect(auth?.children.map((child) => child.name)).toEqual(['Sessions'])
    expect(tree.find((node) => node.name === 'Export')).toMatchObject({ scenarioCount: 0, children: [] })
  })

  test('resolves an exact project name when no owner/repo matches', async () => {
    const tree = await toolResult<FeatureTreeRow[]>('list_features', { project: 'Solo Project' })
    expect(tree).toEqual([])
  })
})

describe('get_feature', () => {
  test('matches a feature name case-insensitively and flags manual scenarios', async () => {
    const detail = await toolResult<FeatureDetailRow>('get_feature', { project: 'acme/tasks', feature: 'authentication' })
    expect(detail).toMatchObject({ id: authId, name: 'Authentication', description: 'Sign in and out' })
    expect(detail.scenarios.map((row) => row.code)).toEqual(['HP-1', 'ER-2'])
    expect(detail.scenarios.find((row) => row.id === hp1Id)).toMatchObject({ manual: false, source: 'ai' })
    expect(detail.scenarios.find((row) => row.id === er2Id)).toMatchObject({ manual: true, source: 'manual' })
  })

  test('carries the scenario given/when/then fields as stored', async () => {
    const detail = await toolResult<FeatureDetailRow>('get_feature', { project: 'acme/tasks', feature: String(authId) })
    const scenario = detail.scenarios.find((row) => row.code === 'HP-1')
    expect(scenario).toMatchObject({
      context: 'user on the login page',
      action: 'submits valid credentials',
      outcome: 'dashboard loads',
      category: 'happy',
    })
  })

  test('accepts a numeric feature id as text or number', async () => {
    const byText = await toolResult<FeatureDetailRow>('get_feature', { project: 'acme/tasks', feature: String(exportId) })
    const byNumber = await toolResult<FeatureDetailRow>('get_feature', { project: 'acme/tasks', feature: exportId })
    expect(byText).toMatchObject({ id: exportId, name: 'Export' })
    expect(byNumber).toMatchObject({ id: exportId })
  })

  test('renders the stored flow as Mermaid text', async () => {
    const detail = await toolResult<FeatureDetailRow>('get_feature', { project: 'acme/tasks', feature: 'Authentication' })
    expect(detail.flow).toContain('login["Enter credentials"]')
    expect(detail.flow).toContain('login -->|valid| done')
  })

  test('notes the absent flow instead of an empty diagram', async () => {
    const detail = await toolResult<FeatureDetailRow>('get_feature', { project: 'acme/tasks', feature: 'Export' })
    expect(detail.flow).toBe('No flow diagram recorded for this feature.')
  })

  test('unknown feature is a tool error pointing at list_features', async () => {
    const message = await toolError('get_feature', { project: 'acme/tasks', feature: 'Nope' })
    expect(message).toContain("No feature 'Nope' in project 'acme/tasks'")
    expect(message).toContain('list_features')
  })
})

describe('search_spec', () => {
  test('returns ranked scenario hits with feature name and scenario id', async () => {
    const result = await toolResult<{ query: string, results: SearchResultRow[] }>('search_spec', { project: 'acme/tasks', query: 'valid credentials' })
    const hit = result.results.find((row) => row.kind === 'scenario')
    expect(hit).toMatchObject({
      scenarioId: hp1Id,
      code: 'HP-1',
      featureName: 'Authentication',
      action: 'submits valid credentials',
    })
  })

  test('also returns features whose name matches, labeled by kind', async () => {
    const result = await toolResult<{ query: string, results: SearchResultRow[] }>('search_spec', { project: 'acme/tasks', query: 'export' })
    const feature = result.results.find((row) => row.kind === 'feature')
    expect(feature).toMatchObject({ featureId: exportId, name: 'Export' })
  })

  test('honors the limit argument', async () => {
    const result = await toolResult<{ query: string, results: SearchResultRow[] }>('search_spec', { project: 'acme/tasks', query: 'login page', limit: 1 })
    expect(result.results.filter((row) => row.kind === 'scenario')).toHaveLength(1)
  })

  test('rejects malformed arguments', async () => {
    expect(await toolError('search_spec', { project: 'acme/tasks' })).toContain("'query'")
    expect(await toolError('search_spec', { project: 'acme/tasks', query: 'x', limit: 0 })).toContain("'limit'")
  })
})

describe('recent_changes', () => {
  test('lists applied revisions newest release first, with release and feature joins', async () => {
    const rows = await toolResult<RevisionRow[]>('recent_changes', { project: 'acme/tasks' })
    expect(rows).toHaveLength(3) // the proposed row is excluded
    expect(rows[0]).toMatchObject({
      releaseTitle: 'Second drop',
      sha: 'sha-bbb',
      committedAt: '2026-06-01T00:00:00.000Z',
      featureName: 'Sessions',
      kind: 'gone',
      scenarioCode: null,
    })
    expect(rows[1]).toMatchObject({
      releaseTitle: 'Second drop',
      featureName: 'Authentication',
      kind: 'changed',
      scenarioCode: 'ER-2',
    })
    expect(rows[2]).toMatchObject({
      releaseTitle: 'First drop',
      sha: 'sha-aaa',
      committedAt: '2026-01-05T00:00:00.000Z',
      kind: 'new',
      scenarioCode: 'HP-1',
    })
  })
})

describe('ask', () => {
  test('answers from the spec with grounded citations under a mock llm', async () => {
    const llm = fakeLlm({
      'ask-answer': {
        covered: true,
        answer: 'Submitting valid credentials loads the dashboard [1].',
        citations: [{ index: 1, scenarioId: hp1Id, quote: 'submits valid credentials' }],
      },
    })
    const askTool = buildMcpTools({ llm }).find((tool) => tool.name === 'ask')!
    const result = await askTool.handler({ project: 'acme/tasks', question: 'what happens after login?' }) as AskToolResult
    expect(result).toMatchObject({ refused: false })
    expect(result.answer).toContain('dashboard [1]')
    expect(result.citations[0]).toMatchObject({ scenarioId: hp1Id, code: 'HP-1', featureName: 'Authentication' })
    expect(llm.generateCalls).toHaveLength(1)
    expect(llm.generateCalls[0]!.name).toBe('ask-answer')
  })

  test('refuses without calling an llm when the spec has no hit', async () => {
    const result = await toolResult<AskToolResult>('ask', { project: 'acme/tasks', question: 'quantum flux capacity' })
    expect(result).toEqual({ answer: NO_COVERAGE_ANSWER, refused: true, citations: [] })
  })
})

describe('project resolution errors', () => {
  test('unknown project lists the valid refs', async () => {
    const message = await toolError('list_features', { project: 'acme/unknown' })
    expect(message).toContain("Unknown project 'acme/unknown'")
    expect(message).toContain('acme/tasks')
    expect(message).toContain('Task Tracker')
    expect(message).toContain('Solo Project')
  })

  test('missing project argument is a tool error', async () => {
    expect(await toolError('list_features', {})).toContain("'project'")
    expect(await toolError('ask', { question: 'hi' })).toContain("'project'")
  })
})

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test } from 'vitest'
import type { z } from 'zod'
import { getDB, resetDB } from '../../server/db/client'
import { analyses, featureFiles, features, projects, repositories, scenarios } from '../../server/db/schema'
import { runInitialAnalysis } from '../../server/services/analysis.service'
import { featureSlug, filterCodeFiles } from '../../server/services/analysis/paths'
import { GithubError, type GithubService, type GithubTreeEntry } from '../../server/services/github.service'
import type { LlmClient } from '../../server/services/llm.service'
import type { FeatureInventorySchema, FeatureScenariosSchema } from '../../shared/schemas'

/**
 * Pipeline tests run against a :memory: database with an injected fake github
 * service and a scripted fake llm client, so nothing touches the network.
 * The fake llm validates scripted responses through the same zod schemas the
 * real client uses (mirrors LLM_MOCK mode, including unknown-key stripping).
 */

const TREE: GithubTreeEntry[] = [
  { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 742 },
  { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 613 },
  { path: 'package-lock.json', type: 'blob', sha: 'sha-lock', size: 200000 },
  { path: 'pnpm-lock.yaml', type: 'blob', sha: 'sha-pnpm', size: 300000 },
  { path: 'src', type: 'tree', sha: 'sha-src', size: 0 },
  { path: 'src/auth/login.ts', type: 'blob', sha: 'sha-login', size: 1240 },
  { path: 'src/auth/session.ts', type: 'blob', sha: 'sha-session', size: 986 },
  { path: 'src/tasks/list.ts', type: 'blob', sha: 'sha-list', size: 1503 },
  { path: 'src/tasks/create.ts', type: 'blob', sha: 'sha-create', size: 1122 },
  { path: 'src/styles.css', type: 'blob', sha: 'sha-css', size: 421 },
  { path: 'assets/logo.png', type: 'blob', sha: 'sha-logo', size: 5432 },
  { path: 'dist', type: 'tree', sha: 'sha-dist', size: 0 },
  { path: 'dist/bundle.js', type: 'blob', sha: 'sha-bundle', size: 50000 },
  { path: 'node_modules/left-pad/index.js', type: 'blob', sha: 'sha-nm', size: 900 },
]

/** Seven of the fourteen tree entries above pass the code-file filter (pinned in the filterCodeFiles tests). */
const CODE_FILE_COUNT = 7

const BLOBS: Record<string, string> = {
  'sha-readme': '# Tasks\nA small task manager demo.\n',
  'sha-pkg': '{ "name": "tasks", "version": "1.0.0" }\n',
  'sha-login': 'export function login(email: string, password: string) {\n  return validate(email, password)\n}\n',
  'sha-session': 'export function createSession(userId: number) {\n  return sign({ userId })\n}\n',
  'sha-list': 'export function listTasks(userId: number) {\n  return db.tasks.where({ userId })\n}\n',
  'sha-create': 'export function createTask(userId: number, title: string) {\n  return db.tasks.insert({ userId, title })\n}\n',
  'sha-css': '.task-item { text-decoration: line-through; }\n',
  'sha-lock': 'too big to matter',
  'sha-bundle': 'minified',
  'sha-nm': 'vendored',
}

/** Same content as fixtures/llm/feature-inventory.json (Task 4 fixture). */
const INVENTORY: z.infer<typeof FeatureInventorySchema> = {
  features: [
    {
      name: 'Authentication',
      description: 'Email and password login with signed session cookies and logout.',
      files: ['server/api/auth/login.post.ts', 'server/api/auth/logout.post.ts', 'server/utils/session.ts', 'app/pages/login.vue', 'app/middleware/auth.ts'],
      children: [
        { name: 'Login', description: 'Validates credentials and starts a signed session cookie.', files: ['server/api/auth/login.post.ts', 'app/pages/login.vue'] },
        { name: 'Logout', description: 'Clears the session cookie and redirects to the login page.', files: ['server/api/auth/logout.post.ts'] },
      ],
    },
    {
      name: 'Tasks',
      description: 'Create, complete, and filter personal tasks with due dates.',
      files: ['server/api/tasks/index.get.ts', 'server/api/tasks/index.post.ts', 'server/api/tasks/[id].patch.ts', 'app/pages/tasks/index.vue', 'app/components/tasks/TaskItem.vue'],
      children: [
        { name: 'Task list', description: "Lists the signed-in user's tasks grouped by due date.", files: ['server/api/tasks/index.get.ts', 'app/pages/tasks/index.vue'] },
        { name: 'Task lifecycle', description: 'Create, complete, and reopen tasks with optimistic UI updates.', files: ['server/api/tasks/index.post.ts', 'server/api/tasks/[id].patch.ts'] },
      ],
    },
  ],
}

/** Same content as fixtures/llm/feature-scenarios.{authentication,tasks}.json. */
const SCENARIOS: Record<string, z.infer<typeof FeatureScenariosSchema>> = {
  authentication: {
    featureName: 'Authentication',
    groups: [
      {
        context: 'user on the login page',
        scenarios: [
          { action: 'submit the login form with a registered email and the correct password', outcome: 'the user lands on the tasks page and the session cookie is set', category: 'happy' },
          { action: 'submit the login form with an unregistered email', outcome: "the form shows 'Invalid email or password' and no cookie is set", category: 'error' },
          { action: 'submit the login form with the wrong password', outcome: "the form shows 'Invalid email or password' and no cookie is set", category: 'error' },
        ],
      },
      {
        context: 'user with an active session',
        scenarios: [
          { action: 'log out from any page', outcome: 'the session cookie is cleared and the user is redirected to the login page', category: 'happy' },
          { action: 'open a protected page with an expired session cookie', outcome: 'the request is redirected to the login page with a return URL', category: 'edge' },
          { action: 'open a protected page with a cookie signed by a foreign key', outcome: 'the cookie fails the signature check and the user is redirected to the login page', category: 'error' },
        ],
      },
    ],
  },
  tasks: {
    featureName: 'Tasks',
    groups: [
      {
        context: 'user creating and completing tasks',
        scenarios: [
          { action: 'create a task with a title and a due date', outcome: 'the task appears in the list under its due date group', category: 'happy' },
          { action: 'check the checkbox of an open task', outcome: 'the task moves to Completed with a struck-through title', category: 'happy' },
          { action: 'uncheck a completed task', outcome: 'the task returns to Open with its original due date', category: 'happy' },
        ],
      },
      {
        context: 'user filtering the task list',
        scenarios: [
          { action: 'filter the list to tasks due today when none are due', outcome: "the list shows 'No tasks due today' instead of an empty grid", category: 'edge' },
          { action: 'create a task with an empty title', outcome: 'the create button stays disabled and no request is sent', category: 'error' },
          { action: 'complete a task another session already deleted', outcome: "the stale row is removed from the list and a 'Task no longer exists' note is shown", category: 'error' },
        ],
      },
    ],
  },
}

interface FakeGithub extends GithubService {
  /** Blob reads the pipeline issued, in call order. */
  getBlobCalls: string[]
}

/** Fake github service serving the fixture tree/blobs and a fixed head commit. */
function fakeGithub(options: { tree?: GithubTreeEntry[], headSha?: string } = {}): FakeGithub {
  const getBlobCalls: string[] = []
  return {
    getBlobCalls,
    getRepo: async () => ({ defaultBranch: 'main' }),
    getTree: async () => options.tree ?? TREE,
    getBlob: async (_owner, _repo, sha) => {
      getBlobCalls.push(sha)
      const content = BLOBS[sha]
      if (content === undefined) {
        throw new GithubError(`GitHub fetch blob for acme/tasks failed: no fixture for sha ${sha}`, {})
      }
      return content
    },
    compareCommits: async () => ({ commits: [], files: [] }),
    listCommits: async () => [{
      sha: options.headSha ?? 'head-sha-aaa',
      message: 'feat: seed the demo repo',
      authorName: 'Ada Lovelace',
      committedAt: '2026-11-01T10:00:00Z',
    }],
  }
}

interface FakeLlm extends LlmClient {
  /** One entry per generate() call, in call order. */
  generateCalls: Array<{ name: string, prompt: string }>
}

/** Fake llm client scripted per generate() name; validates through the schema. */
function fakeLlm(responses: Record<string, unknown>): FakeLlm {
  const generateCalls: Array<{ name: string, prompt: string }> = []
  return {
    generateCalls,
    async generate<T>(name: string, schema: z.ZodType<T>, prompt: string): Promise<T> {
      generateCalls.push({ name, prompt })
      const raw = responses[name]
      if (raw === undefined) {
        throw new Error(`fake llm has no scripted response for "${name}"`)
      }
      return schema.parse(raw)
    },
  }
}

/** Default deps: fixture github + scripted mock-mode llm responses. */
function fakeDeps(options: { tree?: GithubTreeEntry[], headSha?: string, responses?: Record<string, unknown> } = {}) {
  return {
    github: fakeGithub({ tree: options.tree, headSha: options.headSha }),
    llm: fakeLlm(options.responses ?? {
      'feature-inventory': INVENTORY,
      'feature-scenarios:authentication': SCENARIOS.authentication,
      'feature-scenarios:tasks': SCENARIOS.tasks,
    }),
  }
}

beforeEach(() => {
  delete process.env.GITHUB_MAX_FILES
  delete process.env.GITHUB_MAX_TOTAL_BYTES
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
})

function insertProjectWithRepo(options: { withRepository?: boolean } = {}): { projectId: number, analysisId: number } {
  const db = getDB()
  const project = db.insert(projects).values({
    name: 'Analysis Fixture',
    description: 'Pins the initial analysis pipeline',
    createdAt: '2026-11-03T00:00:00.000Z',
  }).returning().get()

  if (options.withRepository !== false) {
    db.insert(repositories).values({
      projectId: project.id,
      owner: 'acme',
      repo: 'tasks',
      branch: 'main',
      patEncrypted: null,
      lastSyncedSha: null,
    }).run()
  }

  const analysis = db.insert(analyses).values({
    projectId: project.id,
    type: 'initial',
    status: 'queued',
    progress: 0,
    step: 'queued',
    statsJson: '{}',
    error: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    finishedAt: null,
  }).returning().get()

  return { projectId: project.id, analysisId: analysis.id }
}

describe('runInitialAnalysis', () => {
  test('builds features, scenarios and feature files, then finishes done with stats', async () => {
    const { projectId, analysisId } = insertProjectWithRepo()
    const deps = fakeDeps()

    await runInitialAnalysis({ analysisId, projectId }, deps)

    const row = getDB().select().from(analyses).where(eq(analyses.id, analysisId)).get()
    expect(row?.status).toBe('done')
    expect(row?.progress).toBe(100)
    expect(row?.step).toBe('done')
    expect(row?.error).toBeNull()
    expect(row?.finishedAt).not.toBeNull()
    expect(JSON.parse(row?.statsJson ?? '{}')).toEqual({ features: 6, scenarios: 12, files: CODE_FILE_COUNT })

    const featureRows = getDB().select().from(features).where(eq(features.projectId, projectId)).all()
    expect(featureRows.map((f) => f.name)).toEqual(['Authentication', 'Login', 'Logout', 'Tasks', 'Task list', 'Task lifecycle'])
    for (const feature of featureRows) {
      expect(feature.source).toBe('ai')
    }
    const byName = new Map(featureRows.map((f) => [f.name, f]))
    expect(byName.get('Authentication')?.parentId).toBeNull()
    expect(byName.get('Authentication')?.sortOrder).toBe(0)
    expect(byName.get('Login')?.parentId).toBe(byName.get('Authentication')?.id)
    expect(byName.get('Logout')?.sortOrder).toBe(1)
    expect(byName.get('Tasks')?.sortOrder).toBe(1)
    expect(byName.get('Task list')?.parentId).toBe(byName.get('Tasks')?.id)

    const fileRows = getDB().select().from(featureFiles).all()
    // 5 + 2 + 1 + 5 + 2 + 2 files across the six features.
    expect(fileRows).toHaveLength(17)
    const loginFiles = fileRows.filter((f) => f.featureId === byName.get('Login')?.id).map((f) => f.path)
    expect(loginFiles).toEqual(['server/api/auth/login.post.ts', 'app/pages/login.vue'])

    const scenarioRows = getDB().select().from(scenarios).all()
    expect(scenarioRows).toHaveLength(12)
    for (const scenario of scenarioRows) {
      expect(scenario.source).toBe('ai')
    }

    const authScenarios = scenarioRows
      .filter((s) => s.featureId === byName.get('Authentication')?.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    expect(authScenarios.map((s) => s.code)).toEqual(['HP-1', 'ER-1', 'ER-2', 'HP-2', 'ED-1', 'ER-3'])
    expect(authScenarios.map((s) => s.context)).toEqual([
      'user on the login page',
      'user on the login page',
      'user on the login page',
      'user with an active session',
      'user with an active session',
      'user with an active session',
    ])

    const taskScenarios = scenarioRows
      .filter((s) => s.featureId === byName.get('Tasks')?.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    expect(taskScenarios.map((s) => s.code)).toEqual(['HP-1', 'HP-2', 'HP-3', 'ED-1', 'ER-1', 'ER-2'])
  })

  test('calls the llm once for the inventory and once per top-level feature, feeding scanned sources', async () => {
    const { projectId, analysisId } = insertProjectWithRepo()
    const deps = fakeDeps()

    await runInitialAnalysis({ analysisId, projectId }, deps)

    expect(deps.llm.generateCalls.map((call) => call.name)).toEqual([
      'feature-inventory',
      'feature-scenarios:authentication',
      'feature-scenarios:tasks',
    ])

    const inventoryPrompt = deps.llm.generateCalls[0]?.prompt ?? ''
    expect(inventoryPrompt).toContain('src/auth/login.ts')
    expect(inventoryPrompt).not.toContain('package-lock.json')
    expect(inventoryPrompt).not.toContain('node_modules')

    // Blobs were only read for the filtered code files (7), never for noise.
    expect(deps.github.getBlobCalls).toHaveLength(CODE_FILE_COUNT)
    expect(deps.github.getBlobCalls).toContain('sha-login')
    expect(deps.github.getBlobCalls).not.toContain('sha-lock')
  })

  test('sets repositories.lastSyncedSha to the branch head', async () => {
    const { projectId, analysisId } = insertProjectWithRepo()

    await runInitialAnalysis({ analysisId, projectId }, fakeDeps({ headSha: 'head-sha-bbb' }))

    const repo = getDB().select().from(repositories).where(eq(repositories.projectId, projectId)).get()
    expect(repo?.lastSyncedSha).toBe('head-sha-bbb')
  })

  test('exceeding GITHUB_MAX_FILES marks the analysis error without any llm call', async () => {
    process.env.GITHUB_MAX_FILES = '3'
    const { projectId, analysisId } = insertProjectWithRepo()
    const deps = fakeDeps()

    await expect(runInitialAnalysis({ analysisId, projectId }, deps)).resolves.toBeUndefined()

    const row = getDB().select().from(analyses).where(eq(analyses.id, analysisId)).get()
    expect(row?.status).toBe('error')
    expect(row?.error).toMatch(/limit of 3/)
    expect(row?.error).toMatch(/GITHUB_MAX_FILES/)
    expect(row?.finishedAt).not.toBeNull()
    expect(deps.llm.generateCalls).toEqual([])
  })

  test('exceeding GITHUB_MAX_TOTAL_BYTES marks the analysis error without any llm call', async () => {
    process.env.GITHUB_MAX_TOTAL_BYTES = '100'
    const { projectId, analysisId } = insertProjectWithRepo()
    const deps = fakeDeps()

    await expect(runInitialAnalysis({ analysisId, projectId }, deps)).resolves.toBeUndefined()

    const row = getDB().select().from(analyses).where(eq(analyses.id, analysisId)).get()
    expect(row?.status).toBe('error')
    expect(row?.error).toMatch(/GITHUB_MAX_TOTAL_BYTES/)
    expect(row?.error).toMatch(/100/)
    expect(deps.llm.generateCalls).toEqual([])
  })

  test('a fresh analysis wipes the previous spec rows instead of doubling them', async () => {
    const { projectId, analysisId } = insertProjectWithRepo()
    await runInitialAnalysis({ analysisId, projectId }, fakeDeps())

    const db = getDB()
    const second = db.insert(analyses).values({
      projectId,
      type: 'initial',
      status: 'queued',
      progress: 0,
      step: 'queued',
      statsJson: '{}',
      error: null,
      createdAt: '2026-11-03T00:01:00.000Z',
      finishedAt: null,
    }).returning().get()

    await runInitialAnalysis({ analysisId: second.id, projectId }, fakeDeps())

    expect(db.select().from(features).where(eq(features.projectId, projectId)).all()).toHaveLength(6)
    expect(db.select().from(scenarios).all()).toHaveLength(12)
    expect(db.select().from(featureFiles).all()).toHaveLength(17)
    expect(db.select().from(analyses).where(eq(analyses.id, second.id)).get()?.status).toBe('done')
  })

  test('a github failure marks the analysis error and rethrows for the job retry logic', async () => {
    const { projectId, analysisId } = insertProjectWithRepo()
    const deps = fakeDeps()
    deps.github.getTree = async () => {
      throw new GithubError('GitHub tree for acme/tasks failed with HTTP 500: boom', { status: 500 })
    }

    await expect(runInitialAnalysis({ analysisId, projectId }, deps)).rejects.toThrow(/HTTP 500/)

    const row = getDB().select().from(analyses).where(eq(analyses.id, analysisId)).get()
    expect(row?.status).toBe('error')
    expect(row?.error).toMatch(/HTTP 500/)
    expect(row?.finishedAt).not.toBeNull()
    expect(deps.llm.generateCalls).toEqual([])
  })

  test('a project without any repository marks the analysis error without an llm call', async () => {
    const { projectId, analysisId } = insertProjectWithRepo({ withRepository: false })
    const deps = fakeDeps()

    await expect(runInitialAnalysis({ analysisId, projectId }, deps)).resolves.toBeUndefined()

    const row = getDB().select().from(analyses).where(eq(analyses.id, analysisId)).get()
    expect(row?.status).toBe('error')
    expect(row?.error).toMatch(/no repository/)
    expect(deps.llm.generateCalls).toEqual([])
  })

  test('a deleted analysis row ends the run quietly', async () => {
    const { projectId } = insertProjectWithRepo()
    const deps = fakeDeps()

    await expect(runInitialAnalysis({ analysisId: 99999, projectId }, deps)).resolves.toBeUndefined()
    expect(deps.llm.generateCalls).toEqual([])
  })

  test('blobs over the size cap are skipped from the digest, not fatal', async () => {
    const { projectId, analysisId } = insertProjectWithRepo()
    const huge: GithubTreeEntry[] = [
      ...TREE,
      { path: 'src/generated/huge.ts', type: 'blob', sha: 'sha-huge', size: 600 * 1024 },
    ]
    const deps = fakeDeps({ tree: huge })
    deps.github.getBlob = async (_owner, _repo, sha) => {
      deps.github.getBlobCalls.push(sha)
      return sha === 'sha-huge' ? `${'x'.repeat(600 * 1024)}` : (BLOBS[sha] ?? '')
    }

    await runInitialAnalysis({ analysisId, projectId }, deps)

    // The file still counts as scanned, but its content never reaches the prompt.
    const row = getDB().select().from(analyses).where(eq(analyses.id, analysisId)).get()
    expect(JSON.parse(row?.statsJson ?? '{}')).toEqual({ features: 6, scenarios: 12, files: CODE_FILE_COUNT + 1 })
    const inventoryPrompt = deps.llm.generateCalls[0]?.prompt ?? ''
    expect(inventoryPrompt).not.toContain('--- src/generated/huge.ts ---')
    expect(inventoryPrompt).not.toContain('xxxxxxxxxx')
    // The digest stays honest about what was left out, without the contents.
    expect(inventoryPrompt).toContain('src/generated/huge.ts: skipped')
  })
})

describe('filterCodeFiles', () => {
  test('keeps allowlisted code files and drops noise', () => {
    const paths = filterCodeFiles(TREE).map((file) => file.path)
    expect(paths).toEqual([
      'README.md',
      'package.json',
      'src/auth/login.ts',
      'src/auth/session.ts',
      'src/tasks/list.ts',
      'src/tasks/create.ts',
      'src/styles.css',
    ])
  })

  test('drops lockfiles, dist and node_modules wherever they appear in the path', () => {
    const entries: GithubTreeEntry[] = [
      { path: 'apps/web/package-lock.json', type: 'blob', sha: 'a', size: 10 },
      { path: 'apps/web/pnpm-lock.yaml', type: 'blob', sha: 'b', size: 10 },
      { path: 'apps/web/yarn.lock', type: 'blob', sha: 'c', size: 10 },
      { path: 'packages/ui/dist/index.js', type: 'blob', sha: 'd', size: 10 },
      { path: 'node_modules/vue/index.js', type: 'blob', sha: 'e', size: 10 },
      { path: 'src/use-cases.mjs', type: 'blob', sha: 'f', size: 10 },
    ]
    expect(filterCodeFiles(entries).map((file) => file.path)).toEqual(['src/use-cases.mjs'])
  })

  test('drops binaries and non-blob tree entries', () => {
    const entries: GithubTreeEntry[] = [
      { path: 'assets/logo.png', type: 'blob', sha: 'a', size: 10 },
      { path: 'fonts/inter.woff2', type: 'blob', sha: 'b', size: 10 },
      { path: 'archive.zip', type: 'blob', sha: 'c', size: 10 },
      { path: 'src', type: 'tree', sha: 'd', size: 0 },
      { path: 'main.py', type: 'blob', sha: 'e', size: 10 },
    ]
    expect(filterCodeFiles(entries).map((file) => file.path)).toEqual(['main.py'])
  })
})

describe('featureSlug', () => {
  test.each([
    ['Authentication', 'authentication'],
    ['Task list', 'task-list'],
    ['Inv--Report ', 'inv-report'],
    ['Ümlaut Flow', 'mlaut-flow'],
  ])('slugs %s to %s', (name, expected) => {
    expect(featureSlug(name)).toBe(expected)
  })
})

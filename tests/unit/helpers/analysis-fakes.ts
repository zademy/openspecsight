import type { z } from 'zod'
import { GithubError, type GithubCommitInfo, type GithubComparison, type GithubService, type GithubTreeEntry } from '../../../server/services/github.service'
import type { LlmClient } from '../../../server/services/llm.service'
import type { FeatureInventorySchema, FeatureScenariosSchema } from '../../../shared/schemas'

/**
 * Shared in-memory fixtures and fake clients for the pipeline services
 * (analysis + sync). Nothing here touches the network: the fake github serves
 * a fixed tree/blobs/commit list and the fake llm validates scripted responses
 * through the same zod schemas the real client uses (mirrors LLM_MOCK mode,
 * including unknown-key stripping).
 */

export const TREE: GithubTreeEntry[] = [
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
  { path: 'node_modules/left-pad/index.js', type: 'blob', sha: 'sha-nm', size: 30 },
]

/** Seven of the fourteen tree entries above pass the code-file filter. */
export const CODE_FILE_COUNT = 7

export const BLOBS: Record<string, string> = {
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
export const INVENTORY: z.infer<typeof FeatureInventorySchema> = {
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
export const SCENARIOS: Record<string, z.infer<typeof FeatureScenariosSchema>> = {
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

export interface FakeGithub extends GithubService {
  /** Blob reads the pipeline issued, in call order. */
  getBlobCalls: string[]
  /** compareCommits calls, in order, with the base/head the service chose. */
  compareCalls: Array<{ base: string, head: string }>
}

export interface FakeGithubOptions {
  tree?: GithubTreeEntry[]
  headSha?: string
  /** Full commit list, newest first; listCommits slices it to perPage. */
  commits?: GithubCommitInfo[]
  /** compareCommits answer; defaults to an empty comparison. */
  comparison?: GithubComparison
}

/** Fake github service serving the fixture tree/blobs and a fixed commit list. */
export function fakeGithub(options: FakeGithubOptions = {}): FakeGithub {
  const getBlobCalls: string[] = []
  const compareCalls: Array<{ base: string, head: string }> = []
  const commits: GithubCommitInfo[] = options.commits ?? [{
    sha: options.headSha ?? 'head-sha-aaa',
    message: 'feat: seed the demo repo',
    authorName: 'Ada Lovelace',
    committedAt: '2026-11-01T10:00:00Z',
  }]
  const comparison: GithubComparison = options.comparison ?? { commits: [], files: [] }
  return {
    getBlobCalls,
    compareCalls,
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
    compareCommits: async (_owner, _repo, base, head) => {
      compareCalls.push({ base, head })
      return comparison
    },
    listCommits: async (_owner, _repo, _ref, perPage) => commits.slice(0, perPage ?? commits.length),
  }
}

export interface FakeLlm extends LlmClient {
  /** One entry per generate() call, in call order. */
  generateCalls: Array<{ name: string, prompt: string }>
}

/** Fake llm client scripted per generate() name; validates through the schema. */
export function fakeLlm(responses: Record<string, unknown>): FakeLlm {
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

export interface FakeDepsOptions {
  tree?: GithubTreeEntry[]
  headSha?: string
  commits?: GithubCommitInfo[]
  comparison?: GithubComparison
  responses?: Record<string, unknown>
}

/** Default deps: fixture github + scripted mock-mode llm responses. */
export function fakeDeps(options: FakeDepsOptions = {}): { github: FakeGithub, llm: FakeLlm } {
  return {
    github: fakeGithub(options),
    llm: fakeLlm(options.responses ?? {
      'feature-inventory': INVENTORY,
      'feature-scenarios:authentication': SCENARIOS.authentication,
      'feature-scenarios:tasks': SCENARIOS.tasks,
    }),
  }
}

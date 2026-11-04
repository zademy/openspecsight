import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { registerGithubRoutes, type GithubStubRoute } from './github-stub'

/**
 * Fixture-backed stub routes for a whole repository: repo info, the recursive
 * tree, blob reads by sha, and the commits list. Everything is data-driven —
 * route handlers read `fixtures/github/<repo>-tree.json` and
 * `fixtures/github/<repo>-blobs.json` (sha → utf-8 content), and the commits
 * list reuses `fixtures/github/commits.json`. Unmapped paths keep answering
 * the stub's default GitHub 404 shape.
 */

/** Loads a JSON fixture from the repo's fixtures/github directory. */
async function loadFixture(filename: string): Promise<unknown> {
  const file = path.resolve(process.cwd(), 'fixtures', 'github', filename)
  return JSON.parse(await readFile(file, 'utf8'))
}

export interface StubRepoOptions {
  owner: string
  repo: string
  defaultBranch?: string
  /**
   * Fixture basename to serve this repo's routes from; defaults to `repo`.
   * Several repos can share one fixture set without sharing the mutable
   * stub state, so parallel test workers never flip each other's commits.
   */
  fixtureAlias?: string
  /**
   * Delay applied once to the first blob read, to model a slow upstream so
   * tests can observe in-flight states (e.g. the analysis progress UI).
   */
  firstBlobDelayMs?: number
}

/**
 * The fixture states a stub repo can serve. `initial` is the plain fixture
 * set (tasks-tree/-blobs/commits); `after-auth-commit` swaps the commit list
 * for one with a new head and serves the auth-file compare payload from
 * `<repo>-compare.json`, so sync pipelines have something to diff. Tests
 * switch states with POST /_admin/state (see registerStubAdmin).
 */
export type StubRepoState = 'initial' | 'after-auth-commit'

const STUB_REPO_STATES: StubRepoState[] = ['initial', 'after-auth-commit']
const repoStates = new Map<string, StubRepoState>()
/** owner/repo keys registered via registerStubRepo — the admin route only flips these. */
const registeredRepos = new Map<string, StubRepoOptions>()

/** Points a repo's stub routes at a fixture state. Tests clean up after themselves. */
export function setStubRepoState(repo: string, state: StubRepoState): void {
  if (!STUB_REPO_STATES.includes(state)) {
    throw new Error(`Unknown stub repo state: ${state} (expected one of ${STUB_REPO_STATES.join(', ')})`)
  }
  repoStates.set(repo, state)
}

export function getStubRepoState(repo: string): StubRepoState {
  return repoStates.get(repo) ?? 'initial'
}

/**
 * Registers the test-only admin routes: POST /_admin/state with
 * `{ repo, state }` switches which fixture set the repo's routes serve;
 * GET /_admin/state reports the current mapping (defaults omitted).
 */
export function registerStubAdmin(): void {
  registerGithubRoutes(
    {
      method: 'GET',
      pattern: '/_admin/state',
      handler: () => ({ body: { states: Object.fromEntries(repoStates) } }),
    },
    {
      method: 'POST',
      pattern: '/_admin/state',
      handler: (_req, body) => {
        const parsed = JSON.parse(body || '{}') as { repo?: string, state?: string }
        const knownRepos = [...registeredRepos.keys()]
        if (!parsed.repo || !STUB_REPO_STATES.includes(parsed.state as StubRepoState) || !knownRepos.includes(parsed.repo)) {
          return {
            status: 400,
            body: { error: `expected { repo, state } with state in [${STUB_REPO_STATES.join(', ')}] and repo in [${knownRepos.join(', ')}]` },
          }
        }
        setStubRepoState(parsed.repo, parsed.state as StubRepoState)
        return { body: { repo: parsed.repo, state: getStubRepoState(parsed.repo) } }
      },
    },
  )
}

/** Registers the full route set for one repository on the GitHub stub. */
export function registerStubRepo(options: StubRepoOptions): void {
  const { owner, repo } = options
  const repoName = `${owner}/${repo}`
  const fixtureName = options.fixtureAlias ?? repo
  registeredRepos.set(repoName, options)
  const base = `/repos/${owner}/${repo}`
  let blobReads = 0

  const routes: GithubStubRoute[] = [
    {
      method: 'GET',
      pattern: base,
      handler: async () => {
        const repoInfo = await loadFixture('repo.json') as { name: string, full_name: string }
        return { body: { ...repoInfo, name: repo, full_name: `${owner}/${repo}`, default_branch: options.defaultBranch ?? 'main' } }
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^${base}/git/trees/[^/]+$`),
      handler: async () => ({ body: await loadFixture(`${fixtureName}-tree.json`) }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^${base}/git/blobs/[0-9a-f]{40}$`),
      handler: async (req) => {
        if (options.firstBlobDelayMs !== undefined && blobReads === 0) {
          blobReads += 1
          await new Promise((resolve) => setTimeout(resolve, options.firstBlobDelayMs))
        }
        const sha = new URL(req.url ?? '/', 'http://stub').pathname.split('/').pop() ?? ''
        const blobs = await loadFixture(`${fixtureName}-blobs.json`) as Record<string, string>
        const content = blobs[sha]
        if (content === undefined) {
          return { status: 404, body: { message: 'Not Found' } }
        }
        const bytes = Buffer.from(content, 'utf8')
        return {
          body: { sha, node_id: `B_${sha.slice(0, 8)}`, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' },
        }
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^${base}/commits$`),
      handler: async () => {
        if (getStubRepoState(repoName) === 'after-auth-commit') {
          // The compare fixture lists commits oldest→newest; the REST list
          // endpoint answers newest→oldest.
          const compare = await loadFixture(`${fixtureName}-compare.json`) as { commits: unknown[] }
          return { body: [...compare.commits].reverse() }
        }
        return { body: await loadFixture('commits.json') }
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^${base}/compare/[^/]+$`),
      handler: async () => {
        if (getStubRepoState(repoName) === 'after-auth-commit') {
          return { body: await loadFixture(`${fixtureName}-compare.json`) }
        }
        // No state pushed (or still initial): nothing ever differs.
        return { body: { status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, commits: [], files: [] } }
      },
    },
  ]

  registerGithubRoutes(...routes)
}

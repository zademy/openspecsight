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
   * Delay applied once to the first blob read, to model a slow upstream so
   * tests can observe in-flight states (e.g. the analysis progress UI).
   */
  firstBlobDelayMs?: number
}

/** Registers the full route set for one repository on the GitHub stub. */
export function registerStubRepo(options: StubRepoOptions): void {
  const { owner, repo } = options
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
      handler: async () => ({ body: await loadFixture(`${repo}-tree.json`) }),
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
        const blobs = await loadFixture(`${repo}-blobs.json`) as Record<string, string>
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
      handler: async () => ({ body: await loadFixture('commits.json') }),
    },
  ]

  registerGithubRoutes(...routes)
}

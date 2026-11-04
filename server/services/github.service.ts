import { Octokit, RequestError } from 'octokit'

const DEFAULT_BASE_URL = 'https://api.github.com'

/**
 * GitHub REST access behind a small interface, so the rest of the server never
 * touches octokit directly. One Octokit instance per service, no caching —
 * create a fresh service per scan and discard it.
 *
 * `baseUrl` defaults to `GITHUB_API_BASE` and `token` to `GITHUB_TOKEN`
 * (falling back to unauthenticated requests), both read when
 * `createGithubService()` is called, so tests can point the service at a stub
 * server. Every failure surfaces as `GithubError` carrying the owner/repo in
 * the message and the HTTP status when GitHub returned one.
 */

/** Error raised for any failed GitHub interaction. */
export class GithubError extends Error {
  /** HTTP status from GitHub, when the failure had one. */
  readonly status: number | undefined

  constructor(message: string, options: { status?: number, cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'GithubError'
    this.status = options.status
  }
}

export interface GithubRepoInfo {
  defaultBranch: string
}

export interface GithubTreeEntry {
  path: string
  type: 'blob' | 'tree'
  sha: string
  size: number
}

export interface GithubCommitInfo {
  sha: string
  message: string
  authorName: string
  committedAt: string
}

export interface GithubCommitFile {
  filename: string
  /** Unified diff; GitHub omits it for oversized or binary changes. */
  patch?: string
}

export interface GithubComparison {
  commits: GithubCommitInfo[]
  files: GithubCommitFile[]
}

export interface GithubService {
  getRepo(owner: string, repo: string): Promise<GithubRepoInfo>
  /** Recursive tree listing. Submodule (`type: 'commit'`) entries are skipped. */
  getTree(owner: string, repo: string, ref: string): Promise<GithubTreeEntry[]>
  /** Blob content decoded from GitHub's wrapped base64 to utf-8 text. */
  getBlob(owner: string, repo: string, sha: string): Promise<string>
  compareCommits(owner: string, repo: string, base: string, head: string): Promise<GithubComparison>
  listCommits(owner: string, repo: string, ref: string, perPage?: number): Promise<GithubCommitInfo[]>
}

export interface CreateGithubServiceOptions {
  token?: string
  baseUrl?: string
}

/** Structural view of the octokit commit payloads this service maps from. */
interface RawCommit {
  sha: string
  commit: {
    message: string
    author?: { name?: string, date?: string } | null
    committer?: { name?: string, date?: string } | null
  }
}

export function createGithubService(options: CreateGithubServiceOptions = {}): GithubService {
  const baseUrl = options.baseUrl ?? (process.env.GITHUB_API_BASE?.trim() || DEFAULT_BASE_URL)
  const token = options.token ?? (process.env.GITHUB_TOKEN?.trim() || undefined)
  const octokit = new Octokit({ ...(token ? { auth: token } : {}), baseUrl })

  return {
    async getRepo(owner, repo) {
      try {
        const { data } = await octokit.rest.repos.get({ owner, repo })
        return { defaultBranch: data.default_branch }
      } catch (error) {
        fail('fetch repository info', owner, repo, error)
      }
    },

    async getTree(owner, repo, ref) {
      try {
        const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: ref, recursive: '1' })
        if (data.truncated) {
          throw new GithubError(`Git tree ${owner}/${repo}@${ref} is truncated and entries are missing; refusing an incomplete scan`)
        }
        return data.tree.flatMap((entry) => {
          if (entry.type !== 'blob' && entry.type !== 'tree') {
            return []
          }
          return [{
            path: entry.path ?? '',
            type: entry.type,
            sha: entry.sha ?? '',
            size: entry.type === 'blob' ? entry.size ?? 0 : 0,
          }]
        })
      } catch (error) {
        fail('fetch git tree', owner, repo, error)
      }
    },

    async getBlob(owner, repo, sha) {
      try {
        const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: sha })
        // Buffer's base64 decoder ignores the line wraps GitHub inserts.
        return Buffer.from(data.content, 'base64').toString('utf8')
      } catch (error) {
        fail('fetch blob', owner, repo, error)
      }
    },

    async compareCommits(owner, repo, base, head) {
      try {
        const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base, head })
        return {
          commits: data.commits.map(toCommitInfo),
          files: (data.files ?? []).map(file => file.patch === undefined
            ? { filename: file.filename }
            : { filename: file.filename, patch: file.patch }),
        }
      } catch (error) {
        fail('compare commits', owner, repo, error)
      }
    },

    async listCommits(owner, repo, ref, perPage) {
      try {
        const { data } = await octokit.rest.repos.listCommits({ owner, repo, sha: ref, per_page: perPage })
        return data.map(toCommitInfo)
      } catch (error) {
        fail('list commits', owner, repo, error)
      }
    },
  }
}

function toCommitInfo(raw: RawCommit): GithubCommitInfo {
  return {
    sha: raw.sha,
    message: raw.commit.message,
    authorName: raw.commit.author?.name ?? '',
    committedAt: raw.commit.author?.date ?? raw.commit.committer?.date ?? '',
  }
}

/** Re-throw any error as `GithubError`; never let raw octokit errors escape. */
function fail(action: string, owner: string, repo: string, error: unknown): never {
  if (error instanceof RequestError) {
    throw new GithubError(`GitHub ${action} for ${owner}/${repo} failed with HTTP ${error.status}: ${error.message}`, {
      status: error.status,
      cause: error,
    })
  }
  if (error instanceof GithubError) {
    throw error
  }
  throw new GithubError(`GitHub ${action} for ${owner}/${repo} failed: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  })
}

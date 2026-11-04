import { beforeEach, describe, expect, test } from 'vitest'
import { createGithubService, GithubError } from '../../server/services/github.service'
import { startStubServer, type StubRoute, type StubServer } from './helpers/stub-server'

/**
 * The service talks to a local stub server whose routes serve the fixture
 * files in `fixtures/github/`. Each test gets its own stub on a random port,
 * and GITHUB_* env vars are cleared so baseUrl/token only come from the
 * injected options unless a test sets them explicitly.
 */
beforeEach(() => {
  delete process.env.GITHUB_API_BASE
  delete process.env.GITHUB_TOKEN
})

async function withStub(routes: StubRoute[], run: (stub: StubServer) => Promise<void>): Promise<void> {
  const stub = await startStubServer()
  stub.route(...routes)
  try {
    await run(stub)
  } finally {
    await stub.stop()
  }
}

describe('createGithubService()', () => {
  test('getRepo returns the default branch', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget', fixture: 'repo.json' },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl })

      await expect(service.getRepo('acme', 'widget')).resolves.toEqual({ defaultBranch: 'main' })
      expect(stub.requests).toEqual([
        expect.objectContaining({ method: 'GET', path: '/repos/acme/widget' }),
      ])
    })
  })

  test('getTree maps blob and tree entries recursively and skips submodule entries', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget/git/trees/main', fixture: 'tree.json' },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl })

      await expect(service.getTree('acme', 'widget', 'main')).resolves.toEqual([
        { path: 'README.md', type: 'blob', sha: '9d5b6b27e29d2aa6d1e2e7a10f8f2f5c2f1a0e33', size: 742 },
        { path: 'src', type: 'tree', sha: 'b7f2c3a1d0e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9', size: 0 },
        { path: 'src/index.ts', type: 'blob', sha: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4', size: 1204 },
      ])
      expect(stub.requests[0]?.query.recursive).toBe('1')
    })
  })

  test('getTree rejects with a GithubError naming owner and ref when the tree is truncated', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget/git/trees/main', fixture: 'tree-truncated.json' },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl })

      const error = await service.getTree('acme', 'widget', 'main').then(
        () => null,
        (caught: unknown) => caught,
      )

      expect(error).toBeInstanceOf(GithubError)
      expect((error as GithubError).message).toContain('acme/widget@main')
    })
  })

  test('getBlob decodes the base64 content to utf-8', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget/git/blobs/e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4', fixture: 'blob.json' },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl })

      const content = await service.getBlob('acme', 'widget', 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4')

      expect(content).toBe('Widget is a small TypeScript library used by the OpenSpecSight demos.\nIt ships a tiny parser and a CLI wrapper for local runs.\n')
    })
  })

  test('compareCommits maps commits and files, keeping patch only when present', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget/compare/main...feature/tasks', fixture: 'compare.json' },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl })

      await expect(service.compareCommits('acme', 'widget', 'main', 'feature/tasks')).resolves.toEqual({
        commits: [
          { sha: 'fff09124a5b6c7d8e9f0a1b2c3d4e5f60718293a', message: 'feat: add tasks module', authorName: 'Ada Lovelace', committedAt: '2026-10-28T09:15:00Z' },
          { sha: 'bbb4567890abcdeffedcba9876543210fedcba99', message: 'fix: trim scenario titles', authorName: 'Grace Hopper', committedAt: '2026-10-30T18:40:00Z' },
        ],
        files: [
          { filename: 'src/tasks.ts', patch: '@@ -0,0 +1,3 @@\n+export function createTasks() {\n+  return []\n+}\n' },
          { filename: 'assets/logo.svg' },
        ],
      })
      expect(stub.requests[0]?.path).toBe('/repos/acme/widget/compare/main...feature/tasks')
    })
  })

  test('listCommits maps commits and forwards the ref and page size', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget/commits', fixture: 'commits.json' },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl })

      await expect(service.listCommits('acme', 'widget', 'main', 5)).resolves.toEqual([
        { sha: 'fff09124a5b6c7d8e9f0a1b2c3d4e5f60718293a', message: 'feat: add tasks module', authorName: 'Ada Lovelace', committedAt: '2026-10-28T09:15:00Z' },
        { sha: 'bbb4567890abcdeffedcba9876543210fedcba99', message: 'fix: trim scenario titles', authorName: 'Grace Hopper', committedAt: '2026-10-30T18:40:00Z' },
      ])
      expect(stub.requests[0]).toEqual(expect.objectContaining({
        path: '/repos/acme/widget/commits',
        query: expect.objectContaining({ sha: 'main', per_page: '5' }),
      }))
    })
  })

  test('a 404 without a token rejects with a GithubError naming owner/repo and the status', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/secret-vault', fixture: 'not-found.json', status: 404 },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl })

      const error = await service.getRepo('acme', 'secret-vault').then(
        () => null,
        (caught: unknown) => caught,
      )

      expect(error).toBeInstanceOf(GithubError)
      expect(error).toBeInstanceOf(Error)
      expect((error as GithubError).status).toBe(404)
      expect((error as GithubError).message).toContain('acme/secret-vault')
      expect((error as GithubError).message).toContain('404')
    })
  })

  test('without options the baseUrl comes from GITHUB_API_BASE', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget', fixture: 'repo.json' },
    ], async (stub) => {
      process.env.GITHUB_API_BASE = stub.baseUrl
      const service = createGithubService()

      await expect(service.getRepo('acme', 'widget')).resolves.toEqual({ defaultBranch: 'main' })
    })
  })

  test('a provided token is sent in the Authorization header', async () => {
    await withStub([
      { method: 'GET', pattern: '/repos/acme/widget', fixture: 'repo.json' },
    ], async (stub) => {
      const service = createGithubService({ baseUrl: stub.baseUrl, token: 'ghs_testtoken123' })

      await service.getRepo('acme', 'widget')

      expect(String(stub.requests[0]?.headers.authorization)).toContain('ghs_testtoken123')
    })
  })
})

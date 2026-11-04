import { registerStubAdmin, registerStubRepo } from '../helpers/github-fixtures'
import { registerGithubRoutes, startGithubStub, stopGithubStub } from '../helpers/github-stub'

/**
 * Playwright global setup: boots the GitHub REST API stub on 127.0.0.1:9876
 * before the webServer is probed, so `GITHUB_API_BASE` inside the dev server
 * already resolves. Route-table style: register the repos the e2e specs
 * exercise — full pipeline fixtures for `acme/tasks` (tree, blobs, commits),
 * `acme/slowpoke` with a one-shot 5 s blob delay so tests can observe the
 * analysis progress UI mid-run, `acme/changes` and `acme/flow` as fixture
 * aliases of `tasks` so the state-flipping specs stay isolated from each
 * other under fullyParallel workers, the unknown-repo case kept explicit so
 * the route table documents every repo a test relies on, and the test-only
 * `/_admin/state` routes that swap a repo to the `after-auth-commit` fixture
 * state for sync specs. Everything else keeps answering GitHub's default
 * 404 shape.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  registerGithubRoutes(
    {
      method: 'GET',
      pattern: '/repos/acme/missing',
      handler: () => ({
        status: 404,
        body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository', status: '404' },
      }),
    },
  )

  registerStubRepo({ owner: 'acme', repo: 'tasks' })
  registerStubRepo({ owner: 'acme', repo: 'slowpoke', firstBlobDelayMs: 5000 })
  // `changes` and `flow` serve the same fixtures as `tasks` but keep their
  // own mutable state: their specs flip commits mid-run, and with
  // fullyParallel workers a shared state would flip under each other's
  // syncs. The base `tasks` repo stays reserved for sync.spec.
  registerStubRepo({ owner: 'acme', repo: 'changes', fixtureAlias: 'tasks' })
  registerStubRepo({ owner: 'acme', repo: 'flow', fixtureAlias: 'tasks' })
  registerStubRepo({ owner: 'acme', repo: 'digests', fixtureAlias: 'tasks' })
  registerStubRepo({ owner: 'acme', repo: 'digests-api', fixtureAlias: 'tasks' })
  registerStubRepo({ owner: 'acme', repo: 'notes', fixtureAlias: 'tasks' })
  registerStubAdmin()

  await startGithubStub()

  return async () => {
    await stopGithubStub()
  }
}

import { registerStubRepo } from '../helpers/github-fixtures'
import { registerGithubRoutes, startGithubStub, stopGithubStub } from '../helpers/github-stub'

/**
 * Playwright global setup: boots the GitHub REST API stub on 127.0.0.1:9876
 * before the webServer is probed, so `GITHUB_API_BASE` inside the dev server
 * already resolves. Route-table style: register the repos the e2e specs
 * exercise — full pipeline fixtures for `acme/tasks` (tree, blobs, commits),
 * `acme/slowpoke` with a one-shot 5 s blob delay so tests can observe the
 * analysis progress UI mid-run, and the unknown-repo case kept explicit so
 * the route table documents every repo a test relies on. Everything else
 * keeps answering GitHub's default 404 shape.
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

  await startGithubStub()

  return async () => {
    await stopGithubStub()
  }
}

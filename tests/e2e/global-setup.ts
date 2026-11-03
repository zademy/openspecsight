import { startGithubStub, stopGithubStub } from '../helpers/github-stub'

/**
 * Playwright global setup: boots the GitHub REST API stub on 127.0.0.1:9876
 * before the webServer is probed, so `GITHUB_API_BASE` inside the dev server
 * already resolves. Later tasks register fixture routes from here.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await startGithubStub()

  return async () => {
    await stopGithubStub()
  }
}

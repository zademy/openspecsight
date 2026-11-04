import { expect, test, type Page } from '@playwright/test'

/**
 * The Playwright webServer env sets AUTH_PASSWORD=test-pass and
 * SESSION_SECRET=test-secret. The `/api/projects` route itself only appears in
 * Task 6 — the auth middleware runs before route matching, so the 401 works
 * regardless.
 */
test.describe('auth', () => {
  // Hydration re-mounts the form and resets the password input from state —
  // wait until the client app owns the DOM, or an early fill gets wiped and
  // sign-in submits an empty password (the same ruling the other specs'
  // login helpers carry).
  async function waitForLoginHydration(page: Page): Promise<void> {
    await page.waitForFunction(() => {
      const nuxtApp = (window as unknown as { useNuxtApp?: () => { isHydrating: boolean } }).useNuxtApp
      return nuxtApp?.().isHydrating === false
    })
  }

  test('unauthenticated visit to / redirects to /login', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByLabel('Password')).toBeVisible()
  })

  test('wrong password shows an error and stays on /login', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Password').fill('wrong-password')
    await waitForLoginHydration(page)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByText('Incorrect password')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('correct password from /login lands on /', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Password').fill('test-pass')
    await waitForLoginHydration(page)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL('http://localhost:3000/')
    await expect(page.locator('h1')).toHaveText('OpenSpecSight')
  })

  test('a bounced visit returns to its target after login', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveURL(/\/login/)

    await page.getByLabel('Password').fill('test-pass')
    await waitForLoginHydration(page)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL('http://localhost:3000/')
    await expect(page.locator('h1')).toHaveText('OpenSpecSight')
  })

  test('GET /api/projects without a cookie returns 401', async ({ request }) => {
    const response = await request.get('/api/projects')

    expect(response.status()).toBe(401)
  })
})

import { expect, test } from '@playwright/test'

/**
 * The Playwright webServer env sets AUTH_PASSWORD=test-pass and
 * SESSION_SECRET=test-secret. The `/api/projects` route itself only appears in
 * Task 6 — the auth middleware runs before route matching, so the 401 works
 * regardless.
 */
test.describe('auth', () => {
  test('unauthenticated visit to / redirects to /login', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByLabel('Password')).toBeVisible()
  })

  test('wrong password shows an error and stays on /login', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Password').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByText('Incorrect password')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('correct password from /login lands on /', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Password').fill('test-pass')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL('http://localhost:3000/')
    await expect(page.locator('h1')).toHaveText('OpenSpecSight')
  })

  test('a bounced visit returns to its target after login', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveURL(/\/login/)

    await page.getByLabel('Password').fill('test-pass')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL('http://localhost:3000/')
    await expect(page.locator('h1')).toHaveText('OpenSpecSight')
  })

  test('GET /api/projects without a cookie returns 401', async ({ request }) => {
    const response = await request.get('/api/projects')

    expect(response.status()).toBe(401)
  })
})

import { expect, test } from '@playwright/test'

test.describe('smoke', () => {
  test('home page renders the product name', async ({ page }) => {
    // Page routes are behind auth since Task 3: log in via the API before
    // visiting (page.request shares the cookie jar with the browser context).
    await page.request.post('/api/auth/login', { data: { password: 'test-pass' } })
    await page.goto('/')

    await expect(page).toHaveTitle(/OpenSpecSight/)
    await expect(page.locator('h1')).toHaveText('OpenSpecSight')
  })
})

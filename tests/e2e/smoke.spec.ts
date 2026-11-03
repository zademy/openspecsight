import { expect, test } from '@playwright/test'

test.describe('smoke', () => {
  test('home page renders the product name', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveTitle(/OpenSpecSight/)
    await expect(page.locator('h1')).toHaveText('OpenSpecSight')
  })
})

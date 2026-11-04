import { expect, type Page } from '@playwright/test'

/**
 * The shared sign-in for every spec. Hydration re-mounts the login form and
 * resets the password input from state, so the wait for client ownership
 * happens before the fill: an early fill gets wiped and sign-in submits an
 * empty password (the ruling 4eb0c54 established).
 */

/** Waits until the client app owns the login form's DOM. */
async function waitForLoginHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const nuxtApp = (window as unknown as { useNuxtApp?: () => { isHydrating: boolean } }).useNuxtApp
    return nuxtApp?.().isHydrating === false
  })
}

/**
 * Waits for hydration, then fills and submits. For tests already sitting on
 * a login page whose landing differs from the overview: a wrong password
 * (stays on /login) or a bounce-back target (/login?redirect=/...).
 */
export async function submitLogin(page: Page, password: string): Promise<void> {
  await waitForLoginHydration(page)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** Opens /login, signs in, and asserts the landing on the overview page. */
export async function login(page: Page, password = 'test-pass'): Promise<void> {
  await page.goto('/login')
  await submitLogin(page, password)
  await expect(page).toHaveURL('http://localhost:3000/')
}

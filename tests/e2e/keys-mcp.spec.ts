import { expect, test, type APIRequestContext, type Page, type Playwright } from '@playwright/test'
import { login } from './helpers/login'

/**
 * API keys and the MCP server end to end against the production build: the
 * settings UI creates a key and shows it exactly once, a bearer credential
 * reads but never writes, the key management routes stay session-only with
 * honest validation errors, and /mcp speaks both protocol eras over one
 * bearer key until the UI revokes it. Every assertion matches on shapes
 * (prefix patterns, field name lists) so a failure never prints a live key
 * into the report. Names are per test. Revocation is the only teardown a
 * key ever gets (DELETE /api/keys/:id stamps revokedAt, the row persists),
 * so before each UI touchpoint the leftovers of earlier runs are revoked
 * and every list locator scopes to the one active (non revoked) row.
 */

/** A full key: sk_sp_ plus 43 base64url characters. The display prefix never matches, it holds an ellipsis. */
const FULL_KEY_PATTERN = /sk_sp_[A-Za-z0-9_-]{43}/
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-06-18'
const META_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
const TOOL_NAMES = ['ask', 'get_feature', 'list_features', 'list_projects', 'recent_changes', 'search_spec']

/**
 * Session context for the setup steps: a fresh APIRequestContext that logs
 * in once and then creates and cleans up fixtures. The `request` fixture of
 * the same test stays pristine (cookie-less) because a session cookie would
 * win over the Authorization header and falsify the bearer matrix.
 */
async function newSession(playwright: Playwright): Promise<APIRequestContext> {
  const session = await playwright.request.newContext({ baseURL: 'http://localhost:3000' })
  const response = await session.post('/api/auth/login', { data: { password: 'test-pass' } })
  expect(response.status()).toBe(200)
  return session
}

/**
 * Revokes every key with the name, active or already revoked (DELETE is a
 * soft revoke and answers 204 for both). Rows persist forever by design,
 * so this is the whole teardown: afterwards exactly zero keys with the
 * name are active, which the active-row locators rely on.
 */
async function revokeLeftoverKeys(request: APIRequestContext, name: string): Promise<void> {
  const response = await request.get('/api/keys')
  expect(response.status()).toBe(200)
  const keys = (await response.json()) as { keys: Array<{ id: string, name: string }> }
  for (const stale of keys.keys.filter((candidate) => candidate.name === name)) {
    expect((await request.delete(`/api/keys/${stale.id}`)).status()).toBe(204)
  }
}

/** The list row for an active (non revoked) key: unique after leftover revocation. */
function activeRow(page: Page, name: string) {
  return page.getByRole('listitem').filter({ hasText: name }).filter({ hasNot: page.getByText('Revoked') })
}

async function deleteProjectsByName(request: APIRequestContext, name: string): Promise<void> {
  const response = await request.get('/api/projects')
  expect(response.status()).toBe(200)
  const projects = (await response.json()) as Array<{ id: number, name: string }>
  for (const stale of projects.filter((project) => project.name === name)) {
    await request.delete(`/api/projects/${stale.id}`)
  }
}

/** Creates a key over the session API and answers the secret without ever logging it. */
async function createKeyViaApi(request: APIRequestContext, name: string): Promise<{ id: string, key: string }> {
  await revokeLeftoverKeys(request, name)
  const response = await request.post('/api/keys', { data: { name } })
  expect(response.status()).toBe(201)
  const created = (await response.json()) as { id: string, key: string }
  expect(FULL_KEY_PATTERN.test(created.key)).toBe(true)
  return created
}

/** The reveal panel's code element: the only DOM node that ever holds the full key. */
function revealCode(page: Page) {
  return page.locator('code').filter({ hasText: FULL_KEY_PATTERN })
}

/**
 * Creates a key through the settings UI: the reveal panel shows the secret
 * once next to its copy button, and Done discards it. Answers the captured
 * secret for bearer assertions later in the same test.
 */
async function createKeyViaUi(page: Page, name: string): Promise<string> {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'New API key' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create key' }).click()

  const revealed = revealCode(page)
  await expect(revealed).toBeVisible()
  await expect(page.getByRole('button', { name: `Copy the key for ${name}` })).toBeVisible()
  const key = (await revealed.textContent()) ?? ''
  expect(key.startsWith('sk_sp_')).toBe(true)
  expect(FULL_KEY_PATTERN.test(key)).toBe(true)

  await page.getByRole('button', { name: 'Done' }).click()
  await expect(revealed).toHaveCount(0)
  return key
}

test.describe('api keys and mcp', () => {
  // Serial: each test is self contained, but running them in one worker
  // keeps four browsers out of the fullyParallel pool. The suite's timing
  // sensitive specs (the ask modal waits) were sized for the old profile.
  test.describe.configure({ mode: 'serial' })

  test('creating a key in settings shows it once and then only its display prefix', async ({ page }) => {
    await login(page)
    await revokeLeftoverKeys(page.request, 'e2e key')
    await createKeyViaUi(page, 'e2e key')

    // The active list row carries the name and the masked prefix, never the
    // secret. Older runs leave revoked rows with the same name behind; the
    // active row is unique after the leftover revocation above.
    const row = activeRow(page, 'e2e key')
    await expect(row).toBeVisible()
    await expect(row.locator('code')).toHaveText(/^sk_sp_.{4}….{4}$/)

    // Nothing in the rendered DOM may still hold the full key after closing.
    const bodyText = (await page.locator('body').textContent()) ?? ''
    expect(FULL_KEY_PATTERN.test(bodyText)).toBe(false)

    // The list response carries neither the secret nor its hash, only the
    // six summary fields on the active row. The exact key list doubles as
    // the absence proof for the `key` and `keyHash` fields.
    const listResponse = await page.request.get('/api/keys')
    expect(listResponse.status()).toBe(200)
    const listBody = (await listResponse.json()) as { keys: Array<{ name: string, revokedAt: string | null } & Record<string, unknown>> }
    const e2eKeys = listBody.keys.filter((candidate) => candidate.name === 'e2e key' && candidate.revokedAt === null)
    expect(e2eKeys).toHaveLength(1)
    expect(Object.keys(e2eKeys[0]!).sort()).toEqual([
      'createdAt', 'displayPrefix', 'id', 'lastUsedAt', 'name', 'revokedAt',
    ])
    const listText = await listResponse.text()
    expect(FULL_KEY_PATTERN.test(listText)).toBe(false)

    await revokeLeftoverKeys(page.request, 'e2e key')
  })

  test('a bearer key reads projects but cannot write or reach key management', async ({ request, playwright }) => {
    const session = await newSession(playwright)
    const { id, key } = await createKeyViaApi(session, 'bearer key')
    const bearer = { authorization: `Bearer ${key}` }

    // `request` never holds a session, so these answer on credentials alone.
    expect((await request.get('/api/projects')).status()).toBe(401)
    expect((await request.get('/api/projects', { headers: bearer })).status()).toBe(200)
    expect((await request.post('/api/projects', {
      headers: bearer,
      data: { name: 'Nope', description: 'Never created', owner: 'acme', repo: 'tasks' },
    })).status()).toBe(403)

    // /api/keys is session-only in both directions, even for the key's own row.
    expect((await request.get('/api/keys', { headers: bearer })).status()).toBe(403)
    expect((await request.delete(`/api/keys/${id}`, { headers: bearer })).status()).toBe(403)

    // Creation validates the name for session callers: empty, over the
    // 60 character limit, and non-string names all answer 400.
    expect((await session.post('/api/keys', { data: { name: '' } })).status()).toBe(400)
    expect((await session.post('/api/keys', { data: { name: 'a'.repeat(61) } })).status()).toBe(400)
    expect((await session.post('/api/keys', { data: { name: 42 } })).status()).toBe(400)
    expect((await session.delete('/api/keys/no-such-key')).status()).toBe(404)

    await revokeLeftoverKeys(session, 'bearer key')
    await session.dispose()
  })

  test('the mcp endpoint authenticates and speaks both protocol eras', async ({ request, playwright }) => {
    const session = await newSession(playwright)
    const { key } = await createKeyViaApi(session, 'mcp key')
    const bearer = { authorization: `Bearer ${key}` }
    const modernHeaders = {
      ...bearer,
      'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/list',
    }

    // One seeded project through the session API: the same DB the tools read.
    await deleteProjectsByName(session, 'MCP Seed Fixture')
    const seed = await session.post('/api/projects', {
      data: { name: 'MCP Seed Fixture', description: 'Exercises the mcp tools', owner: 'acme', repo: 'tasks' },
    })
    expect(seed.status()).toBe(201)

    expect((await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status()).toBe(401)

    // Modern era: protocol version in header and _meta, plus the method header.
    const listResponse = await request.post('/mcp', {
      headers: modernHeaders,
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { _meta: { [META_PROTOCOL_VERSION_KEY]: MODERN_PROTOCOL_VERSION } },
      },
    })
    expect(listResponse.status()).toBe(200)
    const listed = (await listResponse.json()) as { result: { tools: Array<{ name: string }>, ttlMs: number } }
    expect(listed.result.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)
    expect(listed.result.ttlMs).toBeGreaterThan(0)

    const callResponse = await request.post('/mcp', {
      headers: { ...modernHeaders, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'list_projects' },
      data: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
    })
    expect(callResponse.status()).toBe(200)
    const call = (await callResponse.json()) as { result: { content: Array<{ text: string }> } }
    const projects = JSON.parse(call.result.content[0]!.text) as Array<{ name: string }>
    expect(projects.some((project) => project.name === 'MCP Seed Fixture')).toBe(true)

    // Legacy era: the initialize handshake pins 2025-06-18, and a headerless
    // tools/list answers the same six tools.
    const initResponse = await request.post('/mcp', {
      headers: bearer,
      data: {
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'legacy-e2e', version: '0.0.0' } },
      },
    })
    expect(initResponse.status()).toBe(200)
    const initialized = (await initResponse.json()) as { result: { protocolVersion: string, serverInfo: { name: string } } }
    expect(initialized.result.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION)
    expect(initialized.result.serverInfo.name).toBe('openspecsight')

    const legacyResponse = await request.post('/mcp', {
      headers: bearer,
      data: { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    })
    expect(legacyResponse.status()).toBe(200)
    const legacy = (await legacyResponse.json()) as { result: { tools: Array<{ name: string }> } }
    expect(legacy.result.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)

    // A modern request without the method header is a transport mismatch:
    // HTTP 400 with the -32020 header mismatch code.
    const missing = await request.post('/mcp', {
      headers: { ...bearer, 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION },
      data: { jsonrpc: '2.0', id: 6, method: 'tools/list' },
    })
    expect(missing.status()).toBe(400)
    const mismatch = (await missing.json()) as { error: { code: number } }
    expect(mismatch.error.code).toBe(-32020)

    await deleteProjectsByName(session, 'MCP Seed Fixture')
    await revokeLeftoverKeys(session, 'mcp key')
    await session.dispose()
  })

  test('revoking a key in settings cuts its bearer access off immediately', async ({ page, request }) => {
    await login(page)
    await revokeLeftoverKeys(page.request, 'revoke key')
    const key = await createKeyViaUi(page, 'revoke key')
    const bearer = { authorization: `Bearer ${key}` }

    expect((await request.get('/api/projects', { headers: bearer })).status()).toBe(200)

    const row = activeRow(page, 'revoke key')
    await row.getByRole('button', { name: 'Revoke revoke key' }).click()
    await page.getByRole('button', { name: 'Revoke key', exact: true }).click()
    // The created key was the only active row with the name; revocation
    // leaves none of them active (older revoked rows stay in the list).
    await expect(activeRow(page, 'revoke key')).toHaveCount(0)

    expect((await request.get('/api/projects', { headers: bearer })).status()).toBe(401)

    await revokeLeftoverKeys(page.request, 'revoke key')
  })
})

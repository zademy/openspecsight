import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { handleMcpRequest } from '../../server/services/mcp/server.service'
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  TOOLS_CACHE_SCOPE,
  TOOLS_TTL_MS,
  type McpRequestHeaders,
  type McpTool,
} from '../../server/services/mcp/protocol'

/**
 * Pins the dual-era MCP protocol core against the facts extracted from the
 * 2026-07-28 spec on 2026-11-06 (see docs/superpowers/specs/
 * 2026-11-06-mcp-api-keys-design.md section 5). Two picks are documented
 * here because the spec leaves them to the transport:
 *
 * - Malformed JSON (-32700) and invalid JSON-RPC envelopes (-32600) answer
 *   on HTTP 200: the endpoint is JSON-RPC-first and every well-formed HTTP
 *   response carries a readable JSON-RPC body. Only the MCP-defined
 *   transport rejections (header mismatch -32020, unsupported version
 *   -32022) use non-200 statuses (400), and unknown modern methods use the
 *   pinned 404.
 * - Modern validation precedence: protocol version header agreement first,
 *   then the supported-version gate, then Mcp-Method/Mcp-Name agreement.
 *   A probing client that gets its headers consistent always learns the
 *   version verdict (-32022) rather than a binding error.
 */

const echoTool: McpTool = {
  name: 'echo',
  title: 'Echo',
  description: 'Returns the arguments it received.',
  inputSchema: { type: 'object' },
  handler: async (args) => args,
}

const boomTool: McpTool = {
  name: 'boom',
  title: 'Boom',
  description: 'Always fails with an error.',
  inputSchema: { type: 'object' },
  handler: async () => {
    throw new Error('kaput')
  },
}

const countTool: McpTool = {
  name: 'zeta-count',
  title: 'Zeta count',
  description: 'Returns a structured object result.',
  inputSchema: { type: 'object' },
  handler: async () => ({ scenarioCount: 3 }),
}

// Deliberately unsorted: tools/list must answer alphabetically by name.
const FAKE_TOOLS = [countTool, echoTool, boomTool]

const SERVER_INFO = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }

function legacyCall(body: unknown, tools: McpTool[] = FAKE_TOOLS) {
  return handleMcpRequest({ body, headers: {}, tools })
}

/** Modern request body with the protocol version in params._meta. */
function modernBody(method: string, params: Record<string, unknown> = {}, id: number | null | undefined = 1) {
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    method,
    params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION } },
  }
  if (id !== undefined) {
    body.id = id
  }
  return body
}
/** Modern request headers consistent with modernBody (and params.name). */
function modernHeaders(method: string, name?: string, overrides: Partial<McpRequestHeaders> = {}): McpRequestHeaders {
  return { protocolVersion: MCP_PROTOCOL_VERSION, method, ...(name === undefined ? {} : { name }), ...overrides }
}

function modernCall(
  method: string,
  params: Record<string, unknown> = {},
  options: { headers?: Partial<McpRequestHeaders>, id?: number | null, omitId?: boolean, tools?: McpTool[] } = {},
) {
  const body = modernBody(method, params, options.id)
  if (options.omitId === true) {
    delete body.id
  }
  return handleMcpRequest({
    body,
    headers: modernHeaders(method, typeof params.name === 'string' ? params.name : undefined, options.headers),
    tools: options.tools ?? FAKE_TOOLS,
  })
}

describe('server identity', () => {
  test('the advertised version stays in lockstep with package.json', async () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(MCP_SERVER_VERSION).toBe(pkg.version)
    expect(MCP_SERVER_NAME).toBe('openspecsight')
  })
})

describe('era detection by request shape', () => {
  test('a valid modern request is detected via params._meta alone (header mirrors it)', async () => {
    const response = await modernCall('server/discover')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ result: { resultType: 'complete' } })
  })

  test('a valid modern request is detected via the header alone (no params._meta)', async () => {
    const response = await handleMcpRequest({
      body: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      headers: { protocolVersion: MCP_PROTOCOL_VERSION, method: 'tools/list' },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ result: { ttlMs: TOOLS_TTL_MS } })
  })

  test('no version marker anywhere means legacy (initialize answers, discover does not exist)', async () => {
    const initialized = await legacyCall({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(initialized.status).toBe(200)
    expect(initialized.body).toMatchObject({ result: { protocolVersion: '2025-06-18' } })

    const discovered = await legacyCall({ jsonrpc: '2.0', id: 2, method: 'server/discover' })
    expect(discovered.body).toMatchObject({ error: { code: -32601 } })
  })

  test('legacy requests are not header-validated: a mismatching Mcp-Method header is ignored', async () => {
    const response = await handleMcpRequest({
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      headers: { method: 'tools/call' },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })
})

describe('modern header validation (-32020)', () => {
  test('params._meta version without the MCP-Protocol-Version header is rejected', async () => {
    const response = await handleMcpRequest({
      body: modernBody('tools/list'),
      headers: { method: 'tools/list' },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32020 } })
  })

  test('header version disagreeing with params._meta is rejected', async () => {
    const response = await modernCall('tools/list', {}, { headers: { protocolVersion: '2025-06-18' } })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32020 } })
  })

  test('a missing Mcp-Method header is rejected', async () => {
    const response = await handleMcpRequest({
      body: modernBody('tools/list'),
      headers: { protocolVersion: MCP_PROTOCOL_VERSION },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32020 } })
  })

  test('an Mcp-Method header disagreeing with the body method is rejected', async () => {
    const response = await modernCall('tools/list', {}, { headers: { method: 'server/discover' } })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32020 } })
  })

  test('tools/call without the Mcp-Name header is rejected', async () => {
    const response = await handleMcpRequest({
      body: modernBody('tools/call', { name: 'echo', arguments: {} }),
      headers: { protocolVersion: MCP_PROTOCOL_VERSION, method: 'tools/call' },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32020 } })
  })

  test('an Mcp-Name header disagreeing with params.name is rejected', async () => {
    const response = await modernCall('tools/call', { name: 'echo', arguments: {} }, { headers: { name: 'boom' } })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32020 } })
  })

  test('methods without a name need no Mcp-Name header (tools/list passes without one)', async () => {
    const response = await modernCall('tools/list')
    expect(response.status).toBe(200)
  })

  test('header mismatch outranks the version gate: a supported _meta version with a foreign header is -32020', async () => {
    const response = await handleMcpRequest({
      body: modernBody('tools/list'),
      headers: { protocolVersion: '1900-01-01', method: 'tools/list' },
      tools: FAKE_TOOLS,
    })
    expect(response.body).toMatchObject({ error: { code: -32020 } })
  })

  test('the version gate outranks Mcp-Method checks: an unsupported version reports -32022 first', async () => {
    const response = await handleMcpRequest({
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '1900-01-01' } } },
      headers: { protocolVersion: '1900-01-01' },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32022 } })
  })
})

describe('protocol version gate (-32022)', () => {
  test('an unsupported version in headers and _meta is rejected with the pinned data shape', async () => {
    const response = await handleMcpRequest({
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '1900-01-01' } } },
      headers: { protocolVersion: '1900-01-01', method: 'tools/list' },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32022,
        data: { supported: ['2026-07-28'], requested: '1900-01-01' },
      },
    })
  })

  test('a header-only modern request with an unsupported version carries the header value as requested', async () => {
    const response = await handleMcpRequest({
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { protocolVersion: '2025-06-18', method: 'tools/list' },
      tools: FAKE_TOOLS,
    })
    expect(response.body).toMatchObject({ error: { code: -32022, data: { requested: '2025-06-18' } } })
  })

  test('the only supported version is 2026-07-28', async () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28')
  })
})

describe('server/discover (modern only)', () => {
  test('answers the pinned DiscoverResult shape with serverInfo in _meta', async () => {
    const response = await modernCall('server/discover')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        ttlMs: TOOLS_TTL_MS,
        cacheScope: TOOLS_CACHE_SCOPE,
        _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO },
      },
    })
  })
})

describe('tools/list', () => {
  test('modern result carries ttlMs, cacheScope, serverInfo _meta and alphabetical tools', async () => {
    const response = await modernCall('tools/list')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resultType: 'complete',
        tools: [
          { name: 'boom', title: 'Boom', description: 'Always fails with an error.', inputSchema: { type: 'object' } },
          { name: 'echo', title: 'Echo', description: 'Returns the arguments it received.', inputSchema: { type: 'object' } },
          { name: 'zeta-count', title: 'Zeta count', description: 'Returns a structured object result.', inputSchema: { type: 'object' } },
        ],
        ttlMs: TOOLS_TTL_MS,
        cacheScope: TOOLS_CACHE_SCOPE,
        _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO },
      },
    })
  })

  test('tool definitions never leak the handler', async () => {
    const response = await modernCall('tools/list')
    const result = (response.body as { result: { tools: Array<Record<string, unknown>> } }).result
    for (const tool of result.tools) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name', 'title'])
    }
  })

  test('legacy tools/list answers only the sorted tools array', async () => {
    const response = await legacyCall({ jsonrpc: '2.0', id: 5, method: 'tools/list' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: {
        tools: [
          expect.objectContaining({ name: 'boom' }),
          expect.objectContaining({ name: 'echo' }),
          expect.objectContaining({ name: 'zeta-count' }),
        ],
      },
    })
  })
})

describe('tools/call', () => {
  test('modern success wraps the handler result as text content with serverInfo _meta', async () => {
    const response = await modernCall('tools/call', { name: 'echo', arguments: { project: 'os' } })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: JSON.stringify({ project: 'os' }, null, 2) }],
        _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO },
      },
    })
  })

  test('a string handler result is passed through verbatim, object results are pretty JSON', async () => {
    const stringResponse = await modernCall('tools/call', { name: 'shout' }, {
      tools: [{
        name: 'shout',
        title: 'Shout',
        description: 'Returns a fixed string.',
        inputSchema: { type: 'object' },
        handler: async () => 'plain text',
      }],
    })
    expect(stringResponse.body).toMatchObject({ result: { content: [{ type: 'text', text: 'plain text' }] } })

    const objectResponse = await modernCall('tools/call', { name: 'zeta-count' })
    expect(objectResponse.body).toMatchObject({ result: { content: [{ type: 'text', text: '{\n  "scenarioCount": 3\n}' }] } })
  })

  test('a handler failure is a tool error (isError with helpful text), never a transport error', async () => {
    const response = await modernCall('tools/call', { name: 'boom' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: "Tool 'boom' failed: kaput" }],
        isError: true,
        _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO },
      },
    })
  })

  test('an unknown tool name is invalid params (-32602) in both eras', async () => {
    const modern = await modernCall('tools/call', { name: 'nope', arguments: {} })
    expect(modern.status).toBe(200)
    expect(modern.body).toMatchObject({ error: { code: -32602 } })

    const legacy = await legacyCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })
    expect(legacy.status).toBe(200)
    expect(legacy.body).toMatchObject({ error: { code: -32602 } })
  })

  test('non-object arguments are invalid params, missing arguments become an empty object', async () => {
    const badArgs = await modernCall('tools/call', { name: 'echo', arguments: 'nope' })
    expect(badArgs.body).toMatchObject({ error: { code: -32602 } })

    const noArgs = await modernCall('tools/call', { name: 'echo' })
    expect(noArgs.status).toBe(200)
    expect(noArgs.body).toMatchObject({ result: { content: [{ type: 'text', text: '{}' }] } })
  })

  test('legacy success has no resultType and no _meta', async () => {
    const response = await legacyCall({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }] },
    })
  })

  test('legacy handler failure still answers isError on HTTP 200', async () => {
    const response = await legacyCall({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'boom' } })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: "Tool 'boom' failed: kaput" }] } })
  })
})

describe('unknown methods per era', () => {
  test('modern unknown method is 404 with -32601', async () => {
    const response = await modernCall('resources/list')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32601 } })
  })

  test('modern initialize is an unknown method (initialize belongs to the legacy era)', async () => {
    const response = await modernCall('initialize')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ error: { code: -32601 } })
  })

  test('legacy unknown method is -32601 on HTTP 200', async () => {
    const response = await legacyCall({ jsonrpc: '2.0', id: 9, method: 'resources/list' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32601 } })
  })

  test('modern ping is an unknown method (ping was removed in 2026-07-28)', async () => {
    const response = await modernCall('ping')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ error: { code: -32601 } })
  })

  test('legacy ping answers an empty result', async () => {
    const response = await legacyCall({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(response.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  test('legacy initialize answers the pinned legacy handshake shape', async () => {
    const response = await legacyCall({ jsonrpc: '2.0', id: 4, method: 'initialize' })
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    })
  })
})

describe('notifications (no id)', () => {
  test('a valid modern notification answers 202 with no body', async () => {
    const response = await modernCall('tools/list', {}, { omitId: true })
    expect(response.status).toBe(202)
    expect(response.body).toBeUndefined()
  })

  test('a legacy notification answers 202 with no body', async () => {
    const response = await legacyCall({ jsonrpc: '2.0', method: 'ping' })
    expect(response.status).toBe(202)
    expect(response.body).toBeUndefined()
  })

  test('an unknown-method notification is still 202: notifications never get a response', async () => {
    const response = await modernCall('resources/subscribe', { uri: 'file:///x' }, { omitId: true })
    expect(response.status).toBe(202)
    expect(response.body).toBeUndefined()
  })

  test('transport-level rejections still apply to notifications (bad version is -32022, not 202)', async () => {
    const response = await handleMcpRequest({
      body: { jsonrpc: '2.0', method: 'tools/list', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '1900-01-01' } } },
      headers: { protocolVersion: '1900-01-01', method: 'tools/list' },
      tools: FAKE_TOOLS,
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: -32022 } })
  })
})

describe('parse and envelope errors', () => {
  test('malformed JSON is -32700 with null id on HTTP 200 (pinned transport pick)', async () => {
    const response = await legacyCall('{not json')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })
  })

  test('an empty body is a parse error too', async () => {
    const response = await legacyCall(undefined)
    expect(response.body).toMatchObject({ error: { code: -32700 } })
  })

  test('a body that is not a JSON-RPC request object is -32600', async () => {
    for (const body of [42, '"just a string"', [], null, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }]) {
      const response = await legacyCall(body)
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ error: { code: -32600 } })
    }
  })

  test('a non-string method or positional params array is -32600', async () => {
    expect((await legacyCall({ jsonrpc: '2.0', id: 1, method: 42 })).body).toMatchObject({ error: { code: -32600 } })
    expect((await legacyCall({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1] })).body).toMatchObject({ error: { code: -32600 } })
  })

  test('an id of a forbidden type is -32600; a null id is still a request answered with null', async () => {
    expect((await legacyCall({ jsonrpc: '2.0', id: { deep: true }, method: 'ping' })).body).toMatchObject({ error: { code: -32600 } })
    expect((await legacyCall({ jsonrpc: '2.0', id: null, method: 'ping' })).body).toEqual({ jsonrpc: '2.0', id: null, result: {} })
  })
})

describe('response envelopes are valid JSON-RPC 2.0', () => {
  test('success and error envelopes echo the request id and declare jsonrpc 2.0', async () => {
    const success = await modernCall('tools/list', {}, { id: 'abc' })
    expect(success.body).toMatchObject({ jsonrpc: '2.0', id: 'abc' })

    const failure = await modernCall('resources/list', {}, { id: 'abc' })
    expect(failure.body).toMatchObject({ jsonrpc: '2.0', id: 'abc', error: { code: -32601 } })
    expect('result' in (failure.body as object)).toBe(false)
    expect('error' in (success.body as object)).toBe(false)
  })
})

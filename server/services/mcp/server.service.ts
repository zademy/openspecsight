import {
  INVALID_PARAMS,
  LEGACY_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  TOOLS_CACHE_SCOPE,
  TOOLS_TTL_MS,
  isModernEra,
  jsonRpcError,
  jsonRpcResult,
  parseEnvelope,
  serverInfoMeta,
  textContent,
  validateModernHeaders,
  type McpRequestInput,
  type McpResponse,
  type McpTool,
  type ParsedRequest,
} from './protocol'

/**
 * Method routing for the dual-era MCP endpoint. The protocol rules (era
 * detection, header validation, envelopes) live in protocol.ts; this module
 * dispatches a validated JSON-RPC request to the modern or legacy method
 * table and adapts tool handlers into CallToolResults. Pure TypeScript, no
 * Nitro imports: the route feeds it the raw body and headers, it answers
 * with an HTTP status and a JSON-RPC envelope.
 */

/**
 * Handles one JSON-RPC POST against /mcp. Async because tool handlers are
 * async (McpTool pins Promise<unknown>); the route awaits it. Notifications
 * (requests without an id) answer 202 with no body; transport rejections
 * (-32020/-32022) are checked before the notification short-circuit,
 * everything after it never produces a response for a notification.
 */
export async function handleMcpRequest(input: McpRequestInput): Promise<McpResponse> {
  const parsed = parseEnvelope(input.body)
  if (!parsed.ok) {
    return parsed.response
  }
  const request = parsed.request

  if (isModernEra(request, input.headers)) {
    const rejection = validateModernHeaders(request, input.headers)
    if (rejection !== null) {
      return rejection
    }
    if (!request.hasId) {
      return { status: 202 }
    }
    return routeModern(request, input.tools)
  }

  if (!request.hasId) {
    return { status: 202 }
  }
  return routeLegacy(request, input.tools)
}

function toolDefinition(tool: McpTool): Record<string, unknown> {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema }
}

function sortedTools(tools: McpTool[]): McpTool[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name))
}

function modernUnknownMethod(request: ParsedRequest): McpResponse {
  return jsonRpcError(request.id, METHOD_NOT_FOUND, 'Method not found', undefined, 404)
}

async function routeModern(request: ParsedRequest, tools: McpTool[]): Promise<McpResponse> {
  switch (request.method) {
    case 'server/discover':
      return jsonRpcResult(request.id, {
        // DiscoverResult fields pinned verbatim from the 2026-07-28 schema.
        resultType: 'complete',
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        ttlMs: TOOLS_TTL_MS,
        cacheScope: TOOLS_CACHE_SCOPE,
        _meta: serverInfoMeta(),
      })
    case 'tools/list':
      return jsonRpcResult(request.id, {
        resultType: 'complete',
        tools: sortedTools(tools).map(toolDefinition),
        ttlMs: TOOLS_TTL_MS,
        cacheScope: TOOLS_CACHE_SCOPE,
        _meta: serverInfoMeta(),
      })
    case 'tools/call':
      return callTool(request, tools, true)
    default:
      // ping was removed in 2026-07-28, so it lands here too.
      return modernUnknownMethod(request)
  }
}

async function routeLegacy(request: ParsedRequest, tools: McpTool[]): Promise<McpResponse> {
  switch (request.method) {
    case 'initialize':
      return jsonRpcResult(request.id, {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      })
    case 'tools/list':
      return jsonRpcResult(request.id, { tools: sortedTools(tools).map(toolDefinition) })
    case 'tools/call':
      return callTool(request, tools, false)
    case 'ping':
      return jsonRpcResult(request.id, {})
    default:
      return jsonRpcError(request.id, METHOD_NOT_FOUND, 'Method not found')
  }
}

/**
 * Runs one tool. Unknown tool names and unusable arguments are protocol
 * errors (-32602 Invalid params, pinned); everything the handler itself
 * raises is a tool result with isError: true and a helpful text, never a
 * transport error.
 */
async function callTool(request: ParsedRequest, tools: McpTool[], modern: boolean): Promise<McpResponse> {
  const name = typeof request.params.name === 'string' ? request.params.name : undefined
  if (name === undefined) {
    return jsonRpcError(request.id, INVALID_PARAMS, 'Invalid params: tools/call requires a tool name')
  }

  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) {
    return jsonRpcError(request.id, INVALID_PARAMS, `Invalid params: unknown tool '${name}'`)
  }

  const args = request.params.arguments ?? {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    return jsonRpcError(request.id, INVALID_PARAMS, 'Invalid params: arguments must be an object')
  }

  let text: string
  let failed = false
  try {
    const result = await tool.handler(args as Record<string, unknown>)
    text = typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2)
  } catch (cause) {
    failed = true
    const message = cause instanceof Error ? cause.message : String(cause)
    text = `Tool '${name}' failed: ${message}`
  }

  const result: Record<string, unknown> = modern ? { resultType: 'complete' } : {}
  result.content = textContent(text)
  if (failed) {
    result.isError = true
  }
  if (modern) {
    result._meta = serverInfoMeta()
  }
  return jsonRpcResult(request.id, result)
}

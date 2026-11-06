/**
 * Dual-era MCP protocol core: JSON-RPC 2.0 envelopes, error codes, and the
 * era + header validation rules for the two protocol generations the server
 * speaks: modern (2026-07-28, per-request `_meta` metadata) and legacy
 * (initialize handshake, 2025-06-18). Everything here is pure TypeScript
 * with no h3/Nitro imports so the whole matrix stays unit-testable; the
 * route in server/routes/mcp.post.ts is a thin adapter around it.
 *
 * Protocol facts are pinned from the 2026-07-28 spec (fetched 2026-11-06)
 * in docs/superpowers/specs/2026-11-06-mcp-api-keys-design.md section 5.
 */

/** The only modern protocol version this server accepts. */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION]

/** Version answered by the legacy initialize handshake. */
export const LEGACY_PROTOCOL_VERSION = '2025-06-18'

/** Server identity advertised on every modern result and in initialize. */
export const MCP_SERVER_NAME = 'openspecsight'

/**
 * Kept in lockstep with package.json (a unit test reads both). A constant
 * rather than a runtime read so the server bundle never depends on where
 * package.json ends up after a Nitro build.
 */
export const MCP_SERVER_VERSION = '0.0.0'

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo'

/** tools/list hint: clients may cache the list for a minute (private data). */
export const TOOLS_TTL_MS = 60000
export const TOOLS_CACHE_SCOPE = 'private'

// Reserved JSON-RPC codes plus the MCP extension codes.
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
/** Header missing or disagreeing with the body it must mirror. */
export const HEADER_MISMATCH = -32020
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

export type JsonRpcId = string | number | null

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

/** The MCP headers the route extracts from the HTTP request. */
export interface McpRequestHeaders {
  protocolVersion?: string
  method?: string
  name?: string
}

export interface McpRequestInput {
  /** Raw body as read by the route; strings are parsed here. */
  body: unknown
  headers: McpRequestHeaders
  tools: McpTool[]
}

export interface McpResponse {
  /** HTTP status for the transport. */
  status: number
  /** JSON-RPC envelope, or absent for notifications (empty body). */
  body?: Record<string, unknown>
}

/** A request whose JSON-RPC envelope was valid. */
export interface ParsedRequest {
  id: JsonRpcId
  hasId: boolean
  method: string
  params: Record<string, unknown>
}

type ParseOutcome =
  | { ok: true, request: ParsedRequest }
  | { ok: false, response: McpResponse }

export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: Record<string, unknown>
}

export function jsonRpcResult(id: JsonRpcId, result: Record<string, unknown>): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } }
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
  status = 200,
): McpResponse {
  const error: JsonRpcErrorBody = { code, message }
  if (data !== undefined) {
    error.data = data
  }
  return { status, body: { jsonrpc: '2.0', id, error } }
}

/**
 * Parses the body into a request, or builds the -32700/-32600 response. A
 * string body is raw text (what the route hands over) and is parsed once;
 * any other value is taken as already-parsed JSON.
 */
export function parseEnvelope(body: unknown): ParseOutcome {
  let value = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, response: jsonRpcError(null, PARSE_ERROR, 'Parse error') }
    }
  }

  // An empty body (rawBody undefined) is nothing to parse: a parse error.
  if (value === undefined) {
    return { ok: false, response: jsonRpcError(null, PARSE_ERROR, 'Parse error') }
  }
  // Valid JSON that is not a request object (null, scalars, arrays).
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, response: jsonRpcError(null, INVALID_REQUEST, 'Invalid Request') }
  }

  const raw = value as Record<string, unknown>
  if (raw.jsonrpc !== '2.0') {
    return { ok: false, response: jsonRpcError(null, INVALID_REQUEST, 'Invalid Request') }
  }
  if (typeof raw.method !== 'string' || raw.method.length === 0) {
    return { ok: false, response: jsonRpcError(null, INVALID_REQUEST, 'Invalid Request') }
  }

  let id: unknown
  let hasId = false
  if ('id' in raw) {
    hasId = true
    id = raw.id
    if (typeof id !== 'string' && typeof id !== 'number' && id !== null) {
      return { ok: false, response: jsonRpcError(null, INVALID_REQUEST, 'Invalid Request') }
    }
  }

  if (raw.params !== undefined && (typeof raw.params !== 'object' || raw.params === null || Array.isArray(raw.params))) {
    return { ok: false, response: jsonRpcError(null, INVALID_REQUEST, 'Invalid Request') }
  }

  return {
    ok: true,
    request: {
      id: hasId ? (id as JsonRpcId) : null,
      hasId,
      method: raw.method,
      params: (raw.params ?? {}) as Record<string, unknown>,
    },
  }
}

/** The protocol version a modern request declares in params._meta, if any. */
function metaProtocolVersion(params: Record<string, unknown>): string | undefined {
  const meta = params._meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return undefined
  }
  const value = (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Era detection is by request shape, not by endpoint or client: a version
 * marker in params._meta OR the MCP-Protocol-Version header means modern;
 * anything else is a legacy client speaking the initialize handshake.
 */
export function isModernEra(request: ParsedRequest, headers: McpRequestHeaders): boolean {
  return headerValue(headers.protocolVersion) !== undefined || metaProtocolVersion(request.params) !== undefined
}

/**
 * An empty header value is treated as absent; h3 hands empty headers through
 * as '' and a blank header carries no version.
 */
function headerValue(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * Modern header validation, in pinned precedence:
 * 1. the protocol version header must be present and agree with _meta
 *    (identity: which spec governs this request),
 * 2. the agreed version must be supported (-32022, data copied verbatim
 *    from the spec's UnsupportedProtocolVersionError),
 * 3. Mcp-Method must be present and match the body method, and Mcp-Name
 *    must be present and match params.name when the method carries one.
 * Every failure is HTTP 400 with -32020 HeaderMismatch except step 2.
 */
export function validateModernHeaders(request: ParsedRequest, headers: McpRequestHeaders): McpResponse | null {
  const headerVersion = headerValue(headers.protocolVersion)
  const metaVersion = metaProtocolVersion(request.params)

  if (headerVersion === undefined) {
    return jsonRpcError(request.id, HEADER_MISMATCH, 'Missing MCP-Protocol-Version header', undefined, 400)
  }
  if (metaVersion !== undefined && headerVersion !== metaVersion) {
    return jsonRpcError(request.id, HEADER_MISMATCH, 'MCP-Protocol-Version header does not match the version in params._meta', undefined, 400)
  }

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion)) {
    // data shape pinned from the spec's UnsupportedProtocolVersionError.
    return jsonRpcError(request.id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: headerVersion }, 400)
  }

  const headerMethod = headerValue(headers.method)
  if (headerMethod === undefined) {
    return jsonRpcError(request.id, HEADER_MISMATCH, 'Missing Mcp-Method header', undefined, 400)
  }
  if (headerMethod !== request.method) {
    return jsonRpcError(request.id, HEADER_MISMATCH, 'Mcp-Method header does not match the request method', undefined, 400)
  }

  const bodyName = typeof request.params.name === 'string' ? request.params.name : undefined
  if (bodyName !== undefined) {
    const headerName = headerValue(headers.name)
    if (headerName === undefined) {
      return jsonRpcError(request.id, HEADER_MISMATCH, 'Missing Mcp-Name header', undefined, 400)
    }
    if (headerName !== bodyName) {
      return jsonRpcError(request.id, HEADER_MISMATCH, 'Mcp-Name header does not match params.name', undefined, 400)
    }
  }

  return null
}

export function serverInfoMeta(): Record<string, unknown> {
  return { [SERVER_INFO_META_KEY]: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } }
}

export function textContent(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}

import { extractBearerKey } from '../utils/apiAccess'
import { SESSION_COOKIE_NAME, verifySessionToken } from '../utils/session'
import { getDB } from '../db/client'
import { verifyApiKey } from '../services/keys.service'
import { buildMcpTools } from '../services/mcp/tools'
import { handleMcpRequest } from '../services/mcp/server.service'
import type { McpRequestHeaders } from '../services/mcp/protocol'

/**
 * The MCP endpoint (POST /mcp), outside /api/ so the auth middleware's
 * bearer gate does not apply; the middleware exempts /mcp because this
 * route authenticates itself: an operator session or a valid bearer API
 * key (which stamps lastUsedAt via verifyApiKey), 401 otherwise. Auth runs
 * BEFORE any protocol handling, so unauthenticated callers learn nothing
 * about the protocol core.
 *
 * The raw body is passed to handleMcpRequest unparsed because malformed
 * JSON is a JSON-RPC -32700 response, not a transport error. Responses map
 * from the core's status; a 202 (notification) carries an empty body.
 */

// The six read-only spec tools (server/services/mcp/tools.ts). All
// read-only; auth above already stamped lastUsedAt for key callers.
const MCP_TOOLS = buildMcpTools()

function headerOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value
}

export default defineEventHandler(async (event) => {
  // Session first, mirroring the /api/ gate: a valid session wins and any
  // Authorization header is ignored.
  if (!verifySessionToken(getCookie(event, SESSION_COOKIE_NAME))) {
    const bearerKey = extractBearerKey(getHeader(event, 'authorization'))
    if (bearerKey === null || verifyApiKey(getDB(), bearerKey) === null) {
      setResponseStatus(event, 401)
      return { error: 'MCP requires an operator session or a valid bearer API key.' }
    }
  }

  const rawBody = await readRawBody(event, 'utf8')
  const headers: McpRequestHeaders = {
    protocolVersion: headerOrUndefined(getHeader(event, 'mcp-protocol-version')),
    method: headerOrUndefined(getHeader(event, 'mcp-method')),
    name: headerOrUndefined(getHeader(event, 'mcp-name')),
  }

  const response = await handleMcpRequest({ body: rawBody, headers, tools: MCP_TOOLS })
  setResponseStatus(event, response.status)
  if (response.body === undefined) {
    // Notifications answer 202 with no body.
    return send(event, '')
  }
  return response.body
})

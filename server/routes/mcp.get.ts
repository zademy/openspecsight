/**
 * /mcp speaks JSON-RPC over POST only. A GET here is a client mistake, so
 * it answers 405 with the Allow header and a pointer to the README instead
 * of a protocol error.
 */
export default defineEventHandler((event) => {
  setHeader(event, 'Allow', 'POST')
  setResponseStatus(event, 405)
  return { error: 'The MCP endpoint accepts POST requests only; see the MCP section in the README.' }
})

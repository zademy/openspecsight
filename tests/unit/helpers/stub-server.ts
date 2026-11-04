import { readFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import path from 'node:path'

/**
 * Ephemeral HTTP stub for github.service unit tests: plain `node:http`,
 * answering JSON routes backed by `fixtures/github/*.json`.
 *
 * Every `startStubServer()` call returns an independent instance listening on
 * a random port, so vitest workers never collide with each other or with the
 * fixed-port e2e stub in `tests/helpers/github-stub.ts`.
 */

/** Response a route produces. Unset fields get sensible defaults. */
export interface StubResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/**
 * A single stub route, matched in registration order, first match wins.
 * Either serve a fixture file (`fixture`) or produce the response dynamically
 * (`handler`, which wins when both are set).
 */
export interface StubRoute {
  /** HTTP method; omit to match any method. */
  method?: string
  /** Exact path or regex matched against the request pathname. */
  pattern: string | RegExp
  /** Fixture file name under `fixtures/github/` to serve as the JSON body. */
  fixture?: string
  /** Status for the fixture shorthand; defaults to 200. */
  status?: number
  handler?: (req: IncomingMessage) => StubResponse | Promise<StubResponse>
}

/** One received request, recorded in arrival order for assertions. */
export interface CapturedRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: IncomingHttpHeaders
}

export interface StubServer {
  baseUrl: string
  port: number
  /** Requests received so far, oldest first. */
  requests: CapturedRequest[]
  /** Register additional routes; callable before or while running. */
  route(...routes: StubRoute[]): void
  /** Stop the server. Safe to call once. */
  stop(): Promise<void>
}

const FIXTURES_DIR = path.resolve(process.cwd(), 'fixtures/github')

/** Start a fresh stub on 127.0.0.1 with a random port. */
export async function startStubServer(): Promise<StubServer> {
  const routes: StubRoute[] = []
  const requests: CapturedRequest[] = []

  const server = createServer((req, res) => {
    void respond(req, res, routes, requests)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    await close(server)
    throw new Error('stub server did not report a port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    route(...added) {
      routes.push(...added)
    },
    stop: () => close(server),
  }
}

async function respond(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  routes: StubRoute[],
  requests: CapturedRequest[],
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  // Octokit percent-encodes path segments like `base...head`; match and record
  // the decoded form so route patterns stay readable.
  let pathname = url.pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // Keep the raw path when it holds an invalid escape sequence.
  }
  requests.push({
    method: req.method ?? 'GET',
    path: pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
  })
  await drainBody(req)

  let status = 404
  let body: unknown = { message: 'Not Found' }

  try {
    const route = routes.find((candidate) => matches(candidate, req.method ?? 'GET', pathname))
    if (route?.handler) {
      const response = await route.handler(req)
      status = response.status ?? 200
      body = response.body ?? {}
      for (const [name, value] of Object.entries(response.headers ?? {})) {
        res.setHeader(name, value)
      }
    } else if (route?.fixture) {
      status = route.status ?? 200
      body = JSON.parse(await readFile(path.join(FIXTURES_DIR, route.fixture), 'utf8'))
    }
  } catch (error) {
    // A failing handler must answer 500 JSON instead of escaping as an
    // unhandled rejection, which would crash the test-runner process.
    status = 500
    body = { message: 'stub error', error: String(error) }
  }

  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function matches(route: StubRoute, method: string, pathname: string): boolean {
  if (route.method !== undefined && route.method !== method) {
    return false
  }
  return typeof route.pattern === 'string' ? route.pattern === pathname : route.pattern.test(pathname)
}

/** Drain the request body so keep-alive sockets stay consistent. */
function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.resume()
    req.on('end', resolve)
    req.on('error', resolve)
  })
}

function close(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

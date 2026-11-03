import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * Minimal fixture-driven stub of the GitHub REST API for local e2e runs.
 *
 * It listens on a fixed port bound to loopback and answers every unmatched
 * request with GitHub's 404 JSON shape. Later tasks register fixture-backed
 * routes via `registerGithubRoutes` so tests can exercise real flows.
 */

/** Response a route handler may produce. Unset fields get sensible defaults. */
export interface GithubStubResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** A single stub route. Routes are matched in registration order, first match wins. */
export interface GithubStubRoute {
  /** HTTP method; omit to match any method. */
  method?: string
  /** Exact path or regex matched against the request pathname. */
  pattern: string | RegExp
  handler: (req: IncomingMessage) => GithubStubResponse | Promise<GithubStubResponse>
}

export interface GithubStubHandle {
  host: string
  port: number
  baseUrl: string
}

const HOST = '127.0.0.1'
const PORT = 9876

let server: Server | null = null
const routes: GithubStubRoute[] = []

/** Register additional routes on the stub. Call before or while it is running. */
export function registerGithubRoutes(...newRoutes: GithubStubRoute[]): void {
  routes.push(...newRoutes)
}

/** Clear all registered routes so only the default 404 behavior remains. */
export function resetGithubRoutes(): void {
  routes.length = 0
}

function matchRoute(method: string, pathname: string): GithubStubRoute | undefined {
  return routes.find((route) => {
    if (route.method !== undefined && route.method !== method) {
      return false
    }
    if (typeof route.pattern === 'string') {
      return route.pattern === pathname
    }
    return route.pattern.test(pathname)
  })
}

/** Drain the request body so keep-alive sockets stay consistent. */
function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.resume()
    req.on('end', resolve)
    req.on('error', resolve)
  })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await drainBody(req)

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const route = matchRoute(req.method ?? 'GET', url.pathname)

  let status = 404
  let body: unknown = { message: 'Not Found' }
  let extraHeaders: Record<string, string> = {}

  if (route) {
    const response = await route.handler(req)
    status = response.status ?? 200
    body = response.body ?? {}
    extraHeaders = response.headers ?? {}
  }

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

/** Start the stub on 127.0.0.1:9876. Throws if it is already running. */
export function startGithubStub(): Promise<GithubStubHandle> {
  if (server) {
    return Promise.reject(new Error('GitHub stub is already running'))
  }

  const instance = createServer((req, res) => {
    void handleRequest(req, res)
  })

  return new Promise((resolve, reject) => {
    instance.once('error', reject)
    instance.listen(PORT, HOST, () => {
      server = instance
      resolve({ host: HOST, port: PORT, baseUrl: `http://${HOST}:${PORT}` })
    })
  })
}

/** Stop the stub and reset its route table. Safe to call when not running. */
export function stopGithubStub(): Promise<void> {
  const instance = server
  server = null
  routes.length = 0

  if (!instance) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    instance.closeAllConnections()
    instance.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

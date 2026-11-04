import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getDB } from '../db/client'
import { repositories } from '../db/schema'
import { kickJobProcessing, type JobTaskRunner } from './jobs.service'
import { SyncInProgressError, startSync } from './sync.service'

/**
 * The GitHub push webhook: verify the request's HMAC signature over the raw
 * body, then enqueue a sync for every project watching the pushed branch.
 * Nothing is enqueued unless the signature verifies — a rejected request
 * costs a 401 and no queue rows. The enqueue reuses the sync route's
 * startSync path, so the queued-or-running dedupe (SyncInProgressError)
 * applies here too: a push that lands mid-sync is covered, not double-run.
 */

/** Name of the env var holding the webhook secret; surfaced in errors and UI. */
export const WEBHOOK_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET'

/** 503: the operator has not configured a secret, so no request can verify. */
export class WebhookConfigError extends Error {
  constructor() {
    super(`${WEBHOOK_SECRET_ENV} is not set`)
    this.name = 'WebhookConfigError'
  }
}

/** 401: missing, malformed, or non-matching signature header. */
export class WebhookSignatureError extends Error {
  constructor() {
    super('The x-hub-signature-256 header does not match the payload')
    this.name = 'WebhookSignatureError'
  }
}

/** 400: valid signature but a body that is not JSON — GitHub retries; fine. */
export class WebhookPayloadError extends Error {
  constructor() {
    super('The webhook body is not valid JSON')
    this.name = 'WebhookPayloadError'
  }
}

/** The three 200 shapes: ping, an ignored event, and a push result. */
export type WebhookOutcome =
  | { ok: true }
  | { ok: true, ignored: true }
  | { ok: true, synced: number[] }

/** Whether the secret is set; the settings page renders this honestly. */
export function isWebhookSecretConfigured(): boolean {
  return Boolean(process.env[WEBHOOK_SECRET_ENV]?.trim())
}

/**
 * The webhook URL to paste into GitHub. Built from PUBLIC_APP_URL; when it is
 * not set the relative path is returned, which still works against whatever
 * host serves the app.
 */
export function buildWebhookUrl(): string {
  const base = (process.env.PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}/api/webhooks/github` : '/api/webhooks/github'
}

const SIGNATURE_PREFIX = 'sha256='

/**
 * Timing-safe HMAC-SHA256 check, the scheme GitHub documents as
 * `x-hub-signature-256: sha256=<hex>`. The length guard runs before
 * timingSafeEqual, which would throw on unequal buffer lengths.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith(SIGNATURE_PREFIX)) {
    return false
  }
  const expected = createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest()
  // Buffer.from truncates at the first invalid hex pair, so a malformed
  // header lands here as a short buffer and fails the length check.
  const given = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'hex')
  if (given.length !== expected.length) {
    return false
  }
  return timingSafeEqual(given, expected)
}

interface WebhookInput {
  /** The raw request body — signature verification happens over these bytes. */
  rawBody: string | null | undefined
  /** The `x-github-event` header value. */
  eventName: string | undefined
  /** The `x-hub-signature-256` header value. */
  signature: string | undefined
  /** The runner kickJobProcessing drains the queue with (nitro's runTask). */
  runTask: JobTaskRunner
}

/**
 * Handles one webhook request. Throws the typed errors the route maps to
 * 503/401/400; every accepted request answers 200. A push matches projects
 * through exact owner+repo+branch rows, enqueues one sync job per project and
 * kicks the queue once when anything was enqueued.
 */
export function handleGithubWebhook(input: WebhookInput): WebhookOutcome {
  const secret = process.env[WEBHOOK_SECRET_ENV]?.trim()
  if (!secret) {
    throw new WebhookConfigError()
  }
  // A missing body verifies as a missing signature: without raw bytes there
  // is nothing the header could legitimately sign.
  if (!input.rawBody || !verifyWebhookSignature(input.rawBody, input.signature, secret)) {
    throw new WebhookSignatureError()
  }

  let payload: { repository?: { full_name?: unknown }, ref?: unknown }
  try {
    payload = JSON.parse(input.rawBody) as typeof payload
  } catch {
    throw new WebhookPayloadError()
  }

  if (input.eventName === 'ping') {
    return { ok: true }
  }
  if (input.eventName !== 'push') {
    return { ok: true, ignored: true }
  }

  // Pull owner/repo/branch defensively: a validly-signed payload with
  // unexpected fields matches nothing and answers 200 with an empty list.
  const fullName = typeof payload.repository?.full_name === 'string' ? payload.repository.full_name : ''
  const slash = fullName.indexOf('/')
  const owner = slash > 0 ? fullName.slice(0, slash) : ''
  const repo = slash > 0 ? fullName.slice(slash + 1) : ''
  const branch = typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/')
    ? payload.ref.slice('refs/heads/'.length)
    : ''
  if (!owner || !repo || !branch) {
    return { ok: true, synced: [] }
  }

  const watched = getDB().select({ projectId: repositories.projectId })
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.repo, repo), eq(repositories.branch, branch)))
    .all()

  const synced: number[] = []
  for (const row of watched) {
    try {
      const jobId = startSync(row.projectId)
      if (jobId !== null) {
        synced.push(row.projectId)
      }
    } catch (error) {
      // Already queued or running: the in-flight sync covers this push.
      if (!(error instanceof SyncInProgressError)) {
        throw error
      }
    }
  }

  if (synced.length > 0) {
    kickJobProcessing(input.runTask)
  }
  return { ok: true, synced }
}

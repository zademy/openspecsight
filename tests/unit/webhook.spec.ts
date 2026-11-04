import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { analyses, jobs, projects, repositories } from '../../server/db/schema'
import { enqueueJob, type JobTaskRunner } from '../../server/services/jobs.service'
import {
  WEBHOOK_SECRET_ENV,
  WebhookConfigError,
  WebhookPayloadError,
  WebhookSignatureError,
  handleGithubWebhook,
  verifyWebhookSignature,
} from '../../server/services/webhook.service'

/**
 * Webhook tests run against a :memory: database seeded with projects and
 * watched repositories, signing push payloads with the same HMAC scheme the
 * route receives from GitHub. The spy under the kick is the point of several
 * cases: a rejected request must not enqueue anything at all.
 */

const SECRET = 'hook-unit-secret'

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

function pushBody(owner = 'acme', repo = 'tasks', ref = 'refs/heads/main'): string {
  return JSON.stringify({ repository: { full_name: `${owner}/${repo}` }, ref })
}

let kicks: string[] = []
const runTask: JobTaskRunner = async (name) => {
  kicks.push(name)
}

/** Seeds a project watching owner/repo@branch and returns its id. */
function insertWatchedProject(name: string, owner = 'acme', repo = 'tasks', branch = 'main'): number {
  const db = getDB()
  const project = db.insert(projects).values({
    name,
    description: `${name} project`,
    createdAt: '2026-11-04T00:00:00.000Z',
  }).returning().get()
  db.insert(repositories).values({
    projectId: project.id,
    owner,
    repo,
    branch,
    patEncrypted: null,
    lastSyncedSha: null,
  }).run()
  return project.id
}

function syncJobRows(): Array<{ id: number, payloadJson: string }> {
  return getDB().select({ id: jobs.id, payloadJson: jobs.payloadJson })
    .from(jobs)
    .where(eq(jobs.type, 'sync'))
    .all()
}

function syncJobCount(): number {
  return syncJobRows().length
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
  process.env[WEBHOOK_SECRET_ENV] = SECRET
  kicks = []
})

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET
})

describe('handleGithubWebhook', () => {
  test('a valid push for a watched repo and branch enqueues exactly one sync job and kicks once', async () => {
    const projectId = insertWatchedProject('Hook Fixture')
    const body = pushBody()

    const outcome = await handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: sign(body),
      runTask,
    })

    expect(outcome).toEqual({ ok: true, synced: [projectId] })
    expect(syncJobCount()).toBe(1)
    expect(JSON.parse(syncJobRows()[0].payloadJson)).toEqual({ projectId })
    // The queued analyses row exists so progress is visible immediately.
    const queued = getDB().select({ status: analyses.status })
      .from(analyses)
      .where(eq(analyses.type, 'sync'))
      .all()
    expect(queued).toEqual([{ status: 'queued' }])
    expect(kicks).toEqual(['jobs:run'])
  })

  test('a push for an unwatched branch answers an empty sync list with no job and no kick', async () => {
    insertWatchedProject('Hook Fixture')
    const body = pushBody('acme', 'tasks', 'refs/heads/develop')

    const outcome = await handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: sign(body),
      runTask,
    })

    expect(outcome).toEqual({ ok: true, synced: [] })
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('a wrong signature throws and enqueues nothing', () => {
    insertWatchedProject('Hook Fixture')
    const body = pushBody()

    expect(() => handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: sign(body, 'a-different-secret'),
      runTask,
    })).toThrow(WebhookSignatureError)
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('a missing signature header throws and enqueues nothing', () => {
    insertWatchedProject('Hook Fixture')
    const body = pushBody()

    expect(() => handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: undefined,
      runTask,
    })).toThrow(WebhookSignatureError)
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('an unset or empty secret throws the config error naming the env var', () => {
    insertWatchedProject('Hook Fixture')
    const body = pushBody()
    const call = (): unknown => {
      try {
        handleGithubWebhook({
          rawBody: body,
          eventName: 'push',
          signature: sign(body),
          runTask,
        })
        return null
      } catch (error) {
        return error
      } finally {
        process.env[WEBHOOK_SECRET_ENV] = SECRET
      }
    }

    process.env[WEBHOOK_SECRET_ENV] = ''
    const empty = call()
    delete process.env.GITHUB_WEBHOOK_SECRET
    const unset = call()

    expect(empty).toBeInstanceOf(WebhookConfigError)
    expect((empty as Error).message).toContain(WEBHOOK_SECRET_ENV)
    expect(unset).toBeInstanceOf(WebhookConfigError)
    expect((unset as Error).message).toContain(WEBHOOK_SECRET_ENV)
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('the ping event answers a bare ok without touching the queue', async () => {
    insertWatchedProject('Hook Fixture')

    const outcome = await handleGithubWebhook({
      rawBody: pushBody(),
      eventName: 'ping',
      signature: sign(pushBody()),
      runTask,
    })

    expect(outcome).toEqual({ ok: true })
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('a non-push event is ignored without touching the queue', async () => {
    insertWatchedProject('Hook Fixture')
    const body = JSON.stringify({ action: 'opened' })

    const outcome = await handleGithubWebhook({
      rawBody: body,
      eventName: 'issues',
      signature: sign(body),
      runTask,
    })

    expect(outcome).toEqual({ ok: true, ignored: true })
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('malformed JSON under a valid signature throws the payload error', () => {
    insertWatchedProject('Hook Fixture')
    const body = '{"repository": broken'

    expect(() => handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: sign(body),
      runTask,
    })).toThrow(WebhookPayloadError)
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('a push payload without repository or ref fields matches nothing', async () => {
    insertWatchedProject('Hook Fixture')
    const body = JSON.stringify({ zen: 'Design for failure.' })

    const outcome = await handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: sign(body),
      runTask,
    })

    expect(outcome).toEqual({ ok: true, synced: [] })
    expect(syncJobCount()).toBe(0)
    expect(kicks).toEqual([])
  })

  test('every project watching the repository gets its own sync job from one kick', async () => {
    const first = insertWatchedProject('First Fixture')
    const second = insertWatchedProject('Second Fixture')
    const body = pushBody()

    const outcome = await handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: sign(body),
      runTask,
    })

    expect(outcome).toEqual({ ok: true, synced: [first, second] })
    expect(syncJobCount()).toBe(2)
    expect(kicks).toEqual(['jobs:run'])
  })

  test('a project already syncing is skipped, not double-enqueued', async () => {
    const projectId = insertWatchedProject('Hook Fixture')
    enqueueJob('sync', { projectId })
    const body = pushBody()

    const outcome = await handleGithubWebhook({
      rawBody: body,
      eventName: 'push',
      signature: sign(body),
      runTask,
    })

    expect(outcome).toEqual({ ok: true, synced: [] })
    expect(syncJobCount()).toBe(1)
    expect(kicks).toEqual([])
  })
})

describe('verifyWebhookSignature', () => {
  const body = pushBody()

  test('accepts the exact digest of the body', () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true)
  })

  test('rejects a body that was tampered with after signing', () => {
    expect(verifyWebhookSignature(`${body} `, sign(body), SECRET)).toBe(false)
  })

  test('rejects a digest computed with a different secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'other'), SECRET)).toBe(false)
  })

  test('rejects headers without the sha256= prefix', () => {
    const bare = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
    expect(verifyWebhookSignature(body, bare, SECRET)).toBe(false)
    expect(verifyWebhookSignature(body, 'md5=deadbeef', SECRET)).toBe(false)
  })

  test('rejects malformed or wrong-length hex without throwing', () => {
    // timingSafeEqual throws on length mismatch; the length guard must catch
    // these first.
    expect(verifyWebhookSignature(body, 'sha256=abc', SECRET)).toBe(false)
    expect(verifyWebhookSignature(body, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false)
    expect(verifyWebhookSignature(body, 'sha256=', SECRET)).toBe(false)
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false)
  })
})

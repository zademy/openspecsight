import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import {
  analyses,
  annotations,
  featureFiles,
  features,
  projects,
  repositories,
  releases,
  scenarioRevisions,
  scenarios,
} from '../../server/db/schema'
import { GithubError, type GithubService, type GithubTreeEntry } from '../../server/services/github.service'
import {
  RepositoryNotFoundError,
  addRepository,
  createProject,
  deleteProject,
  getProjectDetail,
  listProjects,
} from '../../server/services/projects.service'
import { decryptSecret } from '../../server/utils/crypto'

/**
 * Project service tests run against a :memory: database and a fake github
 * service, so nothing here touches the network or the filesystem. The env is
 * read lazily by getDB()/encryptSecret(), so setting it per test is enough.
 */
beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  process.env.SESSION_SECRET = 'test-secret'
  resetDB()
})

/** Fake github service: `missing` answers 404 like GitHub would, others exist. */
function fakeGithub(throwOnGetRepo = false): GithubService {
  const unavailable = (): never => {
    throw new GithubError('not needed in this test', {})
  }
  const tree: GithubTreeEntry[] = []

  return {
    getRepo: async (owner, repo) => {
      if (throwOnGetRepo) {
        throw new GithubError(`GitHub fetch repository info for ${owner}/${repo} failed`, {})
      }
      if (repo === 'missing') {
        throw new GithubError(`GitHub fetch repository info for ${owner}/${repo} failed with HTTP 404: Not Found`, { status: 404 })
      }
      return { defaultBranch: 'main' }
    },
    getTree: async () => tree,
    getBlob: unavailable,
    compareCommits: unavailable,
    listCommits: async () => [],
  }
}

describe('createProject', () => {
  test('validates the repository and defaults the branch to the GitHub default', async () => {
    const created = await createProject(
      { name: 'Task Manager', description: 'Track the spec', owner: 'acme', repo: 'tasks' },
      fakeGithub(),
    )

    expect(created.repositories).toEqual([{ owner: 'acme', repo: 'tasks', branch: 'main' }])
    expect(listProjects()).toHaveLength(1)
    expect(listProjects()[0]?.name).toBe('Task Manager')
  })

  test('rejects an unknown repository and stores nothing', async () => {
    await expect(
      createProject({ name: 'Broken', description: '', owner: 'acme', repo: 'missing' }, fakeGithub()),
    ).rejects.toThrow(RepositoryNotFoundError)

    expect(listProjects()).toHaveLength(0)
  })

  test('an explicit branch wins, but the repository is still validated via GitHub', async () => {
    let getRepoCalls = 0
    const countingGithub: GithubService = {
      getRepo: async () => {
        getRepoCalls += 1
        return { defaultBranch: 'main' }
      },
      getTree: async () => [],
      getBlob: async () => {
        throw new GithubError('not needed in this test', {})
      },
      compareCommits: async () => {
        throw new GithubError('not needed in this test', {})
      },
      listCommits: async () => [],
    }

    const created = await createProject(
      { name: 'Pinned', description: '', owner: 'acme', repo: 'tasks', branch: 'develop' },
      countingGithub,
    )

    expect(getRepoCalls).toBe(1)
    expect(created.repositories[0]?.branch).toBe('develop')
  })

  test('an unknown repository is rejected even when a branch is supplied', async () => {
    await expect(
      createProject({ name: 'Broken', description: '', owner: 'acme', repo: 'missing', branch: 'develop' }, fakeGithub()),
    ).rejects.toThrow(RepositoryNotFoundError)

    expect(listProjects()).toHaveLength(0)
  })

  test('a supplied PAT is stored AES-256-GCM encrypted, never in plaintext', async () => {
    const created = await createProject(
      { name: 'Private', description: '', owner: 'acme', repo: 'tasks', pat: 'ghp_super-secret-token' },
      fakeGithub(),
    )

    const row = getDB().select().from(repositories).all().find((r) => r.projectId === created.id)

    expect(row?.patEncrypted).toMatch(/^v1:/)
    expect(row?.patEncrypted).not.toContain('ghp_super-secret-token')
    expect(decryptSecret(row?.patEncrypted ?? '')).toBe('ghp_super-secret-token')
  })

  test('without a PAT the column stays null', async () => {
    const created = await createProject({ name: 'Public', description: '', owner: 'acme', repo: 'tasks' }, fakeGithub())

    const row = getDB().select().from(repositories).all().find((r) => r.projectId === created.id)

    expect(row?.patEncrypted).toBeNull()
  })
})

describe('getProjectDetail', () => {
  test('returns repositories and a null analysis status before the first scan', async () => {
    const created = await createProject({ name: 'Task Manager', description: 'D', owner: 'acme', repo: 'tasks' }, fakeGithub())

    const detail = getProjectDetail(created.id)

    expect(detail?.name).toBe('Task Manager')
    expect(detail?.repositories).toEqual([{ owner: 'acme', repo: 'tasks', branch: 'main' }])
    expect(detail?.lastAnalysis).toBeNull()
  })

  test('surfaces the last analysis status when one exists', async () => {
    const created = await createProject({ name: 'Task Manager', description: 'D', owner: 'acme', repo: 'tasks' }, fakeGithub())
    const db = getDB()

    db.insert(analyses).values({
      projectId: created.id,
      type: 'initial',
      status: 'done',
      progress: 100,
      step: 'done',
      statsJson: '{}',
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }).run()

    expect(getProjectDetail(created.id)?.lastAnalysis).toMatchObject({ type: 'initial', status: 'done' })
  })

  test('returns null for an unknown id', () => {
    expect(getProjectDetail(999)).toBeNull()
  })
})

describe('addRepository', () => {
  test('appends a second repository to the project', async () => {
    const created = await createProject({ name: 'Multi', description: '', owner: 'acme', repo: 'tasks' }, fakeGithub())

    const detail = await addRepository(created.id, { owner: 'acme', repo: 'docs' }, fakeGithub())

    expect(detail?.repositories).toHaveLength(2)
    expect(detail?.repositories[1]).toEqual({ owner: 'acme', repo: 'docs', branch: 'main' })
  })

  test('returns null for an unknown project', async () => {
    await expect(addRepository(999, { owner: 'acme', repo: 'tasks' }, fakeGithub())).resolves.toBeNull()
  })

  test('rejects an unknown repository before writing anything', async () => {
    const created = await createProject({ name: 'Multi', description: '', owner: 'acme', repo: 'tasks' }, fakeGithub())

    await expect(addRepository(created.id, { owner: 'acme', repo: 'missing' }, fakeGithub()))
      .rejects.toThrow(RepositoryNotFoundError)
    expect(getProjectDetail(created.id)?.repositories).toHaveLength(1)
  })
})

describe('deleteProject', () => {
  test('deletes the project and cascades through every dependent table', async () => {
    const created = await createProject({ name: 'Doomed', description: '', owner: 'acme', repo: 'tasks' }, fakeGithub())
    const db = getDB()

    // Seed one row of every project-scoped table so the cascade has work to do.
    const feature = db.insert(features).values({
      projectId: created.id, name: 'Sync', description: '', sortOrder: 0, source: 'ai',
    }).returning().get()
    const scenario = db.insert(scenarios).values({
      featureId: feature.id, context: 'c', action: 'a', outcome: 'o', category: 'happy', code: 'HP-1', sortOrder: 0, source: 'ai',
    }).returning().get()
    db.insert(featureFiles).values({ featureId: feature.id, path: 'src/a.ts' }).run()
    const repository = db.select().from(repositories).all().find((r) => r.projectId === created.id)
    const release = db.insert(releases).values({
      projectId: created.id, repositoryId: repository?.id ?? 0, sha: 'abc', title: 't', category: 'feature',
      highlight: 0, summary: 's', authorsJson: '[]', message: 'm', committedAt: new Date().toISOString(),
    }).returning().get()
    db.insert(scenarioRevisions).values({
      releaseId: release.id, scenarioId: scenario.id, featureId: feature.id, kind: 'new', state: 'applied',
    }).run()
    db.insert(annotations).values({ scenarioId: scenario.id, body: 'note', author: 'operator', createdAt: new Date().toISOString() }).run()
    db.insert(analyses).values({
      projectId: created.id, type: 'initial', status: 'done', progress: 100, step: 'done', statsJson: '{}',
      error: null, createdAt: new Date().toISOString(), finishedAt: null,
    }).run()

    expect(deleteProject(created.id)).toBe(true)

    for (const table of [projects, features, scenarios, featureFiles, releases, scenarioRevisions, annotations, analyses]) {
      expect(db.select().from(table).all()).toHaveLength(0)
    }
    expect(getProjectDetail(created.id)).toBeNull()
  })

  test('reports false for an unknown id', () => {
    expect(deleteProject(999)).toBe(false)
  })
})

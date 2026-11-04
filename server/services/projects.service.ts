import { desc, eq, inArray } from 'drizzle-orm'
import { getDB } from '../db/client'
import {
  analyses,
  annotations,
  connections,
  conversations,
  featureFiles,
  features,
  flows,
  messages,
  projects,
  repositories,
  releases,
  scenarioRevisions,
  scenarios,
} from '../db/schema'
import { encryptSecret } from '../utils/crypto'
import { createGithubService, GithubError, type GithubService } from './github.service'
import type { AddRepositoryInput, CreateProjectInput, ProjectDetail, ProjectSummary } from '../../shared/types'

/**
 * Project management: creation (which validates the repository against
 * GitHub and stores the PAT AES-256-GCM encrypted), listing, detail and
 * cascade delete. Route handlers stay thin zod/adapters around these
 * functions — this file is the layering rule's home for project business
 * logic.
 */

/** Error raised when GitHub does not know the requested repository (HTTP 404). */
export class RepositoryNotFoundError extends Error {
  constructor(
    readonly owner: string,
    readonly repo: string,
  ) {
    super(`Repository ${owner}/${repo} was not found on GitHub`)
    this.name = 'RepositoryNotFoundError'
  }
}

/**
 * Github service bound to the caller-supplied PAT (so private repositories
 * validate with it) or to the ambient env config when none was given.
 */
function githubForToken(pat?: string): GithubService {
  return createGithubService(pat ? { token: pat } : {})
}

function nowISO(): string {
  return new Date().toISOString()
}

/** Whether a project with this id exists (analyses/sync guards rely on it). */
export function projectExists(id: number): boolean {
  return getDB().select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get() !== undefined
}


/**
 * Validates the repository against GitHub and returns the branch to scan:
 * the caller's explicit one when given, otherwise the repository's default
 * branch. The lookup always happens — a 404 turns into
 * `RepositoryNotFoundError`, other GitHub failures rethrow.
 */
async function resolveBranch(input: { owner: string, repo: string, branch?: string }, github: GithubService): Promise<string> {
  try {
    const { defaultBranch } = await github.getRepo(input.owner, input.repo)
    return input.branch ?? defaultBranch
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) {
      throw new RepositoryNotFoundError(input.owner, input.repo)
    }
    throw error
  }
}

/**
 * Creates a project together with its first repository in one transaction
 * and returns it as a summary (never the encrypted PAT).
 */
export async function createProject(
  input: CreateProjectInput,
  github: GithubService = githubForToken(input.pat),
): Promise<ProjectSummary> {
  const branch = await resolveBranch(input, github)
  const db = getDB()

  return db.transaction((tx) => {
    const project = tx.insert(projects).values({
      name: input.name,
      description: input.description,
      createdAt: nowISO(),
    }).returning().get()

    tx.insert(repositories).values({
      projectId: project.id,
      owner: input.owner,
      repo: input.repo,
      branch,
      patEncrypted: input.pat ? encryptSecret(input.pat) : null,
    }).run()

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      repositories: [{ owner: input.owner, repo: input.repo, branch }],
    }
  })
}

/** All projects, newest first, with their repositories. No PAT material. */
export function listProjects(): ProjectSummary[] {
  const db = getDB()
  const rows = db.select().from(projects).orderBy(desc(projects.id)).all()
  const repoRows = db.select().from(repositories).all()

  return rows.map((project) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    repositories: repoRows
      .filter((repoRow) => repoRow.projectId === project.id)
      .map(({ owner, repo, branch }) => ({ owner, repo, branch })),
  }))
}

/**
 * Project overview: the project, its repositories and the last analysis
 * status (null until the first analysis exists). Returns null for unknown ids.
 */
export function getProjectDetail(id: number): ProjectDetail | null {
  const db = getDB()
  const project = db.select().from(projects).where(eq(projects.id, id)).get()
  if (!project) {
    return null
  }

  const repoRows = db.select().from(repositories).where(eq(repositories.projectId, id)).all()
  const lastAnalysis = db.select().from(analyses).where(eq(analyses.projectId, id)).orderBy(desc(analyses.id)).get()

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt,
    repositories: repoRows.map(({ owner, repo, branch }) => ({ owner, repo, branch })),
    lastAnalysis: lastAnalysis
      ? { type: lastAnalysis.type, status: lastAnalysis.status, createdAt: lastAnalysis.createdAt }
      : null,
  }
}

/**
 * Attaches another repository to an existing project. Returns the refreshed
 * project detail, or null when the project does not exist.
 */
export async function addRepository(
  projectId: number,
  input: AddRepositoryInput,
  github: GithubService = githubForToken(input.pat),
): Promise<ProjectDetail | null> {
  const db = getDB()
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()
  if (!project) {
    return null
  }

  const branch = await resolveBranch(input, github)
  db.insert(repositories).values({
    projectId,
    owner: input.owner,
    repo: input.repo,
    branch,
    patEncrypted: input.pat ? encryptSecret(input.pat) : null,
  }).run()

  return getProjectDetail(projectId)
}

/**
 * Deletes a project and everything hanging off it (repositories, features,
 * scenarios, files, analyses, releases, revisions, annotations) in one
 * transaction. Returns false when the project does not exist. Job rows are
 * queue bookkeeping without a project column and stay behind — their handlers
 * simply find no data.
 */
export function deleteProject(id: number): boolean {
  const db = getDB()

  return db.transaction((tx) => {
    const project = tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get()
    if (!project) {
      return false
    }

    const featureIds = tx.select({ id: features.id }).from(features).where(eq(features.projectId, id)).all().map((row) => row.id)
    const scenarioIds = featureIds.length
      ? tx.select({ id: scenarios.id }).from(scenarios).where(inArray(scenarios.featureId, featureIds)).all().map((row) => row.id)
      : []
    const releaseIds = tx.select({ id: releases.id }).from(releases).where(eq(releases.projectId, id)).all().map((row) => row.id)

    // Deepest dependency first so no row dangles at any point.
    if (scenarioIds.length) {
      tx.delete(annotations).where(inArray(annotations.scenarioId, scenarioIds)).run()
    }
    if (releaseIds.length) {
      tx.delete(scenarioRevisions).where(inArray(scenarioRevisions.releaseId, releaseIds)).run()
      tx.delete(releases).where(inArray(releases.id, releaseIds)).run()
    }
    tx.delete(analyses).where(eq(analyses.projectId, id)).run()
    if (featureIds.length) {
      if (scenarioIds.length) {
        tx.delete(scenarios).where(inArray(scenarios.id, scenarioIds)).run()
      }
      tx.delete(featureFiles).where(inArray(featureFiles.featureId, featureIds)).run()
      // The map tables reference features by foreign key — clear them before
      // the feature rows die. Pre-Plan-2 projects carry neither, so these
      // deletes are no-ops there.
      tx.delete(connections).where(eq(connections.projectId, id)).run()
      tx.delete(flows).where(inArray(flows.featureId, featureIds)).run()
      tx.delete(features).where(eq(features.projectId, id)).run()
    }
    // Conversations arrived in Plan 2 carrying real data, so the cascade
    // clears their messages before the rows themselves (messages reference
    // conversations, not the project).
    const conversationIds = tx.select({ id: conversations.id }).from(conversations)
      .where(eq(conversations.projectId, id)).all().map((row) => row.id)
    if (conversationIds.length > 0) {
      tx.delete(messages).where(inArray(messages.conversationId, conversationIds)).run()
    }
    tx.delete(conversations).where(eq(conversations.projectId, id)).run()
    tx.delete(repositories).where(eq(repositories.projectId, id)).run()
    tx.delete(projects).where(eq(projects.id, id)).run()

    return true
  })
}

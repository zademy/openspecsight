import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getDB, type Database } from '../db/client'
import { conversations, features, messages, projects, scenarios } from '../db/schema'
import { ask, type AskDeps } from './ask.service'
import type { AskCitation, AskCitationLink, AskExchange, ConversationDetail, ConversationSummary } from '../../shared/types'

/**
 * Conversations: persistence around the ask pipeline. `askInConversation`
 * runs the grounded ask and stores the exchange — the user's question plus
 * the assistant's answer with its display citations as JSON — in one
 * transaction with the conversation row it creates on the first question.
 * Route handlers stay thin: this file owns titles, ordering, scoping (a
 * conversation is only reachable through its own project) and the
 * transactional delete.
 */

export const CONVERSATION_TITLE_LENGTH = 60

/** Error raised when the conversation id does not belong to the project (HTTP 404). */
export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: number) {
    super(`No conversation with id ${conversationId} in this project`)
  }
}

/** Error raised when the project id is unknown (HTTP 404). */
export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: number) {
    super(`No project with id ${projectId}`)
  }
}

type ConversationRow = typeof conversations.$inferSelect
type MessageRow = typeof messages.$inferSelect
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * One ask exchange: answers the question through the ask service, then
 * stores it. The first question of a conversation creates the row titled
 * with the question's first 60 characters; follow-ups append and leave the
 * title alone. Throws ProjectNotFoundError / ConversationNotFoundError
 * before anything is stored.
 */
export async function askInConversation(projectId: number, question: string, conversationId: number | undefined, deps: AskDeps = {}): Promise<AskExchange> {
  const db = deps.db ?? getDB()
  if (db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get() === undefined) {
    throw new ProjectNotFoundError(projectId)
  }
  const existing = conversationId === undefined ? null : findConversation(db, projectId, conversationId)
  if (conversationId !== undefined && !existing) {
    throw new ConversationNotFoundError(conversationId)
  }

  const result = await ask(projectId, question, deps)
  const citations = toCitationLinks(db, result.citations)
  const now = new Date().toISOString()

  return db.transaction((tx: Transaction): AskExchange => {
    const conversation = existing
      ?? tx.insert(conversations).values({
        projectId,
        title: question.trim().slice(0, CONVERSATION_TITLE_LENGTH),
        pinned: 0,
        createdAt: now,
      }).returning().get()
    tx.insert(messages).values([
      { conversationId: conversation.id, role: 'user', content: question.trim(), citationsJson: null, createdAt: now },
      {
        conversationId: conversation.id,
        role: 'assistant',
        content: result.answer,
        citationsJson: citations.length > 0 ? JSON.stringify(citations) : null,
        createdAt: now,
      },
    ]).run()
    return { conversationId: conversation.id, answer: result.answer, refused: result.refused, citations }
  })
}

/**
 * Maps the ask service's grounded citations to their display shape by
 * re-reading the scenario and feature rows: a citation is only as live as
 * its row, so one that vanished between retrieval and storage is dropped
 * rather than rendered as a dead chip.
 */
function toCitationLinks(db: Database, citations: AskCitation[]): AskCitationLink[] {
  if (citations.length === 0) {
    return []
  }

  const rows = db.select({
    id: scenarios.id,
    code: scenarios.code,
    action: scenarios.action,
    outcome: scenarios.outcome,
    featureId: scenarios.featureId,
  }).from(scenarios).where(inArray(scenarios.id, citations.map((citation) => citation.scenarioId))).all()
  const rowById = new Map(rows.map((row) => [row.id, row]))

  const featureNames = new Map<number, string>()
  const links: AskCitationLink[] = []
  for (const citation of citations) {
    const row = rowById.get(citation.scenarioId)
    if (!row) {
      continue
    }
    let featureName = featureNames.get(row.featureId)
    if (featureName === undefined) {
      const feature = db.select({ name: features.name }).from(features).where(eq(features.id, row.featureId)).get()
      featureName = feature?.name ?? ''
      featureNames.set(row.featureId, featureName)
    }
    links.push({
      index: citation.index,
      scenarioId: row.id,
      code: row.code,
      action: row.action,
      outcome: row.outcome,
      featureId: row.featureId,
      featureName,
    })
  }
  return links
}

/** Conversations of a project, newest first. */
export function listConversations(projectId: number): ConversationSummary[] {
  return getDB().select({
    id: conversations.id,
    title: conversations.title,
    createdAt: conversations.createdAt,
  }).from(conversations).where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt), desc(conversations.id)).all()
}

/** One conversation with its messages oldest first; null when unknown or foreign. */
export function getConversation(projectId: number, conversationId: number): ConversationDetail | null {
  const db = getDB()
  const conversation = findConversation(db, projectId, conversationId)
  if (!conversation) {
    return null
  }

  const rows = db.select().from(messages).where(eq(messages.conversationId, conversation.id)).orderBy(asc(messages.id)).all()
  return {
    conversation: { id: conversation.id, title: conversation.title },
    messages: rows.map(toConversationMessage),
  }
}

/**
 * Deletes a conversation together with its messages — `messages.conversationId`
 * has no DB-level cascade, so the service does the cleanup in one
 * transaction, messages first. False when it was already gone or belongs to
 * another project.
 */
export function deleteConversation(projectId: number, conversationId: number): boolean {
  const db = getDB()
  return db.transaction((tx: Transaction): boolean => {
    const conversation = tx.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId))).get()
    if (!conversation) {
      return false
    }
    tx.delete(messages).where(eq(messages.conversationId, conversation.id)).run()
    tx.delete(conversations).where(eq(conversations.id, conversation.id)).run()
    return true
  })
}

/** Loads a conversation scoped to its project; undefined when foreign. */
function findConversation(db: Database, projectId: number, conversationId: number): ConversationRow | undefined {
  return db.select().from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId))).get()
}

function toConversationMessage(row: MessageRow) {
  let citations: AskCitationLink[] = []
  if (row.citationsJson) {
    try {
      citations = JSON.parse(row.citationsJson) as AskCitationLink[]
    } catch {
      citations = []
    }
  }
  return { role: row.role, content: row.content, citations }
}

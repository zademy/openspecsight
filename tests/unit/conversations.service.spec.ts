import { beforeEach, describe, expect, test } from 'vitest'
import { getDB, resetDB } from '../../server/db/client'
import { conversations, features, messages, projects, scenarios } from '../../server/db/schema'
import { askInConversation, ConversationNotFoundError, deleteConversation, getConversation, listConversations } from '../../server/services/conversations.service'
import { fakeLlm } from './helpers/analysis-fakes'
import type { AskCitationLink } from '../../shared/types'

/**
 * Conversations service tests: the persistence layer around the ask
 * pipeline. The llm is the scripted fake, so every answer is deterministic
 * and the citations can cite the seeded scenario's real id — the same
 * grounding contract the endpoint exposes to the UI.
 */

let projectId: number
let featureId: number
let wrongPasswordScenarioId: number

const WRONG_PASSWORD_ANSWER = 'Submitting the login form with the wrong password shows an error [1].'

function llmAnsweringWrongPassword(): ReturnType<typeof fakeLlm> {
  return fakeLlm({
    'ask-answer': {
      covered: true,
      answer: WRONG_PASSWORD_ANSWER,
      citations: [{ index: 1, scenarioId: wrongPasswordScenarioId, quote: 'shows an error' }],
    },
  })
}

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()

  const db = getDB()
  projectId = db.insert(projects).values({
    name: 'Ask Fixture',
    description: 'Exercises the conversations service',
    createdAt: '2026-11-04T00:00:00.000Z',
  }).run().lastInsertRowid as number
  featureId = db.insert(features).values({
    projectId,
    name: 'Authentication',
    description: 'Email and password login.',
    sortOrder: 0,
    source: 'ai',
  }).run().lastInsertRowid as number
  wrongPasswordScenarioId = db.insert(scenarios).values({
    featureId,
    context: 'user on the login page',
    action: 'submit the login form with the wrong password',
    outcome: "the form shows 'Invalid email or password' and no cookie is set",
    category: 'error',
    code: 'ER-2',
    sortOrder: 2,
    source: 'ai',
  }).run().lastInsertRowid as number
})

describe('askInConversation', () => {
  test('creates a conversation and stores both messages, citations as JSON', async () => {
    const result = await askInConversation(projectId, 'What happens with a wrong password?', undefined, { llm: llmAnsweringWrongPassword() })

    expect(result).not.toBeNull()
    expect(result!.refused).toBe(false)
    expect(result!.answer).toBe(WRONG_PASSWORD_ANSWER)
    expect(result!.citations).toHaveLength(1)
    expect(result!.citations[0]).toEqual({
      index: 1,
      scenarioId: wrongPasswordScenarioId,
      code: 'ER-2',
      action: 'submit the login form with the wrong password',
      outcome: "the form shows 'Invalid email or password' and no cookie is set",
      featureId,
      featureName: 'Authentication',
    })

    const db = getDB()
    const conversation = db.select().from(conversations).all()[0]!
    expect(conversation.projectId).toBe(projectId)
    expect(conversation.title).toBe('What happens with a wrong password?')

    const stored = db.select().from(messages).all()
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ conversationId: conversation.id, role: 'user', content: 'What happens with a wrong password?' })
    expect(stored[1]).toMatchObject({ conversationId: conversation.id, role: 'assistant', content: WRONG_PASSWORD_ANSWER })
    expect(JSON.parse(stored[1]!.citationsJson!)).toEqual(result!.citations)
    expect(result!.conversationId).toBe(conversation.id)
  })

  test('the citation response carries no quote — the link DTO stays display-shaped', async () => {
    const result = await askInConversation(projectId, 'wrong password?', undefined, { llm: llmAnsweringWrongPassword() })
    expect(result!.citations[0]).not.toHaveProperty('quote')
  })

  test('truncates the conversation title to the first 60 characters of the question', async () => {
    const result = await askInConversation(projectId, 'x'.repeat(100), undefined, { llm: llmAnsweringWrongPassword() })

    const conversation = getDB().select().from(conversations).all()[0]!
    expect(conversation.title).toHaveLength(60)
    expect(result!.conversationId).toBe(conversation.id)
  })

  test('appends to an existing conversation and keeps its title', async () => {
    const first = await askInConversation(projectId, 'What happens with a wrong password?', undefined, { llm: llmAnsweringWrongPassword() })
    const second = await askInConversation(projectId, 'And with an unregistered email?', first!.conversationId, { llm: llmAnsweringWrongPassword() })

    expect(second!.conversationId).toBe(first!.conversationId)
    const db = getDB()
    expect(db.select().from(conversations).all()).toHaveLength(1)
    expect(db.select().from(conversations).all()[0]!.title).toBe('What happens with a wrong password?')
    expect(db.select().from(messages).all()).toHaveLength(4)
  })

  test('a refusal stores the honest copy with null citationsJson', async () => {
    const llm = fakeLlm({
      'ask-answer': { covered: false, answer: 'The spec has nothing about time travel.', citations: [] },
    })

    const result = await askInConversation(projectId, 'How does the flux capacitor work?', undefined, { llm })

    expect(result!.refused).toBe(true)
    expect(result!.citations).toEqual([])
    const stored = getDB().select().from(messages).all()
    expect(stored[1]).toMatchObject({ role: 'assistant', content: 'The spec has nothing about time travel.', citationsJson: null })
  })

  test('an unknown project stores nothing', async () => {
    const llm = fakeLlm({
      'ask-answer': { covered: true, answer: WRONG_PASSWORD_ANSWER, citations: [] },
    })

    await expect(askInConversation(999, 'wrong password?', undefined, { llm })).rejects.toThrow(/project/i)
    expect(getDB().select().from(messages).all()).toHaveLength(0)
  })

  test('rejects a conversation that belongs to another project', async () => {
    const first = await askInConversation(projectId, 'What happens with a wrong password?', undefined, { llm: llmAnsweringWrongPassword() })

    const db = getDB()
    const otherProject = db.insert(projects).values({
      name: 'Other', description: '', createdAt: '2026-11-04T00:00:00.000Z',
    }).run().lastInsertRowid as number

    await expect(askInConversation(otherProject, 'again?', first!.conversationId, { llm: llmAnsweringWrongPassword() })).rejects.toThrow(ConversationNotFoundError)
    expect(db.select().from(messages).all()).toHaveLength(2)
  })
})

describe('listConversations', () => {
  test('lists newest first', () => {
    const db = getDB()
    db.insert(conversations).values({ projectId, title: 'First', pinned: 0, createdAt: '2026-11-04T01:00:00.000Z' }).run()
    db.insert(conversations).values({ projectId, title: 'Second', pinned: 0, createdAt: '2026-11-04T02:00:00.000Z' }).run()

    const list = listConversations(projectId)

    expect(list.map((conversation) => conversation.title)).toEqual(['Second', 'First'])
    expect(list[0]).toMatchObject({ id: expect.any(Number), title: 'Second', createdAt: '2026-11-04T02:00:00.000Z' })
  })
})

describe('getConversation', () => {
  test('returns the conversation with parsed citations per message', async () => {
    const created = await askInConversation(projectId, 'What happens with a wrong password?', undefined, { llm: llmAnsweringWrongPassword() })

    const detail = getConversation(projectId, created!.conversationId)

    expect(detail).not.toBeNull()
    expect(detail!.conversation.title).toBe('What happens with a wrong password?')
    expect(detail!.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(detail!.messages[1]!.citations[0]).toMatchObject({ code: 'ER-2', featureName: 'Authentication' } satisfies Partial<AskCitationLink>)
  })

  test('returns null for an unknown conversation', () => {
    expect(getConversation(projectId, 999)).toBeNull()
  })
})

describe('deleteConversation', () => {
  test('deletes the conversation and its messages together', async () => {
    const created = await askInConversation(projectId, 'What happens with a wrong password?', undefined, { llm: llmAnsweringWrongPassword() })

    expect(deleteConversation(projectId, created!.conversationId)).toBe(true)
    const db = getDB()
    expect(db.select().from(conversations).all()).toHaveLength(0)
    expect(db.select().from(messages).all()).toHaveLength(0)
  })

  test('reports false for an unknown conversation', () => {
    expect(deleteConversation(projectId, 999)).toBe(false)
  })
})

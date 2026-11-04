import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { connectionTypes } from '../../shared/schemas'

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  createdAt: text('createdAt').notNull(),
})

export const repositories = sqliteTable('repositories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('projectId').notNull().references(() => projects.id),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch').notNull(),
  patEncrypted: text('patEncrypted'),
  lastSyncedSha: text('lastSyncedSha'),
})

export const features = sqliteTable('features', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('projectId').notNull().references(() => projects.id),
  parentId: integer('parentId').references((): AnySQLiteColumn => features.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  source: text('source', { enum: ['ai', 'manual'] }).notNull(),
})

export const scenarios = sqliteTable('scenarios', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  featureId: integer('featureId').notNull().references(() => features.id),
  context: text('context').notNull(),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  category: text('category', { enum: ['happy', 'edge', 'error'] }).notNull(),
  code: text('code').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  source: text('source', { enum: ['ai', 'manual'] }).notNull(),
})

export const featureFiles = sqliteTable('featureFiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  featureId: integer('featureId').notNull().references(() => features.id),
  path: text('path').notNull(),
})

export const analyses = sqliteTable('analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('projectId').notNull().references(() => projects.id),
  type: text('type', { enum: ['initial', 'sync'] }).notNull(),
  status: text('status', { enum: ['queued', 'running', 'done', 'error'] }).notNull(),
  progress: integer('progress').notNull(),
  step: text('step').notNull(),
  statsJson: text('statsJson').notNull(),
  error: text('error'),
  createdAt: text('createdAt').notNull(),
  finishedAt: text('finishedAt'),
})

export const releases = sqliteTable('releases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('projectId').notNull().references(() => projects.id),
  repositoryId: integer('repositoryId').notNull().references(() => repositories.id),
  sha: text('sha').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  highlight: integer('highlight').notNull(),
  summary: text('summary').notNull(),
  authorsJson: text('authorsJson').notNull(),
  message: text('message').notNull(),
  committedAt: text('committedAt').notNull(),
})

export const scenarioRevisions = sqliteTable('scenarioRevisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  releaseId: integer('releaseId').notNull().references(() => releases.id),
  scenarioId: integer('scenarioId').references(() => scenarios.id),
  featureId: integer('featureId').notNull().references(() => features.id),
  kind: text('kind', { enum: ['new', 'changed', 'gone', 'fixed'] }).notNull(),
  state: text('state', { enum: ['applied', 'proposed', 'discarded'] }).notNull(),
  beforeJson: text('beforeJson'),
  afterJson: text('afterJson'),
})

export const annotations = sqliteTable('annotations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scenarioId: integer('scenarioId').notNull().references(() => scenarios.id),
  body: text('body').notNull(),
  author: text('author').notNull(),
  createdAt: text('createdAt').notNull(),
})

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  payloadJson: text('payloadJson').notNull(),
  status: text('status', { enum: ['queued', 'running', 'done', 'error'] }).notNull(),
  attempts: integer('attempts').notNull(),
  error: text('error'),
  createdAt: text('createdAt').notNull(),
  finishedAt: text('finishedAt'),
})

export const connections = sqliteTable('connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('projectId').notNull().references(() => projects.id),
  fromFeatureId: integer('fromFeatureId').notNull().references(() => features.id),
  toFeatureId: integer('toFeatureId').notNull().references(() => features.id),
  type: text('type', { enum: connectionTypes }).notNull(),
})

export const flows = sqliteTable('flows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  featureId: integer('featureId').notNull().references(() => features.id).unique(),
  graphJson: text('graphJson').notNull(),
})

export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('projectId').notNull().references(() => projects.id),
  title: text('title').notNull(),
  pinned: integer('pinned').notNull(), // SQLite booleans: 1 = pinned, 0 = unpinned
  createdAt: text('createdAt').notNull(),
})

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversationId').notNull().references(() => conversations.id),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  citationsJson: text('citationsJson'),
  createdAt: text('createdAt').notNull(),
})

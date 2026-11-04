import type { z } from 'zod'
import type { FeatureInventorySchema, FeatureScenariosSchema, RevisionKindSchema, ScenarioCategorySchema, SyncUpdateSchema } from './schemas'

// --- LLM output shapes (validated at runtime by shared/schemas.ts) ---

export type FeatureInventory = z.infer<typeof FeatureInventorySchema>
export type FeatureInventoryEntry = FeatureInventory['features'][number]

export type FeatureScenarios = z.infer<typeof FeatureScenariosSchema>
export type FeatureScenarioGroup = FeatureScenarios['groups'][number]

export type SyncUpdate = z.infer<typeof SyncUpdateSchema>
export type SyncFeatureUpdate = SyncUpdate['featureUpdates'][number]

// --- Domain enums (single source of truth for API + DB string literals) ---

export type ScenarioCategory = z.infer<typeof ScenarioCategorySchema>
export type ScenarioSource = 'ai' | 'manual'
export type RevisionKind = z.infer<typeof RevisionKindSchema>
export type AnalysisStatus = 'queued' | 'running' | 'done' | 'error'
export type AnalysisType = 'initial' | 'sync'

// --- API response shapes ---

/** Project as listed by GET /api/projects; never carries the encrypted PAT. */
export interface ProjectSummary {
  id: number
  name: string
  description: string
  repositories: Array<{ owner: string, repo: string, branch: string }>
}

/** Feature tree node as served by GET /api/projects/:id/features. */
export interface FeatureNode {
  id: number
  name: string
  description: string
  parentId: number | null
  scenarioCount: number
  children: FeatureNode[]
}

/** Scenario row as served by the spec API. */
export interface ScenarioDTO {
  id: number
  code: string
  context: string
  action: string
  outcome: string
  category: ScenarioCategory
  source: ScenarioSource
}

/** Release row as served by the changes API. */
export interface ReleaseDTO {
  id: number
  sha: string
  title: string
  category: string
  highlight: boolean
  summary: string
  authors: string[]
  message: string
  committedAt: string
}

/** Scenario revision as served by the release detail API. */
export interface RevisionDTO {
  kind: RevisionKind
  state: 'applied' | 'proposed'
  code: string
  featureName: string
  featureId: number
  action: string
  outcome: string
  before?: { action: string, outcome: string }
}

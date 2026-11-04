import type { z } from 'zod'
import type { AddRepositorySchema, CreateAnnotationSchema, CreateProjectSchema, CreateScenarioSchema, FeatureInventorySchema, FeatureScenariosSchema, RevisionKindSchema, ScenarioCategorySchema, SyncUpdateSchema, UpdateScenarioSchema } from './schemas'

// --- LLM output shapes (validated at runtime by shared/schemas.ts) ---

export type FeatureInventory = z.infer<typeof FeatureInventorySchema>
export type FeatureInventoryEntry = FeatureInventory['features'][number]

export type FeatureScenarios = z.infer<typeof FeatureScenariosSchema>
export type FeatureScenarioGroup = FeatureScenarios['groups'][number]

export type SyncUpdate = z.infer<typeof SyncUpdateSchema>
export type SyncFeatureUpdate = SyncUpdate['featureUpdates'][number]

// --- Project management ---

/** Project creation payload (POST /api/projects), shared by form and API. */
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>

/** Payload for attaching another repository to a project. */
export type AddRepositoryInput = z.infer<typeof AddRepositorySchema>

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

/**
 * Project overview as served by GET /api/projects/:id: the project, its
 * repositories and the last analysis status (null until the first analysis
 * has been queued). Like ProjectSummary, it never carries the encrypted PAT.
 */
export interface ProjectDetail {
  id: number
  name: string
  description: string
  createdAt: string
  repositories: Array<{ owner: string, repo: string, branch: string }>
  lastAnalysis: { type: AnalysisType, status: AnalysisStatus, createdAt: string } | null
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

/**
 * Latest analysis progress as served by GET /api/projects/:id/analyses;
 * clients poll it while status is queued or running.
 */
export interface AnalysisProgress {
  status: AnalysisStatus
  progress: number
  step: string
  error: string | null
  /** Final counts once the pipeline reached `done`; null before that. */
  stats: AnalysisStats | null
}

/** Counts stored in analyses.statsJson when an analysis finishes. */
export interface AnalysisStats {
  features: number
  scenarios: number
  files: number
}

// --- Spec browsing (Task 9) ---

/** Payload for creating a manual scenario (POST /api/features/:featureId/scenarios). */
export type CreateScenarioInput = z.infer<typeof CreateScenarioSchema>

/** Payload for editing a scenario (PATCH /api/scenarios/:id). */
export type UpdateScenarioInput = z.infer<typeof UpdateScenarioSchema>

/** Payload for adding an annotation (POST /api/scenarios/:id/annotations). */
export type CreateAnnotationInput = z.infer<typeof CreateAnnotationSchema>

/** Annotation row as served by the annotations API. */
export interface AnnotationDTO {
  id: number
  scenarioId: number
  body: string
  author: string
  createdAt: string
}

/** One scenario group as served by GET /api/features/:featureId. */
export interface ScenarioGroupDTO {
  context: string
  scenarios: ScenarioDTO[]
}

/** A feature with its name, description and scenario groups. */
export interface FeatureDetail {
  feature: {
    id: number
    name: string
    description: string
  }
  groups: ScenarioGroupDTO[]
}

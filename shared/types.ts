import type { z } from 'zod'
import type { AddRepositorySchema, AskAnswerSchema, CreateAnnotationSchema, CreateProjectSchema, CreateScenarioSchema, ConnectionsSchema, FeatureInventorySchema, FeatureScenariosSchema, FlowGraphSchema, RevisionKindSchema, ScenarioCategorySchema, SyncUpdateSchema, UpdateScenarioSchema } from './schemas'

// --- LLM output shapes (validated at runtime by shared/schemas.ts) ---

export type FeatureInventory = z.infer<typeof FeatureInventorySchema>
export type FeatureInventoryEntry = FeatureInventory['features'][number]

export type FeatureScenarios = z.infer<typeof FeatureScenariosSchema>
export type FeatureScenarioGroup = FeatureScenarios['groups'][number]

export type SyncUpdate = z.infer<typeof SyncUpdateSchema>
export type SyncFeatureUpdate = SyncUpdate['featureUpdates'][number]

export type FlowGraph = z.infer<typeof FlowGraphSchema>
export type FlowNode = FlowGraph['nodes'][number]
export type FlowEdge = FlowGraph['edges'][number]

export type AskAnswer = z.infer<typeof AskAnswerSchema>

/**
 * One node scenarioCode resolved against the live scenario rows: the flow
 * diagram's clickable codes. Codes with no matching scenario (deleted or
 * alien) are simply absent — never an error.
 */
export interface ScenarioLink {
  scenarioCode: string
  scenarioId: number
}

/** GET /api/features/:featureId/flow — the feature's flow diagram data. */
export interface FeatureFlow {
  graph: FlowGraph
  scenarioLinks: ScenarioLink[]
}

export type Connections = z.infer<typeof ConnectionsSchema>
export type ConnectionEdge = Connections['connections'][number]
export type ConnectionType = Connections['connections'][number]['type']

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
  /**
   * True when the sync has parked a proposed revision for this scenario —
   * set only by the feature-detail API, so the spec can mark the row as
   * "suggested" while the operator's version stays authoritative.
   */
  hasProposal?: boolean
  /** The parked revision to apply or dismiss; set alongside `hasProposal`. */
  proposalId?: number
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
  /** `discarded` rows were proposed once and rejected by the operator. */
  state: 'applied' | 'proposed' | 'discarded'
  /** Null for applied `gone` rows: the scenario was removed from the spec. */
  scenarioId: number | null
  code: string
  featureName: string
  featureId: number
  action: string
  outcome: string
  before?: { action: string, outcome: string }
}

/** Per-kind revision counts of one release (applied and proposed rows). */
export interface ReleaseCounts {
  new: number
  changed: number
  gone: number
  fixed: number
}

/** Release row plus its revision counts, as served by the grouped list API. */
export interface ReleaseListItem extends ReleaseDTO {
  counts: ReleaseCounts
}

/** One calendar day of releases, newest day first, as served by the list API. */
export interface ReleaseDayGroup {
  date: string
  releases: ReleaseListItem[]
}

/** A release with its revisions grouped by kind, as served by the detail API. */
export interface ReleaseDetail extends ReleaseDTO {
  sections: {
    new: RevisionDTO[]
    changed: RevisionDTO[]
    gone: RevisionDTO[]
    fixed: RevisionDTO[]
  }
}

/** `source` query filter of GET /api/projects/:id/releases. */
export type ReleaseSourceFilter = 'all' | 'ai' | 'manual'

/** Query parameters of GET /api/projects/:id/releases. */
export interface ReleaseListQuery {
  source?: ReleaseSourceFilter
  featureId?: number
  q?: string
}

/**
 * Latest analysis progress as served by GET /api/projects/:id/analyses;
 * clients poll it while status is queued or running.
 */
export interface AnalysisProgress {
  /** Which pipeline this row belongs to: the initial scan or a sync run. */
  type: AnalysisType
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
  /** Connection rows kept after the pipeline dropped invalid ones. */
  connections: number
  /** Self-links, unknown feature names and duplicate triples dropped at insert. */
  connectionsSkipped: number
  /** Flow graphs stored, one per top-level feature. */
  flows: number
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

// --- Project map (Plan 2) ---

/** One feature of the project map as served by GET /api/projects/:id/map. */
export interface MapNode {
  /** Node identity and the endpoint edges reference: the feature's row id. */
  id: number
  /** Same value as `id`, spelled out for feature-detail links from the UI. */
  featureId: number
  name: string
  /** Scenarios attached to this feature itself; child scenarios stay theirs. */
  scenarioCount: number
  /** True when the feature hangs under a top-level feature. */
  isChild: boolean
}

/**
 * One edge between two features. Connections between the same pair collapse
 * into a single edge; `from`/`to` are canonicalized (lower feature id first)
 * and `types` carries every connection type between them, sorted.
 */
export interface MapEdge {
  from: number
  to: number
  types: string[]
}

/** GET /api/projects/:id/map — the data behind the visualization page. */
export interface MapData {
  nodes: MapNode[]
  edges: MapEdge[]
  /** True when the project has no connections yet (pre-Plan-2 projects). */
  empty: boolean
}

// --- Ask ---

/**
 * One grounded citation behind an [n] marker in the ask answer: the live
 * scenario row the claim came from, plus the quote it backs. `index` is the
 * 1-based display position matching the markers in `answer`.
 */
export interface AskCitation {
  index: number
  scenarioId: number
  code: string
  featureId: number
  featureName: string
  quote: string
}

/** The ask service's verdict: a grounded answer with citations, or an honest refusal. */
export interface AskResult {
  answer: string
  /** True for refusals: empty question, zero coverage, or a covered:false model verdict. */
  refused: boolean
  citations: AskCitation[]
}

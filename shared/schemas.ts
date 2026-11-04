import { z } from 'zod'

/** Scenario category shared by the LLM outputs and the DB rows. */
export const ScenarioCategorySchema = z.enum(['happy', 'edge', 'error'])

/** Revision kind a sync update can attach to an existing or new scenario. */
export const RevisionKindSchema = z.enum(['new', 'changed', 'gone', 'fixed'])

/**
 * Whole-repo feature inventory: top-level features with optional one level of
 * sub-features, each pointing at the files that implement it.
 */
export const FeatureInventorySchema = z.object({
  features: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      children: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          files: z.array(z.string()),
        }),
      ).optional(),
    }),
  ),
})

/** Gherkin-style scenarios for one feature, grouped by shared context. */
export const FeatureScenariosSchema = z.object({
  featureName: z.string(),
  groups: z.array(
    z.object({
      context: z.string(),
      scenarios: z.array(
        z.object({
          action: z.string(),
          outcome: z.string(),
          category: ScenarioCategorySchema,
        }),
      ),
    }),
  ),
})

/**
 * Flow diagram of one feature as produced by the analysis: nodes are steps
 * from start to end, edges the transitions between them; scenarioCode
 * optionally links a node back to the scenario (SC-xxx) it was built from.
 */
export const FlowGraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['start', 'step', 'decision', 'error', 'end']),
      label: z.string(),
      scenarioCode: z.string().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string().optional(),
    }),
  ),
})

/**
 * Feature-to-feature relations shown on the product map. SQLite has no enum
 * type, so the 9 kinds live here — shared so the DB column enum and the LLM
 * output schema can never drift apart.
 */
export const connectionTypes = ['leads_to', 'triggers', 'depends_on', 'shares_data', 'authenticates', 'notifies', 'configures', 'embeds_in', 'competes_with'] as const

export const ConnectionTypeSchema = z.enum(connectionTypes)

/** One directed relation; names reference the stored features verbatim. */
export const ConnectionEdgeSchema = z.object({
  fromFeature: z.string(),
  toFeature: z.string(),
  type: ConnectionTypeSchema,
})

/**
 * Feature-to-feature relations as produced by the analysis. Names reference
 * the inventory's features; the pipeline drops unknown names, self-links and
 * duplicate triples before storing, so the schema itself stays lenient.
 */
export const ConnectionsSchema = z.object({
  connections: z.array(ConnectionEdgeSchema),
})

/**
 * Incremental spec update produced by a sync: per-feature scenario revisions
 * against the previously stored spec. `connections` and `flow` are optional
 * map refreshes for the touched feature — absent fields leave the stored maps
 * untouched, and pre-map payloads keep validating.
 */
export const SyncUpdateSchema = z.object({
  title: z.string(),
  category: z.string(),
  highlight: z.boolean(),
  summary: z.string(),
  featureUpdates: z.array(
    z.object({
      featureName: z.string(),
      changedFiles: z.array(z.string()),
      scenarios: z.array(
        z.object({
          kind: RevisionKindSchema,
          matchCode: z.string().optional(),
          context: z.string(),
          action: z.string(),
          outcome: z.string(),
          category: ScenarioCategorySchema,
        }),
      ),
      connections: z.array(ConnectionEdgeSchema).optional(),
      flow: FlowGraphSchema.optional(),
    }),
  ),
})

/**
 * The Ask step's verdict on a user question: whether the retrieved scenarios
 * cover it, the answer text (with [n] markers matching `citations[].index`,
 * the prompt's scenario numbering), and the citations backing those markers.
 */
export const AskAnswerSchema = z.object({
  covered: z.boolean(),
  answer: z.string(),
  citations: z.array(
    z.object({
      index: z.number().int(),
      scenarioId: z.number().int(),
      quote: z.string(),
    }),
  ),
})

/**
 * One rendered block of a digest or release note: headings and paragraphs
 * carry text, lists carry items. Shared by the digest/note draft LLM
 * outputs and the rows' blocksJson, so a malformed draft can never reach
 * the renderer.
 */
export const ContentBlockSchema = z.object({
  type: z.enum(['heading', 'paragraph', 'list']),
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
}).refine(
  (block) => block.type === 'list'
    ? (block.items?.length ?? 0) > 0
    : typeof block.text === 'string' && block.text.trim().length > 0,
  { message: 'Heading and paragraph blocks need text, list blocks need items' },
)

export const ContentBlocksSchema = z.array(ContentBlockSchema)

/** Weekly or on-demand digest draft as returned by the digest-draft LLM call. */
export const DigestDraftSchema = z.object({
  title: z.string(),
  blocks: ContentBlocksSchema,
})

/** Release note draft as returned by the note-draft LLM call. */
export const NoteDraftSchema = z.object({
  title: z.string(),
  blocks: ContentBlocksSchema,
})

/** Rewritten block text as returned by the note-enhance LLM call. */
export const NoteEnhanceSchema = z.object({
  text: z.string(),
})

/**
 * Payload of POST /api/projects: a project together with its first
 * repository. Empty optional fields (untouched form inputs) normalize to
 * undefined; the server validates the repository against GitHub and defaults
 * the branch before anything is stored.
 */
export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500),
  owner: z.string().trim().min(1, 'Owner is required').max(100),
  repo: z.string().trim().min(1, 'Repository is required').max(100),
  branch: z.string().trim().optional().transform((v) => (v === '' ? undefined : v)),
  pat: z.string().trim().optional().transform((v) => (v === '' ? undefined : v)),
})

/** Payload of POST /api/projects/:id/repositories: another repository of an existing project. */
export const AddRepositorySchema = CreateProjectSchema.pick({ owner: true, repo: true, branch: true, pat: true })

/**
 * Payload of POST /api/features/:featureId/scenarios: one operator-written
 * scenario in the product's "context + action → outcome" shape.
 */
export const CreateScenarioSchema = z.object({
  context: z.string().trim().min(1, 'Context is required').max(200),
  action: z.string().trim().min(1, 'Action is required').max(500),
  outcome: z.string().trim().min(1, 'Outcome is required').max(500),
  category: ScenarioCategorySchema,
})

/**
 * Payload of PATCH /api/scenarios/:id: any subset of the editable fields.
 * At least one field — an empty `{}` must not masquerade as an edit (it
 * would flip the row to manual without changing anything).
 */
export const UpdateScenarioSchema = CreateScenarioSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'At least one field is required' },
)

/** Payload of POST /api/scenarios/:id/annotations. */
export const CreateAnnotationSchema = z.object({
  body: z.string().trim().min(1, 'A note needs some text').max(2000),
})

/**
 * Payload of POST /api/projects/:id/ask: one question, optionally into an
 * existing conversation. An empty question is rejected here — the ask
 * service's empty-question refusal exists for direct service calls, while
 * the API never stores a blank message.
 */
export const AskQuestionSchema = z.object({
  question: z.string().trim().min(1, 'A question needs some text').max(2000),
  conversationId: z.number().int().positive().optional(),
})

/**
 * Payload of POST /api/projects/:id/digests: an optional explicit week.
 * Both fields default independently (to = today, from = today − 7), so the
 * only cross-field rule is that the range must not run backwards.
 */
export const CreateDigestSchema = z.object({
  rangeFrom: z.string().date('rangeFrom must be a YYYY-MM-DD date').optional(),
  rangeTo: z.string().date('rangeTo must be a YYYY-MM-DD date').optional(),
}).refine(
  (range) => range.rangeFrom === undefined || range.rangeTo === undefined || range.rangeFrom <= range.rangeTo,
  { message: 'rangeFrom must not be after rangeTo' },
)

/** Payload of POST /api/digests/:id/send: force re-sends an emailed digest. */
export const SendDigestSchema = z.object({
  force: z.boolean().default(false),
})

/** Payload of POST /api/projects/:id/voices: one named tone of writing. */
export const CreateVoiceSchema = z.object({
  name: z.string().trim().min(1, 'A voice needs a name').max(80),
  description: z.string().trim().min(1, 'A voice needs a description').max(1000),
})

/**
 * Payload of POST /api/projects/:id/release-notes. The scope is exactly one
 * of a single release or a committed-at date range (both fields together);
 * revisionIds optionally narrows the note to specific revisions of that
 * scope and voiceId overrides the project's default voice.
 */
export const CreateReleaseNoteSchema = z.object({
  releaseId: z.number().int().positive().optional(),
  rangeFrom: z.string().date('rangeFrom must be a YYYY-MM-DD date').optional(),
  rangeTo: z.string().date('rangeTo must be a YYYY-MM-DD date').optional(),
  revisionIds: z.array(z.number().int().positive()).optional(),
  voiceId: z.number().int().positive().optional(),
}).refine(
  (input) => (input.releaseId !== undefined) !== (input.rangeFrom !== undefined || input.rangeTo !== undefined)
    && (input.releaseId !== undefined || (input.rangeFrom !== undefined && input.rangeTo !== undefined)),
  { message: 'Give exactly one of releaseId or rangeFrom plus rangeTo' },
).refine(
  (input) => input.rangeFrom === undefined || input.rangeTo === undefined || input.rangeFrom <= input.rangeTo,
  { message: 'rangeFrom must not be after rangeTo' },
)

/**
 * Payload of PATCH /api/release-notes/:id: any subset of the editable
 * fields. The autosave stores exactly what was sent — a title-only save
 * must not touch the blocks array, and the other way around — so at
 * least one field is required and an empty {} must not masquerade as an
 * edit.
 */
export const UpdateReleaseNoteSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200).optional(),
  blocks: ContentBlocksSchema.optional(),
}).refine(
  (patch) => patch.title !== undefined || patch.blocks !== undefined,
  { message: 'Give a title, blocks, or both' },
)

/** Payload of POST /api/release-notes/:id/blocks/:index/enhance. */
export const EnhanceBlockSchema = z.object({
  instruction: z.string().trim().max(2000, 'Keep the instruction under 2000 characters')
    .optional()
    .transform((instruction) => instruction === '' ? undefined : instruction),
})

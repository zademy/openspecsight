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
 * Incremental spec update produced by a sync: per-feature scenario revisions
 * against the previously stored spec.
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
    }),
  ),
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

/** Payload of PATCH /api/scenarios/:id: any subset of the editable fields. */
export const UpdateScenarioSchema = CreateScenarioSchema.partial()

/** Payload of POST /api/scenarios/:id/annotations. */
export const CreateAnnotationSchema = z.object({
  body: z.string().trim().min(1, 'A note needs some text').max(2000),
})

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

<script setup lang="ts">
import type { RevisionDTO, RevisionKind } from '#shared/types'

/**
 * One revision group of a release (New / Changed / Gone / Fixed): the kind
 * chip carries the semantic color (DESIGN.md — functional, not palette),
 * rows keep the "action → outcome" motif, and each applied revision links
 * back to its scenario anchor in the spec. Proposed revisions are marked
 * "suggested" and link to the feature page without an anchor — they are
 * pending suggestions, not applied rows.
 */

const props = defineProps<{ projectId: string | number, kind: RevisionKind, revisions: RevisionDTO[] }>()

/** Semantic colors are reserved: new=green, changed=amber, gone=red, fixed=blue. */
const KIND_COLORS: Record<RevisionKind, 'success' | 'warning' | 'error' | 'info'> = {
  new: 'success',
  changed: 'warning',
  gone: 'error',
  fixed: 'info',
}

const KIND_LABELS: Record<RevisionKind, string> = {
  new: 'New',
  changed: 'Changed',
  gone: 'Gone',
  fixed: 'Fixed',
}

/**
 * Applied revisions link to their scenario anchor; proposals to the feature
 * page root. Applied removals (null scenarioId) link nowhere — the scenario
 * no longer exists in the spec.
 */
function specHref(revision: RevisionDTO): string | null {
  if (revision.state === 'proposed') {
    return `/projects/${props.projectId}/spec/${revision.featureId}`
  }
  if (revision.scenarioId === null) {
    return null
  }
  return `/projects/${props.projectId}/spec/${revision.featureId}#scenario-${revision.scenarioId}`
}
</script>

<template>
  <section class="space-y-2">
    <UBadge :color="KIND_COLORS[kind]" variant="subtle" size="sm" :label="KIND_LABELS[kind]" />

    <ol class="divide-y divide-default">
      <li
        v-for="revision in revisions"
        :id="`revision-${revision.kind}-${revision.featureId}-${revision.code}`"
        :key="`${revision.featureId}-${revision.code}-${revision.state}`"
        class="py-4 first:pt-0 last:pb-0"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-xs text-muted">{{ revision.code }}</span>
          <span class="text-xs text-muted">{{ revision.featureName }}</span>
          <UBadge
            v-if="revision.state === 'proposed' || revision.state === 'discarded'"
            color="neutral"
            variant="outline"
            size="sm"
            :label="revision.state === 'proposed' ? 'suggested' : 'dismissed'"
          />
        </div>

        <p class="mt-1.5 max-w-prose text-sm leading-relaxed">
          <span class="font-medium text-highlighted">{{ revision.action }}</span>
          <span class="px-1.5 text-dimmed" aria-hidden="true">→</span>
          <span class="text-muted">{{ revision.outcome }}</span>
        </p>

        <p
          v-if="revision.before"
          class="mt-1 max-w-prose text-xs leading-relaxed text-dimmed"
        >
          Was: {{ revision.before.action }} → {{ revision.before.outcome }}
        </p>

        <UButton
          v-if="specHref(revision)"
          :to="specHref(revision)"
          label="View in spec"
          color="neutral"
          variant="link"
          size="sm"
          class="mt-1 px-0"
          trailing-icon="i-lucide-arrow-right"
        />
      </li>
    </ol>
  </section>
</template>

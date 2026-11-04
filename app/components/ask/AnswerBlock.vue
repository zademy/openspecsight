<script setup lang="ts">
import type { AskCitationLink } from '#shared/types'

/**
 * One assistant answer, documentation-quiet: the text renders as prose and
 * every `[n]` marker becomes a superscript chip carrying the scenario code
 * (mono) that links to the anchored row in the spec — the deep-link
 * expansion there does the rest. A refused answer shows the honest refusal
 * copy without chips plus a quiet way out: browsing the spec itself.
 */

const props = defineProps<{
  projectId: string | number
  answer: string
  citations: AskCitationLink[]
  refused?: boolean
}>()

type Segment = { kind: 'text', value: string } | { kind: 'citation', citation: AskCitationLink }

const MARKER = /\[(\d+)\]/g

/** Splits the answer on surviving `[n]` markers; an unknown index stays literal text. */
const segments = computed<Segment[]>(() => {
  const byIndex = new Map(props.citations.map((citation) => [citation.index, citation]))
  const parts: Segment[] = []
  let cursor = 0
  for (const match of props.answer.matchAll(MARKER)) {
    const citation = byIndex.get(Number.parseInt(match[1]!, 10))
    if (!citation) {
      continue
    }
    const start = match.index ?? 0
    if (start > cursor) {
      parts.push({ kind: 'text', value: props.answer.slice(cursor, start) })
    }
    parts.push({ kind: 'citation', citation })
    cursor = start + match[0]!.length
  }
  if (cursor < props.answer.length) {
    parts.push({ kind: 'text', value: props.answer.slice(cursor) })
  }
  return parts
})

function specHref(citation: AskCitationLink): string {
  return `/projects/${props.projectId}/spec/${citation.featureId}#scenario-${citation.scenarioId}`
}
</script>

<template>
  <div class="space-y-2">
    <p v-if="refused" class="max-w-prose text-sm leading-relaxed text-muted">{{ answer }}</p>
    <p v-else class="max-w-prose text-sm leading-relaxed whitespace-pre-line">
      <template v-for="(segment, position) in segments" :key="position">
        <template v-if="segment.kind === 'text'">{{ segment.value }}</template>
        <sup v-else>
          <NuxtLink
            :to="specHref(segment.citation)"
            class="ml-0.5 inline-flex items-center rounded px-1 py-px align-super font-mono text-[11px] leading-none text-primary hover:bg-primary/10 hover:underline"
            :aria-label="`Citation ${segment.citation.index}: ${segment.citation.code} in ${segment.citation.featureName}`"
          >{{ segment.citation.code }}</NuxtLink>
        </sup>
      </template>
    </p>

    <!-- The one quiet way out of a refusal: the spec itself. -->
    <p v-if="refused" class="text-sm text-dimmed">
      The spec only holds what the analysis found.
      <NuxtLink :to="`/projects/${projectId}/spec`" class="text-primary hover:underline">Browse the product spec</NuxtLink>
      to see what is mapped.
    </p>
  </div>
</template>

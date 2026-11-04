<script setup lang="ts">
import type { ReleaseListItem } from '#shared/types'

/**
 * One release in the changes timeline: title, category, authors and the
 * revision counts as quiet chips ("2 new · 1 changed"), with a subtle
 * marker on highlighted releases. The whole card links to the release
 * detail. Avatars are functional initials (DESIGN.md) with the full name
 * in their tooltip.
 */

const props = defineProps<{ release: ReleaseListItem, projectId: string | number }>()

const detailHref = computed(() => `/projects/${props.projectId}/changes/${props.release.id}`)

const countsText = computed(() => {
  return (['new', 'changed', 'gone', 'fixed'] as const)
    .filter((kind) => props.release.counts[kind] > 0)
    .map((kind) => `${props.release.counts[kind]} ${kind}`)
    .join(' · ')
})
</script>

<template>
  <NuxtLink
    :to="detailHref"
    class="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary"
  >
    <UCard class="transition-colors hover:bg-elevated">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <UBadge
          v-if="release.highlight"
          color="primary"
          variant="subtle"
          icon="i-lucide-star"
          label="Highlight"
          size="sm"
        />
        <span class="font-medium text-highlighted">{{ release.title }}</span>
        <UBadge color="neutral" variant="subtle" size="sm" :label="release.category" />
        <span v-if="countsText" class="text-sm text-muted">{{ countsText }}</span>

        <span class="ms-auto flex items-center gap-1" aria-label="Authors">
          <UTooltip v-for="author in release.authors" :key="author" :text="author">
            <UAvatar :text="authorInitials(author)" :alt="author" size="2xs" color="neutral" />
          </UTooltip>
        </span>
      </div>
    </UCard>
  </NuxtLink>
</template>

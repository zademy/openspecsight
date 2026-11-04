<script setup lang="ts">
import type { RevisionKind } from '#shared/types'

/**
 * One release: header with title, summary and metadata (date, sha, authors,
 * category, highlight), then the revisions grouped by kind — only non-empty
 * sections render. Rows link back into the spec (see RevisionSection).
 */

const route = useRoute()
const projectId = route.params.id as string
const releaseId = route.params.releaseId as string

const { get } = useReleases()
const { data: release, error } = await useAsyncData(`release-${releaseId}`, () => get(releaseId))

if (error.value || !release.value) {
  throw createError({ statusCode: 404, statusMessage: 'Release not found', fatal: true })
}

/** Fixed display order of the revision sections. */
const SECTION_KINDS: RevisionKind[] = ['new', 'changed', 'gone', 'fixed']

const visibleSections = computed(() => SECTION_KINDS
  .filter((kind) => (release.value?.sections[kind].length ?? 0) > 0)
  .map((kind) => ({ kind, revisions: release.value!.sections[kind] })))
</script>

<template>
  <div v-if="release" class="space-y-6">
    <UButton
      label="All changes"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :to="`/projects/${projectId}/changes`"
    />

    <UPageHeader :title="release.title" :description="release.summary" />

    <div class="flex flex-wrap items-center gap-2">
      <UBadge
        v-if="release.highlight"
        color="primary"
        variant="subtle"
        icon="i-lucide-star"
        label="Highlight"
        size="sm"
      />
      <UBadge color="neutral" variant="subtle" size="sm" :label="release.category" />
      <span class="text-sm text-muted">{{ releaseDate(release.committedAt) }}</span>
      <span class="font-mono text-xs text-muted">{{ release.sha.slice(0, 7) }}</span>
      <span class="flex items-center gap-1" aria-label="Authors">
        <UTooltip v-for="author in release.authors" :key="author" :text="author">
          <UAvatar :text="authorInitials(author)" :alt="author" size="2xs" color="neutral" />
        </UTooltip>
      </span>
    </div>

    <div v-if="visibleSections.length > 0" class="space-y-8">
      <RevisionSection
        v-for="section in visibleSections"
        :key="section.kind"
        :project-id="projectId"
        :kind="section.kind"
        :revisions="section.revisions"
      />
    </div>

    <p v-else class="max-w-prose text-sm text-muted">
      This release carries no scenario revisions — the sync recorded the commit without changing the spec.
    </p>
  </div>
</template>

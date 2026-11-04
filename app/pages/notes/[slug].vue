<script setup lang="ts">
import type { PublicNote } from '#shared/types'

/**
 * The public release-note page: whatever the public API returned, rendered
 * through the shared ContentBlocks component on the bare public layout.
 * Unknown and unpublished slugs share one 404 — no page state hints at
 * whether a slug exists as a draft.
 */
const route = useRoute()
const slug = route.params.slug as string

// The bare public layout: wordmark header and footer line, no app chrome.
definePageMeta({ layout: 'public' })

const { data: note, error } = await useAsyncData(`public-note-${slug}`, () => $fetch<PublicNote>(`/api/notes/public/${slug}`))

if (error.value || !note.value) {
  throw createError({ statusCode: 404, statusMessage: 'Release note not found', fatal: true })
}

useHead({ title: note.value.title })
</script>

<template>
  <article v-if="note" class="space-y-6">
    <UPageHeader :title="note.title" :description="`Published ${releaseDate(note.publishedAt)}`" />
    <ContentBlocks :blocks="note.blocks" />
  </article>
</template>

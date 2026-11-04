<script setup lang="ts">
import type { FetchError } from 'ofetch'

/**
 * One release note, read-only: the stored blocks rendered through the
 * shared ContentBlocks component, the voice it was drafted in, and the
 * publish actions. Publish hands the note its public /notes/:slug address
 * (the button stays idempotent-safe); unpublish takes it back to draft.
 * Block editing arrives in a later task — this page only reads.
 */

const route = useRoute()
const projectId = route.params.id as string
const noteId = route.params.noteId as string

const { get, publish, unpublish } = useReleaseNotes()
const { data: note, error } = await useAsyncData(`release-note-${noteId}`, () => get(noteId))

if (error.value || !note.value) {
  throw createError({ statusCode: 404, statusMessage: 'Release note not found', fatal: true })
}

const working = ref(false)
const actionNote = ref('')

async function onPublish() {
  if (!note.value) {
    return
  }
  working.value = true
  actionNote.value = ''
  try {
    const result = await publish(noteId)
    note.value.slug = result.slug
    note.value.published = true
    note.value.publishedAt = new Date().toISOString()
  } catch (cause) {
    actionNote.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The note could not be published. Check the server log and try again.'
  } finally {
    working.value = false
  }
}

async function onUnpublish() {
  if (!note.value) {
    return
  }
  working.value = true
  actionNote.value = ''
  try {
    await unpublish(noteId)
    note.value.published = false
    note.value.publishedAt = null
  } catch (cause) {
    actionNote.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The note could not be returned to draft. Check the server log and try again.'
  } finally {
    working.value = false
  }
}

/** The shareable address of the published note, copied to the clipboard. */
async function copyPublicLink() {
  if (!note.value) {
    return
  }
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/notes/${note.value.slug}`)
    actionNote.value = 'The public link was copied.'
  } catch {
    actionNote.value = `The link could not be copied: /notes/${note.value.slug}`
  }
}
</script>

<template>
  <div v-if="note" class="space-y-6">
    <UButton
      label="All release notes"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :to="`/projects/${projectId}/release-notes`"
    />

    <UPageHeader :title="note.title" :description="rangeLabel(note.rangeFrom, note.rangeTo)" />

    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <UBadge
        v-if="note.published"
        color="success"
        variant="subtle"
        icon="i-lucide-globe"
        label="Published"
        size="sm"
      />
      <UBadge
        v-else
        color="neutral"
        variant="subtle"
        icon="i-lucide-pencil-line"
        label="Draft"
        size="sm"
      />
      <span class="text-sm text-muted">{{ note.voiceName ?? 'Default voice' }}</span>
      <span class="text-sm text-muted">created {{ releaseDate(note.createdAt) }}</span>
      <span v-if="note.publishedAt" class="text-sm text-muted">published {{ releaseDate(note.publishedAt) }}</span>
    </div>

    <div class="space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="!note.published"
          icon="i-lucide-globe"
          label="Publish"
          :loading="working"
          @click="onPublish"
        />
        <template v-else>
          <UButton
            icon="i-lucide-link"
            label="Copy public link"
            color="neutral"
            variant="outline"
            @click="copyPublicLink"
          />
          <UButton
            icon="i-lucide-pencil-line"
            label="Unpublish"
            color="neutral"
            variant="outline"
            :loading="working"
            @click="onUnpublish"
          />
        </template>
      </div>
      <p v-if="actionNote" class="text-sm text-muted" role="status">{{ actionNote }}</p>
    </div>

    <ContentBlocks :blocks="note.blocks" />
  </div>
</template>

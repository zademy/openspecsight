<script setup lang="ts">
/**
 * Project release notes: the stored drafts, newest first, with the
 * "New release note" entry point. Starting one answers 202 immediately —
 * the LLM drafting runs in a job — so this page polls its own list until
 * the note appears, and says so inline while it waits. The voices the
 * drafts can be written in are managed at the bottom of the page.
 */

const route = useRoute()
const projectId = route.params.id as string

const { list } = useReleaseNotes()
const { data: notes, refresh } = await useAsyncData(`release-notes-${projectId}`, () => list(projectId))

const summary = computed(() => {
  const list = notes.value ?? []
  if (list.length === 0) {
    return 'Drafted announcements of what shipped, publishable to a public page'
  }
  const published = list.filter((note) => note.published).length
  const noun = list.length === 1 ? 'note' : 'notes'
  if (published === 0) {
    return `${list.length} ${noun}, none published yet`
  }
  return `${list.length} ${noun}, ${published} of ${list.length} published`
})

// --- Drafting polling: no progress endpoint, the list is the progress. ---

const generating = ref(false)
const pollTimedOut = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_INTERVAL_MS = 800
// The note is LLM-drafted in a job — slower than a digest, so a longer leash.
const POLL_LIMIT_MS = 45_000

function newestNoteId(): number {
  return (notes.value ?? []).reduce((max, note) => Math.max(max, note.id), 0)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onUnmounted(stopPolling)

function onNoteStarted(): void {
  stopPolling()
  pollTimedOut.value = false
  const knownNewest = newestNoteId()
  const deadline = Date.now() + POLL_LIMIT_MS
  generating.value = true
  pollTimer = setInterval(() => {
    void (async () => {
      await refresh()
      if (newestNoteId() > knownNewest) {
        stopPolling()
        generating.value = false
      } else if (Date.now() > deadline) {
        stopPolling()
        generating.value = false
        pollTimedOut.value = true
      }
    })()
  }, POLL_INTERVAL_MS)
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <UPageHeader title="Release notes" :description="summary" />
      <NewReleaseNoteModal :project-id="projectId" @created="onNoteStarted" />
    </div>

    <div v-if="generating" class="max-w-md space-y-2" aria-live="polite">
      <p class="text-sm text-muted">Drafting the note…</p>
      <UProgress />
    </div>
    <p v-else-if="pollTimedOut" class="max-w-prose text-sm text-error" role="alert">
      The note has not appeared yet — its job may have failed. Check the server logs or try again.
    </p>

    <ul v-if="(notes ?? []).length > 0" class="space-y-2">
      <li
        v-for="note in notes"
        :key="note.id"
        class="rounded-lg border border-default p-4"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <NuxtLink
            :to="`/projects/${projectId}/release-notes/${note.id}`"
            class="text-sm font-medium text-highlighted hover:text-primary"
          >
            {{ note.title }}
          </NuxtLink>
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
        </div>
        <p class="mt-1 text-xs text-muted">
          {{ rangeLabel(note.rangeFrom, note.rangeTo) }} · created {{ releaseDate(note.createdAt) }}
        </p>
      </li>
    </ul>

    <UEmpty
      v-else-if="!generating"
      icon="i-lucide-notebook-pen"
      title="No release notes yet"
      description="A release note drafts what shipped for the people using the product, and publishes to a shareable page. Create the first one with New release note."
    />
    <!-- Client-only: the manager fetches in setup, and a server-side
         fetch would be discarded instead of serialized. -->
    <ClientOnly>
      <VoicesManager :project-id="projectId" />
    </ClientOnly>
  </div>
</template>

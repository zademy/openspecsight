<script setup lang="ts">
/**
 * Project digests: the stored weekly summaries, newest first, with the
 * "New digest" entry point. Starting one answers 202 immediately — there
 * is no analyses progress row to poll (digests are fast), so this page
 * polls its own list until a digest newer than the ones on screen
 * appears, and says so inline while it waits.
 */

const route = useRoute()
const projectId = route.params.id as string

const { list } = useDigests()
const { data: digests, refresh } = await useAsyncData(`digests-${projectId}`, () => list(projectId))

const summary = computed(() => {
  const count = (digests.value ?? []).length
  return count === 0
    ? 'Weekly summaries of what shipped'
    : `${count} ${count === 1 ? 'digest' : 'digests'} of this project's releases`
})

// --- Generation polling: no progress endpoint, the list is the progress. ---

const generating = ref(false)
const pollTimedOut = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_INTERVAL_MS = 800
const POLL_LIMIT_MS = 20_000

function newestDigestId(): number {
  return (digests.value ?? []).reduce((max, digest) => Math.max(max, digest.id), 0)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onUnmounted(stopPolling)

function onDigestStarted(): void {
  stopPolling()
  pollTimedOut.value = false
  const knownNewest = newestDigestId()
  const deadline = Date.now() + POLL_LIMIT_MS
  generating.value = true
  pollTimer = setInterval(() => {
    void (async () => {
      await refresh()
      if (newestDigestId() > knownNewest) {
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
      <UPageHeader title="Digests" :description="summary" />
      <NewDigestModal :project-id="projectId" @created="onDigestStarted" />
    </div>

    <div v-if="generating" class="max-w-md space-y-2" aria-live="polite">
      <p class="text-sm text-muted">Writing this week's digest…</p>
      <UProgress />
    </div>
    <p v-else-if="pollTimedOut" class="max-w-prose text-sm text-error" role="alert">
      The digest has not appeared yet — its job may have failed. Check the server logs or try again.
    </p>

    <ul v-if="(digests ?? []).length > 0" class="space-y-2">
      <li
        v-for="digest in digests"
        :key="digest.id"
        class="rounded-lg border border-default p-4"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <NuxtLink
            :to="`/projects/${projectId}/digests/${digest.id}`"
            class="text-sm font-medium text-highlighted hover:text-primary"
          >
            {{ digest.title }}
          </NuxtLink>
          <UBadge
            v-if="digest.emailedAt"
            color="success"
            variant="subtle"
            icon="i-lucide-mail-check"
            label="Emailed"
            size="sm"
          />
          <UBadge
            v-else
            color="neutral"
            variant="subtle"
            icon="i-lucide-mail"
            label="Not emailed"
            size="sm"
          />
        </div>
        <p class="mt-1 text-xs text-muted">
          {{ rangeLabel(digest.rangeFrom, digest.rangeTo) }} · created {{ releaseDate(digest.createdAt) }}
        </p>
      </li>
    </ul>

    <UEmpty
      v-else-if="!generating"
      icon="i-lucide-mail"
      title="No digests yet"
      description="A digest wraps one week of releases into a short summary you can email. Create the first one with New digest."
    />
  </div>
</template>

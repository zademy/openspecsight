<script setup lang="ts">
import type { FetchError } from 'ofetch'

/**
 * Project overview: repo info, analysis progress/stats, the releases
 * timeline with the ask-bar preview. The section rail lives in the
 * project shell (pages/projects/[id].vue); this page only renders the
 * overview section.
 */

const route = useRoute()
const projectId = route.params.id as string

const { get, remove } = useProjects()
const { latest, start, sync } = useAnalyses()
const { data: project, error } = await useAsyncData(`project-${projectId}`, () => get(projectId))

if (error.value || !project.value) {
  throw createError({ statusCode: 404, statusMessage: 'Project not found', fatal: true })
}

const { data: analysis } = await useAsyncData(`analysis-${projectId}`, () => latest(projectId))
const { list } = useReleases()
const { data: releaseDays } = await useAsyncData(`releases-${projectId}`, () => list(projectId))

const analysisActive = computed(() => analysis.value?.status === 'queued' || analysis.value?.status === 'running')
// Poll until a terminal state: a page loaded before the analysis was started
// sees `null` first and must still pick up the run once it appears.
const shouldPoll = computed(() => analysis.value?.status !== 'done' && analysis.value?.status !== 'error')

// Operators can only start what has not happened yet: the first scan on a
// fresh project (or a retry after an error), and a sync once a spec exists —
// a failed sync leaves the spec intact, so it is retryable, while a failed
// analysis is not (start a fresh one).
const canRunAnalysis = computed(() => analysis.value === null || analysis.value.status === 'error')
const canSync = computed(() => {
  const specReady = analysis.value?.status === 'done'
    || (analysis.value?.type === 'sync' && analysis.value.status === 'error')
  return specReady && (project.value?.repositories.length ?? 0) > 0
})

/** Pipeline step → sentence the operator can act on; specific, not generic. */
const RUNNING_STEP_LABELS: Record<string, string> = {
  queued: 'Waiting for the analysis queue…',
  preparing: 'Preparing the scan…',
  tree: 'Mapping the repository tree…',
  blobs: 'Reading the repository…',
  inventory: 'Identifying features…',
  head: 'Checking the repository head…',
  diff: 'Diffing the new commits…',
  features: 'Revising the affected features…',
  apply: 'Recording the release…',
}

const stepLabel = computed(() => {
  const step = analysis.value?.step ?? ''
  const scenarios = /^scenarios \((\d+)\/(\d+)\)$/.exec(step)
  if (scenarios) {
    return `Writing the spec — feature ${scenarios[1]} of ${scenarios[2]}…`
  }
  return RUNNING_STEP_LABELS[step] ?? 'Working on the spec…'
})

const statsLabel = computed(() => {
  const stats = analysis.value?.stats
  if (!stats) {
    return ''
  }
  return [
    `${stats.features} ${stats.features === 1 ? 'feature' : 'features'}`,
    `${stats.scenarios} ${stats.scenarios === 1 ? 'scenario' : 'scenarios'}`,
    `${stats.files} ${stats.files === 1 ? 'file' : 'files'}`,
  ].join(' · ')
})

/** Terminal sentence names what actually ran: a scan or a sync. */
const doneLabel = computed(() => {
  if (analysis.value?.type === 'sync') {
    return analysis.value.step === 'up-to-date' ? 'Already up to date with the repository.' : 'Sync finished.'
  }
  return 'Initial analysis finished.'
})

const POLL_INTERVAL_MS = 2000
let pollTimer: ReturnType<typeof setInterval> | null = null
// Set while a sync runs; when the run lands, the release timeline refetches
// so the fresh release appears without a manual reload.
let pendingReleaseRefresh = false

async function pollLatest(): Promise<void> {
  try {
    analysis.value = await latest(projectId)
  } catch {
    // Keep the last known state; a transient failure resolves on the next tick.
  }
  if (!shouldPoll.value && pendingReleaseRefresh) {
    pendingReleaseRefresh = false
    await refreshNuxtData(`releases-${projectId}`)
  }
  if (!shouldPoll.value) {
    stopPolling()
  }
}

function startPolling(): void {
  if (import.meta.server || pollTimer !== null || !shouldPoll.value) {
    return
  }
  pollTimer = setInterval(() => {
    void pollLatest()
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

if (import.meta.client) {
  watch(shouldPoll, (poll) => {
    if (poll) {
      startPolling()
    } else {
      stopPolling()
    }
  }, { immediate: true })
  onBeforeUnmount(stopPolling)
}

const actionError = ref('')
const startingAnalysis = ref(false)
const syncing = ref(false)
const busy = computed(() => analysisActive.value || startingAnalysis.value || syncing.value)

async function onRunAnalysis(): Promise<void> {
  startingAnalysis.value = true
  actionError.value = ''
  try {
    await start(projectId)
    await pollLatest()
  } catch (cause) {
    actionError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The analysis could not be started. Try again.'
  } finally {
    startingAnalysis.value = false
  }
}

async function onSyncNow(): Promise<void> {
  syncing.value = true
  actionError.value = ''
  try {
    await sync(projectId)
    pendingReleaseRefresh = true
    await pollLatest()
  } catch (cause) {
    actionError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The sync could not be started. Try again.'
    pendingReleaseRefresh = false
  } finally {
    syncing.value = false
  }
}

const confirmingDelete = ref(false)
const deleting = ref(false)

async function onDelete() {
  deleting.value = true
  try {
    await remove(projectId)
    // Drop the deleted project from the home list cache before landing there.
    await refreshNuxtData('projects')
    await navigateTo('/')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div v-if="project" class="space-y-8">
    <UPageHeader
      :title="project.name"
      :description="project.description"
      :links="[{
        label: 'Delete project',
        color: 'error',
        variant: 'ghost',
        icon: 'i-lucide-trash-2',
        onClick: () => { confirmingDelete = true },
      }]"
    />

    <section aria-labelledby="ask-heading" class="space-y-3">
      <h2 id="ask-heading" class="text-sm font-medium uppercase tracking-wide text-muted">Ask</h2>
      <UTooltip text="Not wired up yet — the ask bar ships in the next milestone.">
        <!-- The trigger must be a plain element: Nuxt UI forwards the tooltip
             props onto the disabled input itself, which cannot receive hover
             events, and the tooltip would never open. -->
        <span class="block w-full max-w-md cursor-not-allowed">
          <UInput
            disabled
            icon="i-lucide-message-circle-question-mark"
            placeholder="Ask anything (coming next)"
            class="w-full"
            :ui="{ base: 'pointer-events-none' }"
            aria-label="Ask about this project (coming next)"
          />
        </span>
      </UTooltip>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-medium uppercase tracking-wide text-muted">Repositories</h2>
      <ul class="space-y-2">
        <li
          v-for="repo in project.repositories"
          :key="`${repo.owner}/${repo.repo}/${repo.branch}`"
          class="flex flex-wrap items-center gap-2"
        >
          <span class="font-mono text-sm text-highlighted">{{ repo.owner }}/{{ repo.repo }}</span>
          <UBadge color="neutral" variant="subtle" icon="i-lucide-git-branch" :label="repo.branch" class="font-mono text-xs" />
        </li>
      </ul>
    </section>

    <section class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 class="text-sm font-medium uppercase tracking-wide text-muted">Analysis</h2>
        <div class="flex flex-wrap items-center gap-2">
          <p v-if="actionError" class="text-sm text-error" role="alert">{{ actionError }}</p>
          <UButton
            v-if="canSync"
            label="Sync now"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-refresh-cw"
            :loading="syncing"
            :disabled="busy"
            @click="onSyncNow"
          />
          <UButton
            v-if="canRunAnalysis"
            label="Run analysis"
            size="sm"
            icon="i-lucide-play"
            :loading="startingAnalysis"
            :disabled="busy"
            @click="onRunAnalysis"
          />
        </div>
      </div>

      <div v-if="analysisActive" class="max-w-md space-y-2" aria-live="polite">
        <p class="text-sm text-muted">{{ stepLabel }}</p>
        <UProgress :model-value="analysis?.progress ?? 0" />
      </div>

      <div v-else-if="analysis?.status === 'done'" class="flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>{{ doneLabel }}</span>
        <UBadge v-if="analysis.stats" color="success" variant="subtle" :label="statsLabel" />
      </div>

      <p v-else-if="analysis?.status === 'error'" class="max-w-prose text-sm text-error">
        {{ analysis.error }}
      </p>

      <p v-else class="text-sm text-muted">
        No analysis has run yet. Once the first scan finishes, features and scenarios appear here.
      </p>
    </section>

    <section aria-labelledby="changes-heading" class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h2 id="changes-heading" class="text-sm font-medium uppercase tracking-wide text-muted">Recent changes</h2>
        <UButton
          label="All changes"
          color="neutral"
          variant="link"
          size="sm"
          trailing-icon="i-lucide-arrow-right"
          :to="`/projects/${projectId}/changes`"
        />
      </div>

      <div v-if="(releaseDays ?? []).length > 0" class="space-y-4">
        <section
          v-for="day in releaseDays"
          :key="day.date"
          :aria-label="`Releases from ${dayHeading(day.date)}`"
          class="space-y-2"
        >
          <h3 class="text-sm font-medium uppercase tracking-wide text-muted">{{ dayHeading(day.date) }}</h3>
          <ReleaseCard
            v-for="release in day.releases"
            :key="release.id"
            :release="release"
            :project-id="projectId"
          />
        </section>
      </div>

      <p v-else class="max-w-prose text-sm text-muted">
        No releases recorded yet. Once a sync runs after new commits land, the changes appear here grouped by day.
      </p>
    </section>

    <UModal
      v-model:open="confirmingDelete"
      title="Delete project?"
      :description="`This removes ${project.name} with its repositories, spec and history. This can't be undone.`"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="confirmingDelete = false" />
          <UButton label="Delete project" color="error" :loading="deleting" @click="onDelete" />
        </div>
      </template>
    </UModal>
  </div>
</template>

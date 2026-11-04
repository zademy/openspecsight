<script setup lang="ts">
/**
 * Project overview: repo info, analysis progress/stats. The section rail
 * lives in the project shell (pages/projects/[id].vue); this page only
 * renders the overview section.
 */

const route = useRoute()
const projectId = route.params.id as string

const { get, remove } = useProjects()
const { latest } = useAnalyses()
const { data: project, error } = await useAsyncData(`project-${projectId}`, () => get(projectId))

if (error.value || !project.value) {
  throw createError({ statusCode: 404, statusMessage: 'Project not found', fatal: true })
}

const { data: analysis } = await useAsyncData(`analysis-${projectId}`, () => latest(projectId))

const analysisActive = computed(() => analysis.value?.status === 'queued' || analysis.value?.status === 'running')
// Poll until a terminal state: a page loaded before the analysis was started
// sees `null` first and must still pick up the run once it appears.
const shouldPoll = computed(() => analysis.value?.status !== 'done' && analysis.value?.status !== 'error')

/** Pipeline step → sentence the operator can act on; specific, not generic. */
const RUNNING_STEP_LABELS: Record<string, string> = {
  queued: 'Waiting for the analysis queue…',
  preparing: 'Preparing the scan…',
  tree: 'Mapping the repository tree…',
  blobs: 'Reading the repository…',
  inventory: 'Identifying features…',
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

const POLL_INTERVAL_MS = 2000
let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollLatest(): Promise<void> {
  try {
    analysis.value = await latest(projectId)
  } catch {
    // Keep the last known state; a transient failure resolves on the next tick.
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
      <h2 class="text-sm font-medium uppercase tracking-wide text-muted">Analysis</h2>

      <div v-if="analysisActive" class="max-w-md space-y-2" aria-live="polite">
        <p class="text-sm text-muted">{{ stepLabel }}</p>
        <UProgress :model-value="analysis?.progress ?? 0" />
      </div>

      <div v-else-if="analysis?.status === 'done'" class="flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>Initial analysis finished.</span>
        <UBadge v-if="analysis.stats" color="success" variant="subtle" :label="statsLabel" />
      </div>

      <p v-else-if="analysis?.status === 'error'" class="max-w-prose text-sm text-error">
        {{ analysis.error }}
      </p>

      <p v-else class="text-sm text-muted">
        No analysis has run yet. Once the first scan finishes, features and scenarios appear here.
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

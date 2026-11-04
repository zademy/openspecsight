<script setup lang="ts">
import type { AnalysisStatus } from '#shared/types'

/**
 * Project overview: repo info plus the section rail. Changes and Product spec
 * are deliberate placeholders — later tasks replace the muted entries with
 * real sections.
 */

const route = useRoute()
const projectId = route.params.id as string

const { get, remove } = useProjects()
const { data: project, error } = await useAsyncData(`project-${projectId}`, () => get(projectId))

if (error.value || !project.value) {
  throw createError({ statusCode: 404, statusMessage: 'Project not found', fatal: true })
}

const ANALYSIS_STATUS_COLOR: Record<AnalysisStatus, 'neutral' | 'warning' | 'success' | 'error'> = {
  queued: 'neutral',
  running: 'warning',
  done: 'success',
  error: 'error',
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
  <div v-if="project" class="flex flex-col gap-6 sm:flex-row sm:gap-8">
    <nav class="flex gap-1 sm:w-40 sm:shrink-0 sm:flex-col" aria-label="Project sections">
      <span class="rounded-md bg-primary/10 px-2 py-1.5 text-sm font-medium text-primary">Overview</span>
      <span class="rounded-md px-2 py-1.5 text-sm text-muted">Changes</span>
      <span class="rounded-md px-2 py-1.5 text-sm text-muted">Product spec</span>
    </nav>

    <div class="min-w-0 flex-1 space-y-8">
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
        <p v-if="project.lastAnalysis" class="flex items-center gap-2 text-sm text-muted">
          Last analysis:
          <UBadge :color="ANALYSIS_STATUS_COLOR[project.lastAnalysis.status]" variant="subtle" :label="project.lastAnalysis.status" />
        </p>
        <p v-else class="text-sm text-muted">
          No analysis has run yet. Once the first scan finishes, features and scenarios appear here.
        </p>
      </section>
    </div>

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

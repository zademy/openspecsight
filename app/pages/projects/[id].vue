<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

/**
 * Project shell: the section rail plus the active section page (overview,
 * product spec, product map, changes). Real sections link; ask/digests stay
 * muted "coming soon" entries until their tasks land.
 */

const route = useRoute()
const projectId = route.params.id as string

const { get } = useProjects()
const { data: project, error } = await useAsyncData(`project-${projectId}`, () => get(projectId))

if (error.value || !project.value) {
  throw createError({ statusCode: 404, statusMessage: 'Project not found', fatal: true })
}

const items = computed<NavigationMenuItem[]>(() => [
  { label: 'Overview', to: `/projects/${projectId}`, active: route.path === `/projects/${projectId}` },
  { label: 'Product spec', to: `/projects/${projectId}/spec`, active: route.path.startsWith(`/projects/${projectId}/spec`) },
  { label: 'Product map', to: `/projects/${projectId}/map`, active: route.path.startsWith(`/projects/${projectId}/map`) },
  { label: 'Changes', to: `/projects/${projectId}/changes`, active: route.path.startsWith(`/projects/${projectId}/changes`) },
])

/** Sections that exist in the product vision but not in this build yet. */
const COMING_SOON = ['Ask', 'Digests']
</script>

<template>
  <div v-if="project" class="flex flex-col gap-6 sm:flex-row sm:gap-8">
    <nav class="sm:w-40 sm:shrink-0" aria-label="Project sections">
      <!-- Vertical at every width: a compact stacked list on phones, the
           rail column from sm up. -->
      <UNavigationMenu
        :items="items"
        orientation="vertical"
        variant="link"
      />

      <ul class="mt-4 flex flex-wrap gap-x-3 gap-y-1 sm:mt-6 sm:block sm:space-y-0.5">
        <li
          v-for="section in COMING_SOON"
          :key="section"
          class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-dimmed"
        >
          <span>{{ section }}</span>
          <span class="text-xs">soon</span>
        </li>
      </ul>
    </nav>

    <div class="min-w-0 flex-1">
      <NuxtPage />
    </div>
  </div>
</template>

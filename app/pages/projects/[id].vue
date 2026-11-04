<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

/**
 * Project shell: the section rail plus the active section page (overview,
 * product spec, product map, ask, changes, digests). Every section links.
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
  { label: 'Ask', to: `/projects/${projectId}/ask`, active: route.path.startsWith(`/projects/${projectId}/ask`) },
  { label: 'Changes', to: `/projects/${projectId}/changes`, active: route.path.startsWith(`/projects/${projectId}/changes`) },
  { label: 'Release notes', to: `/projects/${projectId}/release-notes`, active: route.path.startsWith(`/projects/${projectId}/release-notes`) },
  { label: 'Digests', to: `/projects/${projectId}/digests`, active: route.path.startsWith(`/projects/${projectId}/digests`) },
])
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
    </nav>

    <div class="min-w-0 flex-1">
      <NuxtPage />
    </div>
  </div>
</template>

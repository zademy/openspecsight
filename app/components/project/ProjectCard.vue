<script setup lang="ts">
import type { ProjectSummary } from '#shared/types'

defineProps<{ project: ProjectSummary }>()
</script>

<template>
  <NuxtLink
    :to="`/projects/${project.id}`"
    class="group block h-full rounded-lg focus-visible:outline-2 focus-visible:outline-primary"
  >
    <UCard class="h-full transition-colors group-hover:border-primary">
      <div class="space-y-2">
        <h3 class="font-semibold text-highlighted">{{ project.name }}</h3>
        <p v-if="project.description" class="line-clamp-2 text-sm text-muted">
          {{ project.description }}
        </p>
        <div class="flex flex-wrap gap-1.5">
          <UBadge
            v-for="repo in project.repositories"
            :key="`${repo.owner}/${repo.repo}`"
            color="neutral"
            variant="subtle"
            class="font-mono text-xs"
            :label="`${repo.owner}/${repo.repo}`"
          />
        </div>
      </div>
    </UCard>
  </NuxtLink>
</template>

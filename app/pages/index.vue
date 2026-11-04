<script setup lang="ts">
const { list } = useProjects()
const { data: projects, refresh } = await useAsyncData('projects', list)
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-8">
    <header class="space-y-2">
      <h1 class="text-2xl font-bold">OpenSpecSight</h1>
      <p class="max-w-2xl text-muted">
        Connect a GitHub repository and OpenSpecSight keeps your product spec alive:
        an LLM analysis generates features and scenarios, and manual syncs record what
        changed in every release.
      </p>
    </header>

    <section class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold">Projects</h2>
        <CreateProjectModal @created="refresh()" />
      </div>

      <ul v-if="projects?.length" class="grid gap-3 sm:grid-cols-2">
        <li v-for="project in projects" :key="project.id">
          <ProjectCard :project="project" />
        </li>
      </ul>

      <div v-else class="rounded-lg border border-default border-dashed p-8 text-center">
        <p class="font-medium text-highlighted">No projects yet</p>
        <p class="mt-1 text-sm text-muted">
          Create a project to connect a GitHub repository and generate its first spec.
        </p>
      </div>
    </section>
  </div>
</template>

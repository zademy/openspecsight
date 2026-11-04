<script setup lang="ts">
/**
 * Product spec index: the project's feature tree with scenario counts.
 * Before the first analysis the page explains where the spec comes from and
 * links back to the overview's run-analysis flow.
 */

const route = useRoute()
const projectId = route.params.id as string

const { featureTree } = useSpec()
const { data: features, error } = await useAsyncData(`features-${projectId}`, () => featureTree(projectId))

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: 'Project not found', fatal: true })
}

const featureCount = computed(() => features.value?.length ?? 0)
const scenarioCount = computed(() => (features.value ?? []).reduce((sum, feature) => sum + feature.scenarioCount, 0))

const summary = computed(() => featureCount.value === 0
  ? 'No features mapped yet'
  : `${featureCount.value} ${featureCount.value === 1 ? 'feature' : 'features'} · ${scenarioCount.value} ${scenarioCount.value === 1 ? 'scenario' : 'scenarios'}`)
</script>

<template>
  <div class="space-y-6">
    <UPageHeader title="Product spec" :description="summary" />

    <FeatureTree
      v-if="featureCount > 0"
      :project-id="projectId"
      :features="features ?? []"
    />

    <UEmpty
      v-else
      icon="i-lucide-file-search"
      title="No spec yet"
      description="This project has no analysis yet. Start the first scan from the overview to map the repository's features and scenarios."
      :actions="[{ label: 'Go to overview', color: 'neutral', to: `/projects/${projectId}` }]"
    />
  </div>
</template>

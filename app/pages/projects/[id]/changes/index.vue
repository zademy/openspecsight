<script setup lang="ts">
import type { ReleaseSourceFilter } from '#shared/types'

/**
 * Project changes: every release the sync pipeline recorded, grouped by
 * day, filterable by source (all/ai/manual), feature and a title/summary
 * search. Filters run server-side through the releases API.
 */

const route = useRoute()
const projectId = route.params.id as string

const { list } = useReleases()
const { featureTree } = useSpec()
const { data: features, error: featuresError } = await useAsyncData(`features-${projectId}`, () => featureTree(projectId))

if (featuresError.value) {
  throw createError({ statusCode: 404, statusMessage: 'Project not found', fatal: true })
}

const SOURCE_OPTIONS: Array<{ label: string, value: ReleaseSourceFilter }> = [
  { label: 'All sources', value: 'all' },
  { label: 'AI', value: 'ai' },
  { label: 'Manual', value: 'manual' },
]

const source = ref<ReleaseSourceFilter>('all')
const featureId = ref(0) // 0 = all features (USelect needs a concrete value)
const q = ref('')

const featureItems = computed(() => [
  { label: 'All features', value: 0 },
  ...(features.value ?? []).flatMap((node) => [
    { label: node.name, value: node.id },
    ...node.children.map((child) => ({ label: `${node.name} / ${child.name}`, value: child.id })),
  ]),
])

const { data: days, refresh } = await useAsyncData(
  `releases-${projectId}`,
  () => list(projectId, {
    source: source.value,
    featureId: featureId.value || undefined,
    q: q.value.trim() || undefined,
  }),
)

watch([source, featureId, q], () => {
  void refresh()
})

const releaseCount = computed(() => (days.value ?? []).reduce((sum, day) => sum + day.releases.length, 0))
const summary = computed(() => releaseCount.value === 0
  ? 'Changes recorded from repository syncs'
  : `${releaseCount.value} ${releaseCount.value === 1 ? 'release' : 'releases'} recorded from repository syncs`)

const filtersActive = computed(() => source.value !== 'all' || featureId.value !== 0 || q.value.trim() !== '')
</script>

<template>
  <div class="space-y-6">
    <UPageHeader title="Changes" :description="summary" />

    <div role="group" aria-label="Filter releases" class="flex flex-wrap items-center gap-2">
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="option in SOURCE_OPTIONS"
          :key="option.value"
          size="sm"
          :label="option.label"
          :color="source === option.value ? 'primary' : 'neutral'"
          :variant="source === option.value ? 'soft' : 'ghost'"
          :aria-pressed="source === option.value"
          @click="source = option.value"
        />
      </div>

      <USelect
        v-model="featureId"
        :items="featureItems"
        placeholder="All features"
        size="sm"
        class="w-44"
        aria-label="Filter by feature"
      />

      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search releases"
        size="sm"
        class="w-56"
        aria-label="Search releases by title or summary"
      />
    </div>

    <div v-if="(days ?? []).length > 0" class="space-y-6">
      <section
        v-for="day in days"
        :key="day.date"
        :aria-label="`Releases from ${dayHeading(day.date)}`"
        class="space-y-2"
      >
        <h2 class="text-sm font-medium uppercase tracking-wide text-muted">{{ dayHeading(day.date) }}</h2>
        <ReleaseCard
          v-for="release in day.releases"
          :key="release.id"
          :release="release"
          :project-id="projectId"
        />
      </section>
    </div>

    <UEmpty
      v-else-if="filtersActive"
      icon="i-lucide-search-x"
      title="No releases match"
      description="Nothing matches the current source, feature and search filters combined. Clear one of them to widen the list."
      :actions="[{ label: 'Clear filters', color: 'neutral', onClick: () => { source = 'all'; featureId = 0; q = '' } }]"
    />
    <UEmpty
      v-else
      icon="i-lucide-git-commit-horizontal"
      title="No releases yet"
      description="Releases appear after a sync records repository changes. Run a sync from the overview once new commits land."
    />
  </div>
</template>

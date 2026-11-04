<script setup lang="ts">
import type { FetchError } from 'ofetch'
import { humanizeConnectionType } from '#shared/connection-labels'

/**
 * Product map: the project's features as an interactive graph of typed
 * connections. The page chrome (header, search, legend, empty state) renders
 * on the server; the canvas itself is client-only below. With no stored
 * connections the page explains where a map comes from and offers to run
 * the analysis.
 */

const route = useRoute()
const projectId = route.params.id as string

const { map } = useMap()
const { data: mapData, error } = await useAsyncData(`map-${projectId}`, () => map(projectId))

if (error.value || !mapData.value) {
  throw createError({ statusCode: 404, statusMessage: 'Project not found', fatal: true })
}

const featureCount = computed(() => mapData.value?.nodes.length ?? 0)
const edgeCount = computed(() => mapData.value?.edges.length ?? 0)

const summary = computed(() => {
  return `${featureCount.value} ${featureCount.value === 1 ? 'feature' : 'features'} · ${edgeCount.value} ${edgeCount.value === 1 ? 'connection' : 'connections'}`
})

/** The legend lists exactly the connection types this map carries — nothing invented. */
const legendItems = computed(() => {
  const types = new Set((mapData.value?.edges ?? []).flatMap((edge) => edge.types))
  return [...types].sort().map(humanizeConnectionType)
})

const search = ref('')

function onOpen(featureId: number): void {
  void navigateTo(`/projects/${projectId}/spec/${featureId}`)
}

// Fullscreen is a CSS stage (fixed overlay), not the Fullscreen API: Esc
// exits through the same listener that the button's state drives.
const fullscreen = ref(false)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    fullscreen.value = false
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// The empty state reuses the overview's analysis trigger (useAnalyses.start)
// and hands over to the overview, which owns the live progress UI.
const { start } = useAnalyses()
const runningAnalysis = ref(false)
const runError = ref('')

async function onRunAnalysis(): Promise<void> {
  runningAnalysis.value = true
  runError.value = ''
  try {
    await start(projectId)
    await navigateTo(`/projects/${projectId}`)
  } catch (cause) {
    runError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The analysis could not be started. Try again.'
  } finally {
    runningAnalysis.value = false
  }
}
</script>

<template>
  <div v-if="mapData" class="space-y-6">
    <UPageHeader title="Product map" :description="summary" />

    <UEmpty
      v-if="mapData.empty"
      icon="i-lucide-waypoints"
      title="The map builds from the latest analysis"
      description="No connections between features have been recorded yet. Run the analysis and every link it finds is drawn here."
    >
      <template #actions>
        <div class="space-y-3">
          <p v-if="runError" role="alert" class="text-sm text-error">{{ runError }}</p>
          <UButton icon="i-lucide-play" label="Run analysis" :loading="runningAnalysis" @click="onRunAnalysis" />
        </div>
      </template>
    </UEmpty>

    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Search features"
          aria-label="Search features"
          class="w-full sm:w-64"
        />
        <UButton
          :icon="fullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'"
          :label="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
          color="neutral"
          variant="outline"
          @click="fullscreen = !fullscreen"
        />
      </div>

      <div class="map-stage relative h-[60vh] overflow-hidden rounded-lg border border-default sm:h-[480px]" :class="{ 'map-stage--fullscreen': fullscreen }">
        <ClientOnly>
          <ProductMapCanvas :data="mapData" :query="search" @open="onOpen" />
          <template #fallback>
            <div class="absolute inset-0 p-4">
              <USkeleton class="h-full w-full rounded-lg" />
            </div>
          </template>
        </ClientOnly>
      </div>

      <ul aria-label="Connection types" class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <li v-for="item in legendItems" :key="item" class="flex items-center gap-1.5">
          <span class="h-0.5 w-4 rounded-full bg-accented" aria-hidden="true" />{{ item }}
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
/* Fullscreen lifts the stage over the whole viewport; the canvas fills it
   because the stage keeps its inner layout. */
.map-stage--fullscreen {
  position: fixed;
  inset: 0;
  z-index: 50;
  height: auto;
  border: 0;
  border-radius: 0;
  background: var(--ui-bg);
}
</style>

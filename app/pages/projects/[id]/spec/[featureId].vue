<script setup lang="ts">
import type { ScenarioCategory, ScenarioDTO } from '#shared/types'

/**
 * One feature's spec: header with name and description, category filter,
 * scenario groups by context, and the operator dialogs — add and edit via
 * the scenario form, delete with a confirmation.
 */

const route = useRoute()
const featureId = route.params.featureId as string

const { featureDetail } = useSpec()
const { data: detail, error, refresh } = await useAsyncData(`feature-${featureId}`, () => featureDetail(featureId))

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: 'Feature not found', fatal: true })
}

type CategoryFilter = 'all' | ScenarioCategory

const FILTERS: Array<{ label: string, value: CategoryFilter, color: 'neutral' | 'success' | 'warning' | 'error' }> = [
  { label: 'All', value: 'all', color: 'neutral' },
  { label: 'Happy', value: 'happy', color: 'success' },
  { label: 'Edge', value: 'edge', color: 'warning' },
  { label: 'Error', value: 'error', color: 'error' },
]

const filter = ref<CategoryFilter>('all')

const filteredGroups = computed(() => (detail.value?.groups ?? [])
  .map((group) => ({
    ...group,
    scenarios: group.scenarios.filter((scenario) => filter.value === 'all' || scenario.category === filter.value),
  }))
  .filter((group) => group.scenarios.length > 0))

const filterLabel = computed(() => {
  if (filter.value === 'all') {
    return 'scenarios'
  }
  return `${filter.value} scenarios`
})

const creating = ref(false)

const editOpen = ref(false)
const editing = ref<ScenarioDTO | null>(null)

function startEdit(scenario: ScenarioDTO): void {
  editing.value = scenario
  editOpen.value = true
}

const confirmingDelete = ref<ScenarioDTO | null>(null)
const deleting = ref(false)

async function onDelete(): Promise<void> {
  const scenario = confirmingDelete.value
  if (!scenario) {
    return
  }
  deleting.value = true
  try {
    await useScenarios().remove(scenario.id)
    confirmingDelete.value = null
    await refresh()
  } finally {
    deleting.value = false
  }
}

/** Accordion open-state per context group; groups start expanded. */
const openGroups = ref<Record<string, string[]>>({})
for (const group of detail.value?.groups ?? []) {
  openGroups.value[group.context] = [group.context]
}

const SCENARIO_HASH = /^#scenario-(\d+)$/

/**
 * Deep-link ruling (Task 9 caveat): arriving with #scenario-<id> expands the
 * group containing that scenario, scrolls it into view and focuses it — the
 * row keeps the accent ring while focused so the landing is visible.
 */
async function revealHashScenario(): Promise<void> {
  const match = SCENARIO_HASH.exec(route.hash)
  const scenarioId = match ? Number(match[1]) : null
  const group = (detail.value?.groups ?? [])
    .find((candidate) => candidate.scenarios.some((scenario) => scenario.id === scenarioId))
  if (scenarioId === null || !group) {
    return
  }
  openGroups.value = { ...openGroups.value, [group.context]: [group.context] }
  await nextTick()
  const row = document.getElementById(`scenario-${scenarioId}`)
  row?.scrollIntoView({ block: 'center' })
  ;(row as HTMLElement | null)?.focus({ preventScroll: true })
}

onMounted(() => {
  void revealHashScenario()
})
</script>

<template>
  <div v-if="detail" class="space-y-6">
    <UButton
      label="Product spec"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :to="`/projects/${route.params.id}/spec`"
    />

    <UPageHeader
      :title="detail.feature.name"
      :description="detail.feature.description"
      :links="[{ label: 'Add scenario', icon: 'i-lucide-plus', onClick: () => { creating = true } }]"
    />

    <div role="group" aria-label="Filter scenarios by category" class="flex flex-wrap gap-1">
      <UButton
        v-for="option in FILTERS"
        :key="option.value"
        size="sm"
        :label="option.label"
        :color="filter === option.value ? option.color : 'neutral'"
        :variant="filter === option.value ? 'soft' : 'ghost'"
        :aria-pressed="filter === option.value"
        @click="filter = option.value"
      />
    </div>

    <div class="space-y-3">
      <ScenarioGroup
        v-for="group in filteredGroups"
        :key="group.context"
        v-model:open="openGroups[group.context]"
        :group="group"
        @edit="startEdit"
        @remove="confirmingDelete = $event"
      />

      <p v-if="filteredGroups.length === 0" class="max-w-prose text-sm text-muted">
        No {{ filterLabel }} in this feature yet. Pick another category or add a scenario.
      </p>
    </div>

    <ScenarioForm
      v-model:open="creating"
      :feature-id="featureId"
      @saved="() => refresh()"
    />

    <ScenarioForm
      v-model:open="editOpen"
      :feature-id="featureId"
      :scenario="editing"
      @saved="() => refresh()"
    />

    <UModal
      :open="confirmingDelete !== null"
      title="Delete scenario?"
      :description="`This removes scenario ${confirmingDelete?.code} from ${detail.feature.name}. Manual scenarios are not re-added by the next sync.`"
      @update:open="(open: boolean) => { if (!open) { confirmingDelete = null } }"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="confirmingDelete = null" />
          <UButton label="Delete scenario" color="error" :loading="deleting" @click="onDelete" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* Deep-link arrival: the revealed scenario row carries the accent ring while
   focused (:deep — the rows render inside ScenarioGroup). */
:deep(li[id^='scenario-']:focus) {
  outline: 2px solid var(--ui-primary);
  outline-offset: 6px;
  border-radius: 0.5rem;
}
</style>

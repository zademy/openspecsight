<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'
import type { ScenarioCategory, ScenarioDTO } from '#shared/types'

/**
 * One feature's spec: header with name and description, tabs for the
 * scenario groups and the flow diagram (tab state in the URL query so a
 * flow view is linkable), category filter, and the operator dialogs — add
 * and edit via the scenario form, delete with a confirmation, and
 * Apply/Dismiss on rows carrying a parked sync proposal.
 */

const route = useRoute()
const router = useRouter()
const featureId = route.params.featureId as string

const { featureDetail, featureFlow } = useSpec()
const { data: detail, error, refresh } = await useAsyncData(`feature-${featureId}`, () => featureDetail(featureId))

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: 'Feature not found', fatal: true })
}

// The flow never blocks the page: a 404 (feature predates the flow step of
// the analysis) just hides the Flow tab — nothing here is worth failing the
// read for.
const { data: flowData } = await useAsyncData(`flow-${featureId}`, async () => {
  try {
    return await featureFlow(featureId)
  } catch {
    return null
  }
})

type SpecTab = 'scenarios' | 'flow'

const tabItems = computed<TabsItem[]>(() => {
  const items: TabsItem[] = [{ label: 'Scenarios', value: 'scenarios' }]
  if (flowData.value) {
    items.push({ label: 'Flow diagram', value: 'flow' })
  }
  return items
})

const tab = computed({
  get: (): SpecTab => (route.query.tab === 'flow' ? 'flow' : 'scenarios'),
  set: (value: SpecTab) => {
    void router.push({ query: value === 'flow' ? { tab: 'flow' } : {}, hash: route.hash })
  },
})

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

/**
 * Decisions on parked sync proposals (design §6.3): applying overwrites the
 * row with the suggested text — confirm-free because it is reversible by
 * editing; dismissing just drops the badge. Both re-read the feature so the
 * badge and text land on the next render.
 */
const decidingProposal = ref(false)

async function onApplyProposal(scenario: ScenarioDTO): Promise<void> {
  if (scenario.proposalId === undefined) {
    return
  }
  decidingProposal.value = true
  try {
    await useScenarios().applyProposal(scenario.proposalId)
    await refresh()
  } finally {
    decidingProposal.value = false
  }
}

async function onDismissProposal(scenario: ScenarioDTO): Promise<void> {
  if (scenario.proposalId === undefined) {
    return
  }
  decidingProposal.value = true
  try {
    await useScenarios().dismissProposal(scenario.proposalId)
    await refresh()
  } finally {
    decidingProposal.value = false
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

// The flow diagram's scenario chips land here with tab + anchor in one
// router push after mount, so the Plan-1 reveal rides the hash change too —
// same expansion, scroll and focus as a fresh deep link.
watch(() => route.hash, (hash) => {
  if (hash && SCENARIO_HASH.test(hash)) {
    void revealHashScenario()
  }
})

function openScenario(scenarioId: number): void {
  // Leaving ?tab behind puts the Scenarios tab back; the hash drives the
  // reveal above.
  void router.push({ query: {}, hash: `#scenario-${scenarioId}` })
}
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

    <UTabs v-model="tab" :items="tabItems" :content="false" />

    <div v-if="tab === 'scenarios'" class="space-y-6">
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
          :deciding-proposal="decidingProposal"
          @edit="startEdit"
          @remove="confirmingDelete = $event"
          @apply-proposal="onApplyProposal"
          @dismiss-proposal="onDismissProposal"
        />

        <p v-if="filteredGroups.length === 0" class="max-w-prose text-sm text-muted">
          No {{ filterLabel }} in this feature yet. Pick another category or add a scenario.
        </p>
      </div>
    </div>

    <div v-else class="space-y-3">
      <template v-if="flowData">
        <div class="relative h-[420px] overflow-hidden rounded-lg border border-default sm:h-[480px]">
          <ClientOnly>
            <FlowDiagram :flow="flowData" @open-scenario="openScenario" />
            <template #fallback>
              <div class="absolute inset-0 p-4">
                <USkeleton class="h-full w-full rounded-lg" />
              </div>
            </template>
          </ClientOnly>
        </div>

        <ul aria-label="Node shapes" class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <li class="flex items-center gap-1.5">
            <span class="h-3.5 w-6 rounded-full border border-default bg-default" aria-hidden="true" />Start / end
          </li>
          <li class="flex items-center gap-1.5">
            <span class="h-3.5 w-6 rounded-[3px] border border-default bg-default" aria-hidden="true" />Step
          </li>
          <li class="flex items-center gap-1.5">
            <span class="h-2.5 w-2.5 rotate-45 rounded-[2px] border border-accented" aria-hidden="true" />Decision
          </li>
          <li class="flex items-center gap-1.5">
            <span class="h-3.5 w-6 rounded-[3px] border border-error/60 bg-error/5" aria-hidden="true" />Error path
          </li>
          <li class="flex items-center gap-1.5">
            <code class="rounded bg-elevated px-1 font-mono">HP-1</code>Scenario code — opens it in Scenarios
          </li>
        </ul>
      </template>

      <!-- Reachable only by URL: the tab strip above hides itself when no
           flow is stored, so an old ?tab=flow link still lands somewhere
           honest. -->
      <p v-else class="flex flex-wrap items-center gap-x-2 max-w-prose text-sm text-muted">
        This feature has no flow diagram yet — it appears once the analysis records one.
        <UButton label="Go to scenarios" color="neutral" variant="link" size="sm" class="px-0" @click="tab = 'scenarios'" />
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

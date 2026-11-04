<script setup lang="ts">
import type { ScenarioDTO, ScenarioGroupDTO } from '#shared/types'

/**
 * One context group rendered as an accordion section: the context is the
 * heading, the rows are the product's "context + action → outcome" motif —
 * action as the strong text, the arrow, then the outcome. Edit and delete
 * bubble up to the feature page, which owns the dialogs and the accordion
 * open-state (deep links expand their group, see [featureId].vue).
 */

/** Functional category colors (DESIGN.md): happy/edge/error, never decorative. */
const CATEGORY_COLORS = { happy: 'success', edge: 'warning', error: 'error' } as const

const props = defineProps<{ group: ScenarioGroupDTO }>()

const open = defineModel<string[]>('open', { required: true })

defineEmits<{ edit: [scenario: ScenarioDTO], remove: [scenario: ScenarioDTO] }>()

interface GroupItem {
  label: string
  value: string
  group: ScenarioGroupDTO
}

const accordionItems = computed<GroupItem[]>(() => [
  { label: props.group.context, value: props.group.context, group: props.group },
])
</script>

<template>
  <UAccordion
    v-model="open"
    type="multiple"
    :items="accordionItems"
  >
    <template #body="{ item }">
      <ol class="divide-y divide-default">
        <li
          v-for="scenario in (item as GroupItem).group.scenarios"
          :id="`scenario-${scenario.id}`"
          :key="scenario.id"
          class="py-4 first:pt-0 last:pb-0"
          :tabindex="-1"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-xs text-muted">{{ scenario.code }}</span>
            <UBadge :color="CATEGORY_COLORS[scenario.category]" variant="subtle" size="sm" :label="scenario.category" />
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
              :label="scenario.source === 'ai' ? 'AI' : 'manual'"
            />
            <span class="ms-auto flex gap-0.5">
              <UButton
                icon="i-lucide-pencil-line"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="`Edit ${scenario.code}`"
                @click="$emit('edit', scenario)"
              />
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="`Delete ${scenario.code}`"
                @click="$emit('remove', scenario)"
              />
            </span>
          </div>

          <p class="mt-1.5 max-w-prose text-sm leading-relaxed">
            <span class="font-medium text-highlighted">{{ scenario.action }}</span>
            <span class="px-1.5 text-dimmed" aria-hidden="true">→</span>
            <span class="text-muted">{{ scenario.outcome }}</span>
          </p>

          <AnnotationList :scenario-id="scenario.id" />
        </li>
      </ol>
    </template>
  </UAccordion>
</template>

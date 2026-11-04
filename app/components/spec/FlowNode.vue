<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { NodeProps } from '@vue-flow/core'

/**
 * One step of a feature's flow diagram. The kind is the shape: start and end
 * read as pills, steps as cards, decisions carry a rotated-square glyph (Vue
 * Flow ships no diamond node), and only `error` takes the semantic red
 * (DESIGN.md — color is functional, never decorative). A node carrying a
 * scenario code shows it in mono; when the code resolves to a live scenario
 * the chip is a real button and its click bubbles to the canvas, which
 * handles the jump back to the Scenarios tab.
 */

export interface FlowStepData {
  kind: 'start' | 'step' | 'decision' | 'error' | 'end'
  label: string
  scenarioCode?: string
  /** Set only when the code resolved to a live scenario of this feature. */
  scenarioId?: number
}

const props = defineProps<NodeProps<FlowStepData>>()

const isPill = computed(() => props.data?.kind === 'start' || props.data?.kind === 'end')
</script>

<template>
  <div
    class="flow-node flex items-center gap-2 border bg-default px-3 shadow-sm"
    :class="[
      isPill ? 'w-44 justify-center rounded-full py-1.5 text-center' : 'w-56 rounded-lg py-2',
      props.data?.kind === 'error' ? 'flow-node--error border-error/60 bg-error/5' : 'border-default',
      props.data?.scenarioId !== undefined ? 'flow-node--linked' : '',
    ]"
  >
    <span
      v-if="props.data?.kind === 'decision'"
      class="flow-node__diamond h-3 w-3 shrink-0 rounded-[2px] border-[1.5px] border-accented"
      aria-hidden="true"
    />
    <span
      class="min-w-0 flex-1 text-sm leading-snug"
      :class="props.data?.kind === 'error' ? 'text-error' : isPill ? 'text-muted' : 'text-highlighted'"
    >{{ props.data?.label }}</span>

    <button
      v-if="props.data?.scenarioId !== undefined && props.data?.scenarioCode"
      type="button"
      class="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-muted hover:text-primary"
      :aria-label="`Open scenario ${props.data.scenarioCode}`"
    >{{ props.data.scenarioCode }}</button>
    <span
      v-else-if="props.data?.scenarioCode"
      class="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-muted"
    >{{ props.data.scenarioCode }}</span>

    <Handle type="target" :position="Position.Top" class="flow-node__handle" />
    <Handle type="source" :position="Position.Bottom" class="flow-node__handle" />
  </div>
</template>

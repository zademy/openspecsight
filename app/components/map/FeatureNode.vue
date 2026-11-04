<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { NodeProps } from '@vue-flow/core'

/**
 * One feature on the product map: its name plus a scenario count chip.
 * Child features read as nested — a smaller card with a left accent — so
 * the hierarchy shows without a second layout pass. The handles stay
 * invisible: they exist so edges anchor at the card's sides, not as
 * decoration.
 */

export interface FeatureNodeData {
  featureId: number
  name: string
  scenarioCount: number
  isChild: boolean
}

const props = defineProps<NodeProps<FeatureNodeData>>()
</script>

<template>
  <div
    class="feature-node rounded-lg border border-default bg-default px-3 py-2 shadow-sm"
    :class="props.data?.isChild ? 'w-40 border-l-2 border-l-primary/60 py-1.5 pr-2.5 pl-2.5' : 'w-44'"
  >
    <div class="flex items-center gap-2">
      <span
        class="truncate text-sm"
        :class="props.data?.isChild ? 'text-muted' : 'font-medium text-highlighted'"
      >{{ props.data?.name }}</span>
      <span class="ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary tabular-nums">
        {{ props.data?.scenarioCount }}
      </span>
    </div>

    <Handle type="target" :position="Position.Left" class="feature-node__handle" />
    <Handle type="source" :position="Position.Right" class="feature-node__handle" />
  </div>
</template>

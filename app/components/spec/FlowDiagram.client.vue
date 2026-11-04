<script setup lang="ts">
import { Background } from '@vue-flow/background'
import { Panel, VueFlow, useVueFlow } from '@vue-flow/core'
import type { NodeMouseEvent } from '@vue-flow/core'
import type { FeatureFlow, FlowGraph } from '#shared/types'
import FlowNode from './FlowNode.vue'
import type { FlowStepData } from './FlowNode.vue'

/**
 * The client-only flow canvas: one node per graph node, one labeled edge per
 * transition, laid out in BFS layers from the graph's roots — deterministic,
 * because the data carries no positions. Read-only by ruling: nodes cannot
 * be dragged or connected, zooming and panning stay on. A click on a node
 * that resolved to a live scenario bubbles up as `openScenario`; the page
 * owns the jump back to the Scenarios tab.
 */

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

const props = defineProps<{ flow: FeatureFlow }>()

const emit = defineEmits<{ openScenario: [scenarioId: number] }>()

// Layer rows with a fixed column step — small constants duplicated from the
// map canvas on purpose (no shared layout abstraction for two graphs).
const X_GAP = 240
const Y_GAP = 110

interface FlowStep {
  id: string
  type: 'flowStep'
  position: { x: number, y: number }
  data: FlowStepData
}

interface FlowTransition {
  id: string
  source: string
  target: string
  label?: string
  labelShowBg: boolean
  labelBgPadding: [number, number]
  labelBgBorderRadius: number
  type: 'smoothstep'
}

/**
 * BFS layering from every node without incoming edges (the start, usually),
 * back-edges ("retry" loops) ignored as already-layered. Nodes no walk
 * reaches — pure cycles — land below the deepest layer so nothing vanishes.
 */
function layerGraph(graph: FlowGraph): Map<string, number> {
  const outgoing = new Map<string, string[]>()
  const hasIncoming = new Set<string>()
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
    hasIncoming.add(edge.to)
  }

  const layers = new Map<string, number>()
  const queue: string[] = []
  for (const node of graph.nodes) {
    if (!hasIncoming.has(node.id)) {
      layers.set(node.id, 0)
      queue.push(node.id)
    }
  }
  if (queue.length === 0 && graph.nodes[0]) {
    layers.set(graph.nodes[0].id, 0)
    queue.push(graph.nodes[0].id)
  }

  let deepest = 0
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]
    if (id === undefined) {
      break
    }
    const layer = layers.get(id) ?? 0
    deepest = Math.max(deepest, layer)
    for (const next of outgoing.get(id) ?? []) {
      if (!layers.has(next)) {
        layers.set(next, layer + 1)
        queue.push(next)
      }
    }
  }
  for (const node of graph.nodes) {
    if (!layers.has(node.id)) {
      deepest += 1
      layers.set(node.id, deepest)
    }
  }
  return layers
}

function buildNodes(flow: FeatureFlow): FlowStep[] {
  const layers = layerGraph(flow.graph)
  const idByCode = new Map(flow.scenarioLinks.map((link) => [link.scenarioCode, link.scenarioId]))
  const columns = new Map<number, number>()
  return flow.graph.nodes.map((node): FlowStep => {
    const layer = layers.get(node.id) ?? 0
    const column = columns.get(layer) ?? 0
    columns.set(layer, column + 1)
    return {
      id: node.id,
      type: 'flowStep',
      position: { x: column * X_GAP, y: layer * Y_GAP },
      data: {
        kind: node.kind,
        label: node.label,
        scenarioCode: node.scenarioCode,
        scenarioId: node.scenarioCode === undefined ? undefined : idByCode.get(node.scenarioCode),
      },
    }
  })
}

function buildEdges(graph: FlowGraph): FlowTransition[] {
  return graph.edges.map((edge, index): FlowTransition => ({
    id: `${index}-${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    labelShowBg: true,
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
    type: 'smoothstep',
  }))
}

// Static initial state: the flow arrives once with the page, so the graph is
// built a single time and nothing mutates it afterwards (no drag, no reset).
const initialNodes = buildNodes(props.flow)
const initialEdges = buildEdges(props.flow.graph)

const nodeTypes = { flowStep: markRaw(FlowNode) }

const { zoomIn, zoomOut, fitView } = useVueFlow()

function onNodeClick({ node }: NodeMouseEvent): void {
  const scenarioId = (node.data as FlowStepData).scenarioId
  if (scenarioId !== undefined) {
    emit('openScenario', scenarioId)
  }
}
</script>

<template>
  <!-- The default min-zoom floor cannot fit a tall flow graph into the
       stage — fit-view would clip the trailing nodes. -->
  <VueFlow
    class="flow-canvas h-full w-full"
    :nodes="initialNodes"
    :edges="initialEdges"
    :node-types="nodeTypes"
    :nodes-draggable="false"
    :nodes-connectable="false"
    :elements-selectable="false"
    :min-zoom="0.2"
    fit-view-on-init
    @node-click="onNodeClick"
  >
    <Background :size="2" :gap="24" pattern-color="var(--ui-border-accented)" />

    <!-- Zoom only — the layout never changes, so there is nothing to reset. -->
    <Panel position="top-right" class="hidden flex-col gap-1 sm:flex">
      <UButton icon="i-lucide-plus" aria-label="Zoom in" color="neutral" variant="solid" size="xs" @click="() => zoomIn()" />
      <UButton icon="i-lucide-minus" aria-label="Zoom out" color="neutral" variant="solid" size="xs" @click="() => zoomOut()" />
      <UButton icon="i-lucide-focus" aria-label="Fit to view" color="neutral" variant="solid" size="xs" @click="() => fitView({ duration: 150 })" />
    </Panel>
  </VueFlow>
</template>

<style scoped>
/* Transitions are plain connectors; the branch labels ("yes"/"no") carry
   the meaning, so they stay visible instead of hiding until hover. */
.flow-canvas :deep(.vue-flow__edge-path) {
  stroke: var(--ui-border-accented);
}
.flow-canvas :deep(.vue-flow__edge-text) {
  fill: var(--ui-text);
  font-size: 11px;
}
.flow-canvas :deep(.vue-flow__edge-textbg) {
  fill: var(--ui-bg);
}

/* Only nodes with a live scenario link invite the click. */
.flow-canvas :deep(.flow-node--linked) {
  cursor: pointer;
}

/* The handles exist only to anchor edges — never visible, never clickable. */
.flow-canvas :deep(.flow-node__handle) {
  width: 1px;
  height: 1px;
  min-width: 0;
  min-height: 0;
  border: 0;
  background: transparent;
  opacity: 0;
  pointer-events: none;
}
</style>

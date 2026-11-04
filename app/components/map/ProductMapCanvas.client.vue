<script setup lang="ts">
import { Background } from '@vue-flow/background'
import { Panel, VueFlow, useVueFlow } from '@vue-flow/core'
import type { GraphNode, NodeMouseEvent } from '@vue-flow/core'
import type { MapData, MapNode } from '#shared/types'
import { humanizedTypeList } from '#shared/connection-labels'
import FeatureNode from './FeatureNode.vue'
import type { FeatureNodeData } from './FeatureNode.vue'

/**
 * The client-only map canvas: Vue Flow draws one node per feature and one
 * collapsed, undirected edge per connection pair (the API canonicalizes
 * direction, so nothing here guesses it). Hover and search states are
 * class-based — hovering a feature raises its edges while the rest dim, a
 * search query raises matching features — applied by patching the graph
 * store's class fields so user-dragged node positions survive both.
 */

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

const props = defineProps<{ data: MapData, query: string }>()

const emit = defineEmits<{ open: [featureId: number] }>()

// Rows: top-level features above, children below. The API orders nodes by
// feature sort order and marks children with isChild (no parent id), so the
// layout stays deterministic without inventing hierarchy the data doesn't
// carry.
const PARENT_ROW_Y = 0
const CHILD_ROW_Y = 190
const COLUMN_WIDTH = 250

interface FlowNode {
  id: string
  type: 'feature'
  position: { x: number, y: number }
  data: FeatureNodeData
  class: string
}

function buildNodes(data: MapData): FlowNode[] {
  let parentX = 0
  let childX = COLUMN_WIDTH / 2
  return data.nodes.map((node: MapNode): FlowNode => {
    if (node.isChild) {
      const flowNode: FlowNode = {
        id: `feature-${node.featureId}`,
        type: 'feature',
        position: { x: childX, y: CHILD_ROW_Y },
        data: { featureId: node.featureId, name: node.name, scenarioCount: node.scenarioCount, isChild: true },
        class: '',
      }
      childX += COLUMN_WIDTH
      return flowNode
    }
    const flowNode: FlowNode = {
      id: `feature-${node.featureId}`,
      type: 'feature',
      position: { x: parentX, y: PARENT_ROW_Y },
      data: { featureId: node.featureId, name: node.name, scenarioCount: node.scenarioCount, isChild: false },
      class: '',
    }
    parentX += COLUMN_WIDTH
    return flowNode
  })
}

interface FlowEdge {
  id: string
  source: string
  target: string
  label: string
  labelShowBg: boolean
  labelBgPadding: [number, number]
  labelBgBorderRadius: number
  class: string
}

function buildEdges(data: MapData): FlowEdge[] {
  return data.edges.map((edge) => ({
    id: `${edge.from}-${edge.to}`,
    source: `feature-${edge.from}`,
    target: `feature-${edge.to}`,
    label: humanizedTypeList(edge.types),
    labelShowBg: true,
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
    class: '',
  }))
}

// Static initial state: the map data arrives once with the page, so the
// graph is built a single time and everything after (hover, search, reset)
// goes through the store.
const initialNodes = buildNodes(props.data)
const initialEdges = buildEdges(props.data)

const nodeTypes = { feature: markRaw(FeatureNode) }

const { getNodes, getEdges, setNodes, zoomIn, zoomOut, fitView } = useVueFlow()

const hoveredId = ref<string | null>(null)
const normalizedQuery = computed(() => props.query.trim().toLowerCase())

function isMatch(node: GraphNode): boolean {
  return (node.data as FeatureNodeData).name.toLowerCase().includes(normalizedQuery.value)
}

function nodeFor(id: string): GraphNode | undefined {
  return getNodes.value.find((node) => node.id === id)
}

// One pass over the store per state change: search classes on nodes, hover
// and search classes on edges (hover wins — it is the tighter intent).
watchEffect(() => {
  const searching = normalizedQuery.value.length > 0
  for (const node of getNodes.value) {
    node.class = searching ? (isMatch(node) ? 'map-node--match' : 'map-node--dimmed') : ''
  }
  for (const edge of getEdges.value) {
    if (hoveredId.value) {
      const touches = edge.source === hoveredId.value || edge.target === hoveredId.value
      edge.class = touches ? 'map-edge--active' : 'map-edge--dimmed'
    } else if (searching) {
      const source = nodeFor(edge.source)
      const target = nodeFor(edge.target)
      edge.class = source && target && isMatch(source) && isMatch(target) ? 'map-edge--active' : 'map-edge--dimmed'
    } else {
      edge.class = ''
    }
  }
})

function onNodeHover({ node }: NodeMouseEvent): void {
  hoveredId.value = node.id
}

function onNodeLeave(): void {
  hoveredId.value = null
}

function onNodeClick({ node }: NodeMouseEvent): void {
  emit('open', (node.data as FeatureNodeData).featureId)
}

async function onZoomIn(): Promise<void> {
  await zoomIn()
}

async function onZoomOut(): Promise<void> {
  await zoomOut()
}

async function onFit(): Promise<void> {
  await fitView({ duration: 150 })
}

/** Reset restores the original layout (dragging is welcome, but undoable). */
async function onReset(): Promise<void> {
  setNodes(buildNodes(props.data))
  await fitView({ duration: 150 })
}
</script>

<template>
  <!-- The default min-zoom floor (0.5) cannot zoom a wide feature graph
       into a phone-sized canvas — fit-view would clip trailing nodes. -->
  <VueFlow
    class="map-canvas h-full w-full"
    :nodes="initialNodes"
    :edges="initialEdges"
    :node-types="nodeTypes"
    :nodes-connectable="false"
    :min-zoom="0.2"
    fit-view-on-init
    @node-click="onNodeClick"
    @node-mouse-enter="onNodeHover"
    @node-mouse-leave="onNodeLeave"
  >
    <Background :size="2" :gap="24" pattern-color="var(--ui-border-accented)" />

    <!-- The corner stack only earns its ~100px of canvas from sm up; touch
         users pinch and scroll to zoom (Vue Flow defaults). -->
    <Panel position="top-right" class="hidden flex-col gap-1 sm:flex">
      <UButton icon="i-lucide-plus" aria-label="Zoom in" color="neutral" variant="solid" size="xs" @click="onZoomIn" />
      <UButton icon="i-lucide-minus" aria-label="Zoom out" color="neutral" variant="solid" size="xs" @click="onZoomOut" />
      <UButton icon="i-lucide-focus" aria-label="Fit to view" color="neutral" variant="solid" size="xs" @click="onFit" />
      <UButton icon="i-lucide-rotate-ccw" aria-label="Reset layout" color="neutral" variant="solid" size="xs" @click="onReset" />
    </Panel>
  </VueFlow>
</template>

<style scoped>
/* Undirected edges carry no arrowheads; their type label only shows while
   the edge is hovered (both the painted path and Vue Flow's hover state
   count as hover). */
.map-canvas :deep(.vue-flow__edge) {
  transition: opacity 150ms ease;
}
.map-canvas :deep(.vue-flow__edge .vue-flow__edge-path) {
  stroke: var(--ui-border-accented);
}
.map-canvas :deep(.map-edge--active .vue-flow__edge-path) {
  stroke: var(--ui-primary);
  stroke-width: 2;
}
.map-canvas :deep(.map-edge--dimmed) {
  opacity: 0.15;
}
.map-canvas :deep(.vue-flow__edge .vue-flow__edge-text) {
  fill: var(--ui-text);
  font-size: 11px;
}
.map-canvas :deep(.vue-flow__edge .vue-flow__edge-textbg) {
  fill: var(--ui-bg);
}
.map-canvas :deep(.vue-flow__edge .vue-flow__edge-text),
.map-canvas :deep(.vue-flow__edge .vue-flow__edge-textbg) {
  opacity: 0;
  transition: opacity 150ms ease;
}
.map-canvas :deep(.vue-flow__edge:hover .vue-flow__edge-text),
.map-canvas :deep(.vue-flow__edge:hover .vue-flow__edge-textbg),
.map-canvas :deep(.vue-flow__edge.updating .vue-flow__edge-text),
.map-canvas :deep(.vue-flow__edge.updating .vue-flow__edge-textbg) {
  opacity: 1;
}

/* Search and hover states land on the node wrappers, so the transitions
   apply to whole cards; a match keeps its border primary-raised. */
.map-canvas :deep(.vue-flow__node) {
  transition: opacity 150ms ease;
}
.map-canvas :deep(.map-node--dimmed) {
  opacity: 0.35;
}
.map-canvas :deep(.map-node--match .feature-node) {
  border-color: var(--ui-primary);
}

/* The interaction band (a transparent stroke around each edge) needs a
   stroke value to be hoverable — `visibleStroke` ignores stroke: none. */
.map-canvas :deep(.vue-flow__edge-interaction) {
  stroke: transparent;
}

/* The handles exist only to anchor edges — never visible, never clickable. */
.map-canvas :deep(.feature-node__handle) {
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

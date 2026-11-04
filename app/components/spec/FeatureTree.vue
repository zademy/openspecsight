<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'
import type { FeatureNode } from '#shared/types'

/**
 * The feature tree as a Nuxt UI Tree: one entry per feature with its
 * scenario count trailing, parents expanded so a spec reads top to bottom.
 * Selecting an entry opens that feature's spec page.
 */

interface FeatureTreeItem extends TreeItem {
  value: string
  scenarioCount: number
  children?: FeatureTreeItem[]
}

const props = defineProps<{ projectId: string, features: FeatureNode[] }>()

const items = computed<FeatureTreeItem[]>(() => props.features.map((node) => toTreeItem(node)))

function toTreeItem(node: FeatureNode): FeatureTreeItem {
  return {
    label: node.name,
    value: String(node.id),
    scenarioCount: node.scenarioCount,
    defaultExpanded: true,
    children: node.children.length > 0 ? node.children.map(toTreeItem) : undefined,
    onSelect: () => {
      void navigateTo(`/projects/${props.projectId}/spec/${String(node.id)}`)
    },
  }
}
</script>

<template>
  <UTree :items="items">
    <template #item-trailing="{ item }">
      <UBadge color="neutral" variant="subtle" size="sm" class="font-normal text-muted">
        {{ (item as FeatureTreeItem).scenarioCount }} scenarios
      </UBadge>
    </template>
  </UTree>
</template>

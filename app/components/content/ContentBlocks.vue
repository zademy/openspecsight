<script setup lang="ts">
import type { ContentBlocks } from '#shared/types'

/**
 * Quiet typographic rendering of stored content blocks: h2 for headings,
 * paragraphs and lists as-is. Shared by the digest detail page and (from
 * Task 6) the public release-notes page, so one shape change restyles both.
 */
defineProps<{ blocks: ContentBlocks }>()
</script>

<template>
  <div class="space-y-4">
    <template v-for="(block, index) in blocks" :key="index">
      <h2 v-if="block.type === 'heading'" class="text-lg font-semibold text-highlighted">
        {{ block.text }}
      </h2>
      <p v-else-if="block.type === 'paragraph'" class="max-w-prose text-base leading-relaxed text-muted">
        {{ block.text }}
      </p>
      <ul v-else class="max-w-prose list-disc space-y-1 pl-5 text-base leading-relaxed text-muted">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          {{ item }}
        </li>
      </ul>
    </template>
  </div>
</template>

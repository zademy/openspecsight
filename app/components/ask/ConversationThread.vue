<script setup lang="ts">
import type { ConversationMessage } from '#shared/types'

/**
 * The ask thread as calm documentation blocks (DESIGN.md): each question is
 * a heading, each answer the prose under it with citation chips — a Q&A
 * page shape, never chat bubbles. A refusal is an answer nothing in the
 * spec grounded, i.e. one without citations; AnswerBlock gives it the
 * honest treatment.
 */

defineProps<{
  projectId: string | number
  messages: ConversationMessage[]
}>()
</script>

<template>
  <ol class="space-y-8">
    <li v-for="(message, position) in messages" :key="position">
      <h3 v-if="message.role === 'user'" class="max-w-prose text-sm font-medium text-highlighted">{{ message.content }}</h3>
      <template v-else>
        <p class="text-xs font-medium uppercase tracking-wide text-muted">Answer</p>
        <AnswerBlock
          class="mt-1.5"
          :project-id="projectId"
          :answer="message.content"
          :citations="message.citations"
          :refused="message.citations.length === 0"
        />
      </template>
    </li>
  </ol>
</template>

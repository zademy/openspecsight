<script setup lang="ts">
import type { FetchError } from 'ofetch'
import type { ConversationMessage } from '#shared/types'

/**
 * One conversation: the stored exchange as calm documentation blocks, an
 * input for follow-ups that append to the same conversation, and the
 * conversation list alongside.
 */

const route = useRoute()
const projectId = route.params.id as string
const conversationId = route.params.conversationId as string

const { conversation, ask } = useAsk()
const { data: detail, error } = await useAsyncData(
  `conversation-${projectId}-${conversationId}`,
  () => conversation(projectId, conversationId),
)

if (error.value || !detail.value) {
  throw createError({ statusCode: 404, statusMessage: 'Conversation not found', fatal: true })
}

const messages = ref<ConversationMessage[]>(detail.value.messages)
const question = ref('')
const asking = ref(false)
const askError = ref('')
const threadEnd = ref<HTMLElement | null>(null)

async function onFollowUp(): Promise<void> {
  const text = question.value.trim()
  if (!text || asking.value) {
    return
  }
  asking.value = true
  askError.value = ''
  question.value = ''
  try {
    const exchange = await ask(projectId, { question: text, conversationId: detail.value!.conversation.id })
    messages.value = [
      ...messages.value,
      { role: 'user', content: text, citations: [] },
      { role: 'assistant', content: exchange.answer, citations: exchange.citations },
    ]
    await nextTick()
    threadEnd.value?.scrollIntoView({ block: 'nearest' })
  } catch (cause) {
    askError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The answer could not be generated. Try again.'
  } finally {
    asking.value = false
  }
}
</script>

<template>
  <div v-if="detail" class="space-y-6">
    <UButton
      label="Ask"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :to="`/projects/${projectId}/ask`"
    />

    <div class="flex flex-col gap-8 lg:flex-row lg:gap-10">
      <div class="min-w-0 flex-1 space-y-6">
        <UPageHeader :title="detail.conversation.title" />

        <ConversationThread :project-id="projectId" :messages="messages" />

        <form class="flex max-w-md items-center gap-2" @submit.prevent="onFollowUp">
          <UInput
            v-model="question"
            placeholder="Ask a follow-up…"
            aria-label="Ask a follow-up question"
            class="w-full"
          />
          <UButton type="submit" label="Ask" :disabled="question.trim() === ''" :loading="asking" />
        </form>
        <p v-if="askError" role="alert" class="text-sm text-error">{{ askError }}</p>
        <div ref="threadEnd" aria-hidden="true" />
      </div>

      <aside class="lg:w-60 lg:shrink-0">
        <ConversationList :project-id="projectId" :current-id="detail.conversation.id" />
      </aside>
    </div>
  </div>
</template>

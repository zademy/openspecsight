<script setup lang="ts">
import type { FetchError } from 'ofetch'

/**
 * Ask hub: runs the question that arrived from the overview bar (`?q=`),
 * then hands the created conversation its own page. Without a question it
 * is the section's quiet entry: one input to start a conversation and the
 * list of the existing ones.
 */

const route = useRoute()
const router = useRouter()
const projectId = route.params.id as string

const { ask } = useAsk()

const question = ref('')
const asking = ref(false)
const askError = ref('')

/** Starts a conversation from a question, then replaces the URL with its page. */
async function runAsk(text: string): Promise<void> {
  asking.value = true
  askError.value = ''
  try {
    const exchange = await ask(projectId, { question: text })
    await router.replace(`/projects/${projectId}/ask/${exchange.conversationId}`)
  } catch (cause) {
    askError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The answer could not be generated. Try again.'
    asking.value = false
  }
}

// The overview bar lands here with ?q=; submitting this page's own input
// navigates to the same route with a new q, so the watcher covers both.
watch(() => route.query.q, (raw) => {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text) {
    void runAsk(text)
  }
}, { immediate: true })

function onSubmit(): void {
  const text = question.value.trim()
  if (!text || asking.value) {
    return
  }
  void router.push({ query: { q: text } })
  question.value = ''
}
</script>

<template>
  <div class="space-y-6">
    <UPageHeader
      title="Ask"
      description="Answers come only from this product's spec — every claim links to the scenario it cites."
    />

    <form class="flex max-w-md items-center gap-2" @submit.prevent="onSubmit">
      <UInput
        v-model="question"
        icon="i-lucide-message-circle-question-mark"
        placeholder="Ask about this product…"
        aria-label="Ask about this product"
        class="w-full"
      />
      <UButton type="submit" label="Ask" :disabled="question.trim() === ''" :loading="asking" />
    </form>
    <p v-if="asking" role="status" class="text-sm text-muted">Looking through the spec…</p>
    <p v-if="askError" role="alert" class="text-sm text-error">{{ askError }}</p>

    <ConversationList :project-id="projectId" />
  </div>
</template>

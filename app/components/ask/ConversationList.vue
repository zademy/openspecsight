<script setup lang="ts">
import type { FetchError } from 'ofetch'

/**
 * The ask sidebar: the project's conversations, newest first, with the date
 * for disambiguation and a per-item delete behind a confirm. The active
 * conversation is marked; deleting it navigates back to the ask index.
 */

const props = defineProps<{
  projectId: string | number
  /** The conversation currently open, if the page has one. */
  currentId?: number
}>()

const { conversations, remove } = useAsk()
const { data: list, refresh } = await useAsyncData(`conversations-${props.projectId}`, () => conversations(props.projectId))

// The cache is keyed per project, so a client-side navigation (ask index →
// conversation page) would replay the list as it was when the key was first
// filled — right after the overview bar created the conversation, that is an
// empty list. Re-fetch on mount keeps the sidebar at server truth.
onMounted(() => {
  void refresh()
})

const confirmingId = ref<number | null>(null)
const deleting = ref(false)
const deleteError = ref('')

const confirming = computed(() => (list.value ?? []).find((conversation) => conversation.id === confirmingId.value) ?? null)

async function onDelete(): Promise<void> {
  if (!confirming.value) {
    return
  }
  const target = confirming.value
  deleting.value = true
  deleteError.value = ''
  try {
    await remove(props.projectId, target.id)
    confirmingId.value = null
    if (target.id === props.currentId) {
      // The open page just lost its subject; the ask hub takes over.
      await navigateTo(`/projects/${props.projectId}/ask`)
    } else {
      await refresh()
    }
  } catch (cause) {
    deleteError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The conversation could not be deleted. Try again.'
  } finally {
    deleting.value = false
  }
}

function conversationDate(createdAt: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(createdAt))
}
</script>

<template>
  <nav aria-label="Conversations" class="space-y-1">
    <p class="px-2 text-xs font-medium uppercase tracking-wide text-muted">Conversations</p>

    <ul v-if="(list ?? []).length > 0" class="space-y-0.5">
      <li
        v-for="conversation in list"
        :key="conversation.id"
        class="group flex items-center justify-between gap-1 rounded-md px-2 py-1.5"
        :class="conversation.id === currentId ? 'bg-elevated' : 'hover:bg-elevated'"
      >
        <NuxtLink
          :to="`/projects/${projectId}/ask/${conversation.id}`"
          class="min-w-0 flex-1 rounded-sm"
          :aria-current="conversation.id === currentId ? 'page' : undefined"
        >
          <span class="block truncate text-sm" :class="conversation.id === currentId ? 'text-highlighted' : 'text-default'">{{ conversation.title }}</span>
          <span class="block text-xs text-dimmed">{{ conversationDate(conversation.createdAt) }}</span>
        </NuxtLink>
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="`Delete conversation: ${conversation.title}`"
          class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          @click="confirmingId = conversation.id; deleteError = ''"
        />
      </li>
    </ul>

    <p v-else class="px-2 text-sm text-dimmed">
      No conversations yet. Questions asked from the overview bar start one.
    </p>

    <UModal
      :open="confirmingId !== null"
      title="Delete conversation?"
      :description="confirming ? `This removes “${confirming.title}” with its messages. This can't be undone.` : ''"
      @update:open="(open: boolean) => { if (!open) confirmingId = null }"
    >
      <template #footer>
        <div class="w-full space-y-3">
          <p v-if="deleteError" role="alert" class="text-sm text-error">{{ deleteError }}</p>
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="confirmingId = null" />
            <UButton label="Delete conversation" color="error" :loading="deleting" @click="onDelete" />
          </div>
        </div>
      </template>
    </UModal>
  </nav>
</template>

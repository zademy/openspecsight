<script setup lang="ts">
import type { AnnotationDTO } from '#shared/types'

/**
 * The operator's notes on one scenario: a quiet "Notes" toggle opening a
 * short list plus an add input. Notes load on first expand — a spec page
 * with many rows should not fire a request per row up front.
 */

const props = defineProps<{ scenarioId: number }>()

const expanded = ref(false)
const loaded = ref(false)
const loading = ref(false)
const saving = ref(false)
const draft = ref('')
const notes = ref<AnnotationDTO[]>([])

async function load(): Promise<void> {
  loading.value = true
  try {
    notes.value = await useScenarios().annotations(props.scenarioId)
    loaded.value = true
  } finally {
    loading.value = false
  }
}

watch(expanded, (isOpen) => {
  if (isOpen && !loaded.value) {
    void load()
  }
})

async function submit(): Promise<void> {
  const body = draft.value.trim()
  if (!body) {
    return
  }
  saving.value = true
  try {
    notes.value.push(await useScenarios().addAnnotation(props.scenarioId, { body }))
    draft.value = ''
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mt-2">
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      :label="notes.length > 0 ? `Notes (${notes.length})` : 'Notes'"
      :aria-expanded="expanded"
      :aria-controls="`scenario-${props.scenarioId}-notes`"
      @click="expanded = !expanded"
    />

    <div
      v-if="expanded"
      :id="`scenario-${props.scenarioId}-notes`"
      class="mt-2 space-y-3 border-l border-default pl-3"
    >
      <ul v-if="notes.length > 0" class="space-y-2">
        <li v-for="note in notes" :key="note.id" class="text-sm">
          <p class="text-muted">{{ note.body }}</p>
          <p class="mt-0.5 text-xs text-dimmed">{{ note.author }} · {{ note.createdAt.slice(0, 10) }}</p>
        </li>
      </ul>
      <p v-else class="text-sm text-dimmed">No notes yet.</p>

      <form class="flex gap-2" @submit.prevent="submit">
        <label :for="`scenario-${props.scenarioId}-note-input`" class="sr-only">Add a note</label>
        <UInput
          :id="`scenario-${props.scenarioId}-note-input`"
          v-model="draft"
          size="sm"
          placeholder="Add a note…"
          class="min-w-0 flex-1"
          :disabled="saving"
        />
        <UButton
          type="submit"
          label="Add note"
          size="sm"
          color="neutral"
          variant="soft"
          :loading="saving"
          :disabled="!draft.trim()"
        />
      </form>
    </div>
  </div>
</template>

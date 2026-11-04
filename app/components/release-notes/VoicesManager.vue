<script setup lang="ts">
import type { FetchError } from 'ofetch'
import type { Voice } from '#shared/types'

/**
 * Voices manager: the small control under the notes list — name,
 * description and the default mark per voice, plus create, set-default
 * and delete. The first voice becomes the default; a fourth is refused,
 * so the form disables itself and says why. Deleting asks no confirmation
 * because nothing can break: notes using the voice fall back to the
 * default voice.
 */
const props = defineProps<{ projectId: string }>()

const VOICE_LIMIT = 3

const { list, create, setDefault, remove } = useVoices()
const voices = ref<Voice[] | null>(null)
const loading = ref(true)
const actionError = ref('')
const name = ref('')
const description = ref('')
const saving = ref(false)

const voicesFull = computed(() => (voices.value ?? []).length >= VOICE_LIMIT)

async function reload(): Promise<void> {
  try {
    voices.value = await list(props.projectId)
  } catch {
    voices.value = null
    actionError.value = 'The voices could not be loaded. Reload the page to try again.'
  } finally {
    loading.value = false
  }
}

void reload()

async function onCreate() {
  saving.value = true
  actionError.value = ''
  try {
    await create(props.projectId, { name: name.value.trim(), description: description.value.trim() })
    name.value = ''
    description.value = ''
    await reload()
  } catch (cause) {
    actionError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The voice could not be saved. Check the fields and try again.'
  } finally {
    saving.value = false
  }
}

async function onSetDefault(voice: Voice) {
  actionError.value = ''
  try {
    await setDefault(props.projectId, voice.id)
    await reload()
  } catch {
    actionError.value = `The default could not be moved to ${voice.name}. Try again.`
  }
}

async function onDelete(voice: Voice) {
  actionError.value = ''
  try {
    await remove(props.projectId, voice.id)
    await reload()
  } catch {
    actionError.value = `${voice.name} could not be deleted. Try again.`
  }
}
</script>

<template>
  <section class="rounded-lg border border-default p-4" aria-labelledby="voices-heading">
    <h2 id="voices-heading" class="text-sm font-medium text-highlighted">
      Voices
    </h2>
    <p class="mt-1 text-sm text-muted">
      A voice tells the drafting LLM how this project's notes should sound. A project keeps up to three.
    </p>

    <p v-if="loading" class="mt-3 text-sm text-muted" aria-live="polite">
      Loading the voices…
    </p>
    <ul v-else-if="(voices ?? []).length > 0" class="mt-3 space-y-3">
      <li
        v-for="voice in voices"
        :key="voice.id"
        class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="text-sm text-highlighted">{{ voice.name }}</span>
            <UBadge
              v-if="voice.isDefault"
              color="primary"
              variant="subtle"
              label="Default"
              size="sm"
            />
          </div>
          <p class="mt-0.5 text-xs text-muted">{{ voice.description }}</p>
        </div>
        <div class="flex items-center gap-1">
          <UButton
            v-if="!voice.isDefault"
            label="Set as default"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="onSetDefault(voice)"
          />
          <UButton
            label="Delete"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`Delete ${voice.name}; notes using it fall back to the default voice`"
            title="Notes using it fall back to the default voice"
            @click="onDelete(voice)"
          />
        </div>
      </li>
    </ul>
    <p v-else class="mt-3 text-sm text-muted">
      No voices yet. Drafts use the built-in default voice; add the first one below.
    </p>

    <form class="mt-4 grid gap-2 sm:grid-cols-2" @submit.prevent="onCreate">
      <UFormField name="voice-name" label="Name">
        <UInput v-model="name" :maxlength="80" placeholder="Changelog" class="w-full" />
      </UFormField>
      <UFormField name="voice-description" label="Description">
        <UInput v-model="description" :maxlength="1000" placeholder="Terse and factual, one line per change" class="w-full" />
      </UFormField>
      <div class="flex justify-end sm:col-span-2">
        <UButton
          label="Add voice"
          type="submit"
          :loading="saving"
          :disabled="voicesFull || name.trim() === '' || description.trim() === ''"
        />
      </div>
    </form>
    <p v-if="voicesFull" class="mt-2 text-xs text-muted">
      Three voices is the limit. Delete one to add another.
    </p>

    <p v-if="actionError" class="mt-2 text-sm text-error" role="alert">{{ actionError }}</p>
  </section>
</template>

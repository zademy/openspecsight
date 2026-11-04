<script setup lang="ts">
import type { FetchError } from 'ofetch'
import type { RevisionDTO, Voice } from '#shared/types'

/**
 * New-release-note dialog. The scope is either one release (dropdown) or a
 * committed-at date range (from/to); the voice stays "Default voice" unless
 * a configured one is picked. "Choose revisions" narrows the draft to a
 * checklist fetched for the scope in view. A server refusal (empty scope,
 * strangers in the selection, a note job already running) surfaces as a
 * sentence in the dialog, and a 202 hands control back to the list, which
 * polls until the note appears.
 */

const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ created: [] }>()

const open = ref(false)
const submitting = ref(false)
const error = ref('')

const scope = ref<'release' | 'range'>('release')
const releaseId = ref(0)
const rangeFrom = ref('')
const rangeTo = ref('')
const voiceId = ref(0) // 0 = Default voice (USelect needs a concrete value)

const { list: listReleases, get: getRelease } = useReleases()
const { list: listVoices } = useVoices()

const releaseItems = computed(() => (releases.value ?? [])
  .flatMap(day => day.releases)
  .map(release => ({ label: `${release.title} (${release.committedAt.slice(0, 10)})`, value: release.id })))

const voiceItems = computed(() => [
  { label: 'Default voice', value: 0 },
  ...(voices.value ?? []).map(voice => ({ label: voice.name, value: voice.id })),
])

const releases = ref<Awaited<ReturnType<typeof listReleases>> | null>(null)
const voices = ref<Voice[] | null>(null)

watch(open, async (isOpen) => {
  if (!isOpen) {
    return
  }
  error.value = ''
  scope.value = 'release'
  releaseId.value = 0
  rangeFrom.value = ''
  rangeTo.value = ''
  voiceId.value = 0
  checkedIds.value = []
  // Quiet preloads: the dropdowns stay empty with a plain sentence when the
  // project has no releases or voices to offer.
  voices.value = await listVoices(props.projectId).catch(() => [])
  releases.value = await listReleases(props.projectId).catch(() => [])
})

// --- Revision narrowing: the checklist is fetched for the scope in view ---

const chooseRevisions = ref(false)
const checkedIds = ref<number[]>([])
const revisionsLoading = ref(false)
const revisionsNote = ref('')
const revisions = ref<Array<RevisionDTO & { releaseId: number }> | null>(null)

async function loadRevisions(): Promise<void> {
  revisionsLoading.value = true
  revisionsNote.value = ''
  try {
    if (scope.value === 'release') {
      const detail = await getRelease(releaseId.value)
      revisions.value = Object.values(detail.sections).flat().map(revision => ({ ...revision, releaseId: detail.id }))
    } else {
      const days = (await listReleases(props.projectId))
        .filter(day => day.date >= rangeFrom.value && day.date <= rangeTo.value)
      const details = await Promise.all(days.flatMap(day => day.releases.map(release => getRelease(release.id))))
      revisions.value = details.flatMap(detail =>
        Object.values(detail.sections).flat().map(revision => ({ ...revision, releaseId: detail.id })),
      )
    }
    if ((revisions.value ?? []).length === 0) {
      revisionsNote.value = 'No revisions in this scope yet.'
    }
  } catch {
    revisions.value = null
    revisionsNote.value = 'The revisions for this scope could not be loaded.'
  } finally {
    revisionsLoading.value = false
  }
}

watch([chooseRevisions, scope, releaseId, rangeFrom, rangeTo], ([chosen]) => {
  // A new scope rebuilds the checklist, so the checked set cannot survive
  // it: ids from the old scope would leak into the draft.
  checkedIds.value = []
  if (!chosen) {
    revisions.value = null
    revisionsNote.value = ''
    return
  }
  const ready = scope.value === 'release' ? releaseId.value !== 0 : rangeFrom.value !== '' && rangeTo.value !== ''
  if (ready) {
    void loadRevisions()
  }
})

function toggleChecked(id: number, checked: boolean): void {
  checkedIds.value = checked
    ? [...checkedIds.value, id]
    : checkedIds.value.filter(known => known !== id)
}

async function onDraft() {
  submitting.value = true
  error.value = ''
  try {
    await useReleaseNotes().create(props.projectId, {
      ...(scope.value === 'release' ? { releaseId: releaseId.value } : { rangeFrom: rangeFrom.value, rangeTo: rangeTo.value }),
      ...(voiceId.value !== 0 ? { voiceId: voiceId.value } : {}),
      ...(chooseRevisions.value && checkedIds.value.length > 0 ? { revisionIds: checkedIds.value } : {}),
    })
    open.value = false
    emit('created')
  } catch (cause) {
    error.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The release note could not be started. Check the scope and try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="New release note"
    description="Pick a release or a date range. The draft covers the scenario revisions in scope."
  >
    <UButton icon="i-lucide-plus" label="New release note" />

    <template #body>
      <form class="space-y-4" @submit.prevent="onDraft">
        <fieldset class="space-y-3">
          <legend class="text-sm font-medium text-highlighted">Scope</legend>
          <URadioGroup
            v-model="scope"
            :items="[
              { label: 'Whole release', value: 'release' },
              { label: 'Date range', value: 'range' },
            ]"
            orientation="horizontal"
            aria-label="Draft scope"
          />

          <UFormField v-if="scope === 'release'" name="release" label="Release">
            <USelect
              v-model="releaseId"
              :items="releaseItems"
              placeholder="Choose a release"
              class="w-full"
              aria-label="Release"
            />
          </UFormField>

          <div v-else class="grid gap-4 sm:grid-cols-2">
            <UFormField name="from" label="From">
              <UInput v-model="rangeFrom" type="date" class="w-full" />
            </UFormField>
            <UFormField name="to" label="To">
              <UInput v-model="rangeTo" type="date" class="w-full" />
            </UFormField>
          </div>
        </fieldset>

        <UFormField name="voice" label="Voice">
          <USelect
            v-model="voiceId"
            :items="voiceItems"
            class="w-full"
            aria-label="Voice"
          />
        </UFormField>

        <div class="space-y-2">
          <UCheckbox v-model="chooseRevisions" label="Choose revisions" />
          <p v-if="revisionsLoading" class="text-sm text-muted" aria-live="polite">Loading the revisions in scope…</p>
          <p v-else-if="revisionsNote" class="text-sm text-muted">{{ revisionsNote }}</p>
          <ul v-else-if="revisions && revisions.length > 0" class="space-y-1">
            <li v-for="revision in revisions" :key="`${revision.releaseId}-${revision.id}`">
              <UCheckbox
                :model-value="checkedIds.includes(revision.id)"
                :label="`${revision.code} · ${revision.kind} · ${revision.action}`"
                @update:model-value="checked => toggleChecked(revision.id, checked === true)"
              />
            </li>
          </ul>
        </div>

        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 pt-1">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
          <UButton
            label="Draft note"
            icon="i-lucide-notebook-pen"
            type="submit"
            :loading="submitting"
            :disabled="scope === 'release' ? releaseId === 0 : rangeFrom === '' || rangeTo === ''"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>

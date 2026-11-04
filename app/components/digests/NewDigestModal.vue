<script setup lang="ts">
import type { FetchError } from 'ofetch'

/**
 * New-digest dialog. Opens with the shared default range prefilled: today
 * plus the seven days before it, the same defaults the server applies when
 * both fields arrive empty; clearing a field hands that end back to the
 * server default. A server rejection (empty range, digest already running)
 * surfaces as a sentence in the dialog, and a 202 hands control back to
 * the list, which polls until the digest appears.
 */

const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ created: [] }>()

const open = ref(false)
const submitting = ref(false)
const error = ref('')
const rangeFrom = ref('')
const rangeTo = ref('')

watch(open, (isOpen) => {
  if (isOpen) {
    const defaults = suggestedDigestRange()
    rangeFrom.value = defaults.rangeFrom
    rangeTo.value = defaults.rangeTo
    error.value = ''
  }
})

async function onCreate() {
  submitting.value = true
  error.value = ''
  try {
    await useDigests().create(props.projectId, {
      rangeFrom: rangeFrom.value || undefined,
      rangeTo: rangeTo.value || undefined,
    })
    open.value = false
    emit('created')
  } catch (cause) {
    error.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The digest could not be started. Check the dates and try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="New digest"
    description="Pick the range to summarize. It defaults to today plus the seven days before it."
  >
    <UButton icon="i-lucide-plus" label="New digest" />

    <template #body>
      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField name="from" label="From">
            <UInput v-model="rangeFrom" type="date" class="w-full" autofocus />
          </UFormField>

          <UFormField name="to" label="To">
            <UInput v-model="rangeTo" type="date" class="w-full" />
          </UFormField>
        </div>

        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 pt-1">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
          <UButton label="Create digest" :loading="submitting" @click="onCreate" />
        </div>
      </div>
    </template>
  </UModal>
</template>

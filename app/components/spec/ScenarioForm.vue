<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { CreateScenarioSchema, type CreateScenarioInput } from '#shared/schemas'
import type { ScenarioDTO } from '#shared/types'

/**
 * Add/edit scenario dialog. UForm validates against the same shape the API
 * enforces. In add mode it POSTs a manual scenario; in edit mode it starts
 * from the scenario's current values and PATCHes — the API flips the source
 * to manual, so the dialog says so.
 */

const props = defineProps<{ featureId: number | string, scenario?: ScenarioDTO | null }>()

const emit = defineEmits<{ saved: [scenario: ScenarioDTO] }>()

const open = defineModel<boolean>('open', { required: true })
const form = useTemplateRef('form')
const submitting = ref(false)
const saveError = ref('')
const state = reactive<CreateScenarioInput>({ context: '', action: '', outcome: '', category: 'happy' })

const CATEGORY_OPTIONS = [
  { label: 'Happy', value: 'happy' },
  { label: 'Edge', value: 'edge' },
  { label: 'Error', value: 'error' },
]

watch(open, (isOpen) => {
  if (isOpen) {
    Object.assign(state, props.scenario
      ? {
          context: props.scenario.context,
          action: props.scenario.action,
          outcome: props.scenario.outcome,
          category: props.scenario.category,
        }
      : { context: '', action: '', outcome: '', category: 'happy' })
    form.value?.clear()
    saveError.value = ''
  }
})

async function onSubmit(event: FormSubmitEvent<CreateScenarioInput>) {
  submitting.value = true
  saveError.value = ''
  try {
    const saved = props.scenario
      ? await useScenarios().update(props.scenario.id, event.data)
      : await useScenarios().create(props.featureId, event.data)
    open.value = false
    emit('saved', saved)
  } catch {
    saveError.value = 'The scenario could not be saved. Check the fields and try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="props.scenario ? `Edit ${props.scenario.code}` : 'Add scenario'"
    :description="props.scenario
      ? 'Edits mark the scenario as manual, so the next sync keeps your version.'
      : 'Written in the scenario shape: in this context, this action leads to this outcome.'"
  >
    <template #body>
      <UForm
        ref="form"
        :schema="CreateScenarioSchema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormField name="context" label="Context" required>
          <UInput v-model="state.context" placeholder="user on the login page" class="w-full" />
        </UFormField>

        <UFormField name="action" label="Action" required>
          <UTextarea v-model="state.action" :rows="2" placeholder="submit the login form with the correct password" class="w-full" />
        </UFormField>

        <UFormField name="outcome" label="Outcome" required>
          <UTextarea v-model="state.outcome" :rows="2" placeholder="the user lands on the tasks page" class="w-full" />
        </UFormField>

        <URadioGroup v-model="state.category" legend="Category" :items="CATEGORY_OPTIONS" orientation="horizontal" />

        <p v-if="saveError" class="text-sm text-error" role="alert">{{ saveError }}</p>

        <div class="flex justify-end gap-2 pt-1">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
          <UButton type="submit" :label="props.scenario ? 'Save changes' : 'Create scenario'" :loading="submitting" />
        </div>
      </UForm>
    </template>
  </UModal>
</template>

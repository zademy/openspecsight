<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import type { FetchError } from 'ofetch'
import { CreateProjectSchema, type CreateProjectInput } from '#shared/schemas'

/**
 * Create-project dialog. UForm validates against the shared zod schema, so
 * the browser and POST /api/projects enforce exactly the same shape. A server
 * rejection (unknown repository, GitHub unreachable) surfaces as a sentence
 * under the repository field.
 */

const emit = defineEmits<{ created: [] }>()

const emptyState: CreateProjectInput = { name: '', description: '', owner: '', repo: '', branch: undefined, pat: undefined }

const open = ref(false)
const form = useTemplateRef('form')
const submitting = ref(false)
const state = reactive<CreateProjectInput>({ ...emptyState })

watch(open, (isOpen) => {
  if (!isOpen) {
    Object.assign(state, { ...emptyState })
    form.value?.clear()
  }
})

async function onSubmit(event: FormSubmitEvent<CreateProjectInput>) {
  submitting.value = true
  try {
    await useProjects().create(event.data)
    open.value = false
    emit('created')
  } catch (error) {
    const message = (error as FetchError<{ message?: string }>).data?.message
      ?? 'The project could not be created. Check the repository and try again.'
    form.value?.setErrors([{ name: 'repo', message }])
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="New project" description="Connect a GitHub repository to keep its product spec here.">
    <UButton icon="i-lucide-plus" label="New project" />

    <template #body>
      <UForm
        ref="form"
        :schema="CreateProjectSchema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormField name="name" label="Name" required>
          <UInput v-model="state.name" placeholder="Task Manager" class="w-full" autofocus />
        </UFormField>

        <UFormField name="description" label="Description">
          <UTextarea v-model="state.description" :rows="2" placeholder="What lives in this repository" class="w-full" />
        </UFormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField name="owner" label="Owner" required>
            <UInput v-model="state.owner" placeholder="acme" class="w-full" />
          </UFormField>

          <UFormField name="repo" label="Repository" required>
            <UInput v-model="state.repo" placeholder="tasks" class="w-full" />
          </UFormField>
        </div>

        <UFormField name="branch" label="Branch" hint="Leave empty to use the repository's default branch">
          <UInput v-model="state.branch" placeholder="main" class="w-full" />
        </UFormField>

        <UFormField name="pat" label="Personal access token" hint="Only needed for private repositories">
          <UInput v-model="state.pat" type="password" autocomplete="off" class="w-full" />
        </UFormField>

        <div class="flex justify-end gap-2 pt-1">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
          <UButton type="submit" label="Create project" :loading="submitting" />
        </div>
      </UForm>
    </template>
  </UModal>
</template>

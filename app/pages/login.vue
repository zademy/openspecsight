<script setup lang="ts">
import type { FormError, FormSubmitEvent } from '@nuxt/ui'

definePageMeta({ layout: false })

const route = useRoute()
const form = useTemplateRef('form')
const state = reactive({ password: '' })
const loading = ref(false)

function validate(state: { password: string }): FormError[] {
  return state.password ? [] : [{ name: 'password', message: 'Password is required' }]
}

async function onSubmit(_event: FormSubmitEvent<{ password: string }>) {
  loading.value = true
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { password: state.password } })

    // Only follow same-site absolute paths from the redirect query.
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/'
    await navigateTo(redirect)
  } catch {
    form.value?.setErrors([{ name: 'password', message: 'Incorrect password' }])
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center bg-default text-highlighted">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-eye" class="size-5 text-primary" />
          <h1 class="text-lg font-semibold">Sign in to OpenSpecSight</h1>
        </div>
      </template>

      <UForm ref="form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
        <UFormField name="password" label="Password" required>
          <UInput
            v-model="state.password"
            type="password"
            placeholder="Operator password"
            autocomplete="current-password"
            class="w-full"
            autofocus
          />
        </UFormField>

        <UButton type="submit" label="Sign in" block :loading="loading" />
      </UForm>
    </UCard>
  </div>
</template>

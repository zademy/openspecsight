<script setup lang="ts">
import type { FetchError } from 'ofetch'
import type { ApiKeySummary, CreatedApiKey } from '#shared/types'

/**
 * The settings "API keys" section: create, list, and revoke the keys agents
 * use to reach the MCP server and the read-only API. The full key exists in
 * exactly one place, the reveal panel opened right after creation; it leaves
 * state when the dialog closes and never travels in list responses, which
 * carry the display prefix only.
 */

const requestHeaders = import.meta.server ? useRequestHeaders(['cookie']) : undefined
const { data: keys, refresh, error } = await useAsyncData('api-keys', () => $fetch<{ keys: ApiKeySummary[] }>('/api/keys', { headers: requestHeaders }))

const activeCount = computed(() => (keys.value ?? []).filter((key) => key.revokedAt === null).length)

// --- Creation: form, then the once-only reveal ---

const createOpen = ref(false)
const name = ref('')
const submitting = ref(false)
const createError = ref('')
const created = ref<CreatedApiKey | null>(null)
const copied = ref(false)

watch(createOpen, (open) => {
  if (open) {
    name.value = ''
    created.value = null
    createError.value = ''
    copied.value = false
  } else if (created.value) {
    // Closing the dialog discards the key for good; the list can catch up now.
    created.value = null
    void refresh()
  }
})

async function onCreate() {
  submitting.value = true
  createError.value = ''
  try {
    created.value = await $fetch<CreatedApiKey>('/api/keys', { method: 'POST', body: { name: name.value } })
  } catch (cause) {
    createError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The key could not be created. Check the name and try again.'
  } finally {
    submitting.value = false
  }
}

async function copyKey() {
  if (!created.value) {
    return
  }
  try {
    await navigator.clipboard.writeText(created.value.key)
    copied.value = true
  } catch {
    // Clipboard access refused: the key stays selectable in the panel.
  }
}

// --- Revocation ---

const confirming = ref<ApiKeySummary | null>(null)
const revoking = ref(false)
const revokeError = ref('')

async function onRevoke() {
  if (!confirming.value) {
    return
  }
  revoking.value = true
  revokeError.value = ''
  try {
    await $fetch(`/api/keys/${confirming.value.id}`, { method: 'DELETE' })
    confirming.value = null
    await refresh()
  } catch (cause) {
    revokeError.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The key could not be revoked. Try again.'
    await refresh()
  } finally {
    revoking.value = false
  }
}

// --- Timestamps: dates for creation, relative time for last use ---

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(iso))
}

function relativeLastUsed(iso: string | null): string {
  if (!iso) {
    return 'never'
  }
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 60) {
    return 'just now'
  }

  const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (seconds < 3600) {
    return relative.format(-Math.round(seconds / 60), 'minute')
  }
  if (seconds < 86400) {
    return relative.format(-Math.round(seconds / 3600), 'hour')
  }
  if (seconds < 86400 * 30) {
    return relative.format(-Math.round(seconds / 86400), 'day')
  }
  return formatDate(iso)
}
</script>

<template>
  <section class="space-y-3" aria-labelledby="api-keys-heading">
    <div class="flex flex-wrap items-center gap-3">
      <h2 id="api-keys-heading" class="text-lg font-semibold">API keys</h2>
      <UBadge
        v-if="activeCount > 0"
        color="success"
        variant="subtle"
        icon="i-lucide-key-round"
        :label="`${activeCount} active`"
        size="sm"
      />
      <UBadge
        v-else
        color="neutral"
        variant="subtle"
        icon="i-lucide-key-round"
        label="No active keys"
        size="sm"
      />
    </div>

    <p class="text-sm text-muted">
      API keys authenticate MCP clients and read-only API requests as this instance. Each key is shown once, at
      creation; afterwards only its prefix appears here.
    </p>

    <p v-if="error" class="text-sm text-error" role="alert">
      The keys could not be loaded. Reload the page to try again.
    </p>

    <template v-else>
      <ul v-if="(keys ?? []).length > 0" class="space-y-2">
        <li v-for="key in keys" :key="key.id" class="rounded-lg border border-default p-4">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="text-sm font-medium text-highlighted">{{ key.name }}</span>
            <code class="font-mono text-xs text-muted">{{ key.displayPrefix }}</code>
            <UBadge
              v-if="key.revokedAt"
              color="neutral"
              variant="subtle"
              icon="i-lucide-ban"
              label="Revoked"
              size="sm"
            />
            <UButton
              class="ml-auto"
              label="Revoke"
              color="error"
              variant="ghost"
              size="xs"
              :disabled="key.revokedAt !== null"
              :aria-label="`Revoke ${key.name}`"
              @click="confirming = key"
            />
          </div>
          <p class="mt-1 text-xs text-muted">
            created {{ formatDate(key.createdAt) }} · last used {{ relativeLastUsed(key.lastUsedAt) }}
          </p>
        </li>
      </ul>
      <p v-if="(keys ?? []).length > 0" class="text-xs text-muted">
        Last used marks the most recent request the key authenticated, including requests that were then rejected.
      </p>

      <UEmpty
        v-else
        icon="i-lucide-key-round"
        title="No API keys"
        description="API keys authenticate MCP clients and read-only API requests against this instance. Create one when you need to connect an agent."
      />
    </template>

    <UModal
      v-model:open="createOpen"
      title="New API key"
      description="Give the key a name that says where it is used, like CI or a local agent."
    >
      <UButton icon="i-lucide-plus" label="New API key" />

      <template #body>
        <div v-if="created" class="space-y-3">
          <p class="text-sm">The key for {{ created.name }} is ready.</p>
          <div class="flex items-start gap-2">
            <code class="block flex-1 break-all rounded bg-elevated px-2 py-1 font-mono text-sm select-all">{{ created.key }}</code>
            <UButton
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :label="copied ? 'Copied' : 'Copy'"
              color="neutral"
              variant="outline"
              :aria-label="`Copy the key for ${created.name}`"
              @click="copyKey"
            />
          </div>
          <p class="text-sm text-warning" role="alert">You will not see this key again. Store it now.</p>
          <div class="flex justify-end pt-1">
            <UButton label="Done" @click="createOpen = false" />
          </div>
        </div>

        <form v-else class="space-y-4" @submit.prevent="onCreate">
          <UFormField name="name" label="Name" hint="Up to 60 characters">
            <UInput v-model="name" :maxlength="60" placeholder="CI, local agent" class="w-full" autofocus />
          </UFormField>

          <p v-if="createError" class="text-sm text-error" role="alert">{{ createError }}</p>

          <div class="flex justify-end gap-2 pt-1">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="createOpen = false" />
            <UButton label="Create key" type="submit" :loading="submitting" />
          </div>
        </form>
      </template>
    </UModal>

    <UModal
      :open="confirming !== null"
      title="Revoke key?"
      :description="confirming ? `Agents using it stop working immediately. This revokes ${confirming.name}.` : ''"
      @update:open="(open: boolean) => { if (!open) confirming = null }"
    >
      <template #footer>
        <div class="w-full space-y-3">
          <p v-if="revokeError" role="alert" class="text-sm text-error">{{ revokeError }}</p>
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="confirming = null" />
            <UButton label="Revoke key" color="error" :loading="revoking" @click="onRevoke" />
          </div>
        </div>
      </template>
    </UModal>
  </section>
</template>

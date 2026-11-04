<script setup lang="ts">
import type { FetchError } from 'ofetch'
import type { MailStatus } from '#shared/types'

/**
 * One digest: its LLM-drafted title and the stored content blocks, rendered
 * through the shared ContentBlocks component. The meta line states the week
 * and whether the digest ever went out over email. The email action is
 * honest about delivery: disabled with the missing-config explanation when
 * SMTP is not set up, "Send again" once the digest has gone out.
 */

const route = useRoute()
const projectId = route.params.id as string
const digestId = route.params.digestId as string

const requestHeaders = import.meta.server ? useRequestHeaders(['cookie']) : undefined
const { data: mailStatus } = await useAsyncData('mail-status', () => $fetch<MailStatus>('/api/mail-status', { headers: requestHeaders }))

const { get, send } = useDigests()
const { data: digest, error } = await useAsyncData(`digest-${digestId}`, () => get(digestId))

if (error.value || !digest.value) {
  throw createError({ statusCode: 404, statusMessage: 'Digest not found', fatal: true })
}

const smtpConfigured = computed(() => mailStatus.value?.configured ?? false)
const emailing = ref(false)
const sendNote = ref('')

const emailLabel = computed(() => (digest.value?.emailedAt ? 'Send again' : 'Email to recipients'))

async function onEmail() {
  if (!digest.value) {
    return
  }
  emailing.value = true
  sendNote.value = ''
  try {
    const result = await send(digestId, { force: Boolean(digest.value.emailedAt) })
    if (result.sent) {
      digest.value.emailedAt = new Date().toISOString()
    } else {
      sendNote.value = result.reason ?? 'The digest did not go out.'
    }
  } catch (cause) {
    sendNote.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The digest did not go out. Check the server log and try again.'
  } finally {
    emailing.value = false
  }
}
</script>

<template>
  <div v-if="digest" class="space-y-6">
    <UButton
      label="All digests"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :to="`/projects/${projectId}/digests`"
    />

    <UPageHeader :title="digest.title" :description="rangeLabel(digest.rangeFrom, digest.rangeTo)" />

    <div class="flex flex-wrap items-center gap-2">
      <UBadge
        v-if="digest.emailedAt"
        color="success"
        variant="subtle"
        icon="i-lucide-mail-check"
        label="Emailed"
        size="sm"
      />
      <UBadge
        v-else
        color="neutral"
        variant="subtle"
        icon="i-lucide-mail"
        label="Not emailed"
        size="sm"
      />
      <span v-if="digest.emailedAt" class="text-sm text-muted">emailed {{ releaseDate(digest.emailedAt) }}</span>
      <span class="text-sm text-muted">created {{ releaseDate(digest.createdAt) }}</span>
    </div>

    <div class="space-y-1">
      <UButton
        icon="i-lucide-send"
        :label="emailLabel"
        :disabled="!smtpConfigured"
        :loading="emailing"
        @click="onEmail"
      />
      <p v-if="!smtpConfigured" class="text-sm text-muted">
        SMTP is not configured. Set SMTP_* in .env to enable email
      </p>
      <p v-else-if="sendNote" class="text-sm text-error" role="alert">{{ sendNote }}</p>
    </div>

    <ContentBlocks :blocks="digest.blocks" />
  </div>
</template>

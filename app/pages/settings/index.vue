<script setup lang="ts">
import type { WebhookStatus } from '#shared/types'

/**
 * Settings: the integrations and their honest configuration state. The
 * GitHub webhook section shows the exact URL to paste into GitHub and
 * whether the secret is set — never the secret value itself, which lives in
 * the environment only.
 */

const requestHeaders = import.meta.server ? useRequestHeaders(['cookie']) : undefined
const { data: status } = await useAsyncData('webhook-status', () => $fetch<WebhookStatus>('/api/webhook-status', { headers: requestHeaders }))
</script>

<template>
  <div class="space-y-8">
    <UPageHeader title="Settings" description="Integrations and how each one is configured." />

    <section class="space-y-3" aria-labelledby="webhook-heading">
      <div class="flex flex-wrap items-center gap-3">
        <h2 id="webhook-heading" class="text-lg font-semibold">GitHub webhook</h2>
        <UBadge
          v-if="status?.configured"
          color="success"
          variant="subtle"
          icon="i-lucide-shield-check"
          label="Webhook secret configured"
          size="sm"
        />
        <UBadge
          v-else
          color="neutral"
          variant="subtle"
          icon="i-lucide-shield-alert"
          label="GITHUB_WEBHOOK_SECRET is not set"
          size="sm"
        />
      </div>

      <p class="text-sm text-muted">
        A push to a branch a project watches starts that project's sync automatically. Point the repository's webhook at:
      </p>
      <code class="block w-fit rounded bg-elevated px-2 py-1 font-mono text-sm">{{ status?.webhookUrl ?? '/api/webhooks/github' }}</code>

      <ol class="list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>On GitHub, open the repository's Settings, then Webhooks, then Add webhook.</li>
        <li>Paste the payload URL above, set the content type to application/json, and use your GITHUB_WEBHOOK_SECRET value as the secret.</li>
        <li>Leave just the push event subscribed. Deliveries are verified against that secret.</li>
      </ol>

      <p v-if="!status?.configured" class="text-sm text-muted">
        Add GITHUB_WEBHOOK_SECRET to .env and restart. Until then the endpoint answers every request with 503 and GitHub marks deliveries as failed.
      </p>
    </section>

    <ApiKeyManager />
  </div>
</template>

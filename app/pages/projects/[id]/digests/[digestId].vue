<script setup lang="ts">
/**
 * One digest: its LLM-drafted title and the stored content blocks, rendered
 * through the shared ContentBlocks component. The meta line states the week
 * and whether the digest ever went out over email.
 */

const route = useRoute()
const projectId = route.params.id as string
const digestId = route.params.digestId as string

const { get } = useDigests()
const { data: digest, error } = await useAsyncData(`digest-${digestId}`, () => get(digestId))

if (error.value || !digest.value) {
  throw createError({ statusCode: 404, statusMessage: 'Digest not found', fatal: true })
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
      <span class="text-sm text-muted">created {{ releaseDate(digest.createdAt) }}</span>
    </div>

    <ContentBlocks :blocks="digest.blocks" />
  </div>
</template>

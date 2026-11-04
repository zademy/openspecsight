<script setup lang="ts">
import type { FetchError } from 'ofetch'
import type { ContentBlock, ContentBlocks } from '#shared/types'

/**
 * The release-note block editor. Edits autosave through the field-level
 * PATCH on an 800ms debounce — the quiet line in the header reports the
 * last store, and leaving the page flushes first. Enhance rewrites one
 * paragraph on top of the SAVED state (the pending debounce flushes before
 * the request) and the rewrite then autosaves like any edit. Contentless
 * blocks stay local: the server only stores blocks it can render, so an
 * empty addition persists once it has text.
 */

const route = useRoute()
const projectId = route.params.id as string
const noteId = route.params.noteId as string

const { get, publish, unpublish, update, enhance } = useReleaseNotes()
const { data: note, error } = await useAsyncData(`release-note-${noteId}`, () => get(noteId))

if (error.value || !note.value) {
  throw createError({ statusCode: 404, statusMessage: 'Release note not found', fatal: true })
}

// --- Editable copies; the stored row only moves when a save lands ---

const title = ref(note.value.title)
const blocks = ref<ContentBlocks>(structuredClone(note.value.blocks))

/** Textarea state for list blocks: raw lines while typing, items on save. */
const listDrafts = ref<Record<number, string>>(draftsFrom(blocks.value))

function draftsFrom(entries: ContentBlocks): Record<number, string> {
  const drafts: Record<number, string> = {}
  entries.forEach((block, index) => {
    if (block.type === 'list') {
      drafts[index] = block.items.join('\n')
    }
  })
  return drafts
}

// --- Autosave ---

const AUTOSAVE_MS = 800

const dirty = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved' | 'failed'>('idle')
const savedAt = ref<number | null>(null)
const now = ref(Date.now())
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveQueue: Promise<void> = Promise.resolve()

watch(title, () => scheduleSave())

const savedLabel = computed(() => {
  if (savedAt.value === null) {
    return ''
  }
  const minutes = Math.floor((now.value - savedAt.value) / 60_000)
  return minutes < 1 ? 'Saved just now' : `Saved ${minutes}m ago`
})

/** The one quiet line about saving; absent on a fresh, untouched editor. */
const autosaveLabel = computed(() => {
  if (saveState.value === 'failed') {
    return 'Not saved — the next edit retries'
  }
  if (dirty.value || saveState.value === 'saving') {
    return 'Saving…'
  }
  return savedLabel.value
})

let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (clock !== null) {
    clearInterval(clock)
  }
})

function scheduleSave(): void {
  dirty.value = true
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, AUTOSAVE_MS)
}

/** Saves now; concurrent flushes queue, so one editor never races itself. */
function flushSave(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const run = saveQueue.then(doSave)
  saveQueue = run.then(() => undefined, () => undefined)
  return run
}

async function doSave(): Promise<void> {
  const patch: { title?: string, blocks?: ContentBlocks } = {}
  const trimmedTitle = title.value.trim()
  if (trimmedTitle) {
    patch.title = trimmedTitle
  }
  const saveable = blocks.value.filter(hasContent)
  if (saveable.length > 0) {
    patch.blocks = saveable
  }
  if (!patch.title && !patch.blocks) {
    dirty.value = false
    return
  }
  saveState.value = 'saving'
  try {
    await update(noteId, patch)
    dirty.value = false
    savedAt.value = Date.now()
    saveState.value = 'saved'
  } catch {
    saveState.value = 'failed'
  }
}

/** Server rows only ever hold renderable blocks; empty drafts stay local. */
function hasContent(block: ContentBlock): boolean {
  return block.type === 'list'
    ? block.items.some(item => item.trim().length > 0)
    : typeof block.text === 'string' && block.text.trim().length > 0
}

// Leaving the page saves what the debounce has not sent yet.
onBeforeRouteLeave(() => {
  void flushSave()
  return true
})

// --- Block editing ---

function setBlockText(index: number, text: string): void {
  blocks.value[index] = { ...blocks.value[index]!, text }
  scheduleSave()
}

function setListItems(index: number, raw: string): void {
  listDrafts.value[index] = raw
  const items = raw.split('\n').map(line => line.trim()).filter(line => line !== '')
  blocks.value[index] = { ...blocks.value[index]!, items }
  scheduleSave()
}

function moveBlock(index: number, delta: -1 | 1): void {
  const target = index + delta
  if (target < 0 || target >= blocks.value.length) {
    return
  }
  const entries = [...blocks.value]
  ;[entries[index], entries[target]] = [entries[target]!, entries[index]!]
  blocks.value = entries
  listDrafts.value = draftsFrom(entries)
  enhancePanel.value = null
  scheduleSave()
}

function deleteBlock(index: number): void {
  blocks.value = blocks.value.filter((_, entryIndex) => entryIndex !== index)
  listDrafts.value = draftsFrom(blocks.value)
  enhancePanel.value = null
  scheduleSave()
}

function addBlock(type: ContentBlock['type']): void {
  blocks.value = [...blocks.value, type === 'list' ? { type, items: [] } : { type, text: '' }]
  listDrafts.value = draftsFrom(blocks.value)
  scheduleSave()
}

function blockLabel(type: ContentBlock['type']): string {
  return type === 'heading' ? 'Heading' : type === 'paragraph' ? 'Paragraph' : 'List'
}

const addBlockItems = computed(() => [
  { label: 'Heading', icon: 'i-lucide-heading', onSelect: () => addBlock('heading') },
  { label: 'Paragraph', icon: 'i-lucide-align-left', onSelect: () => addBlock('paragraph') },
  { label: 'List', icon: 'i-lucide-list', onSelect: () => addBlock('list') },
])

// --- Enhance ---

const enhancePanel = ref<number | null>(null)
const enhanceInstruction = ref('')
const enhancingIndex = ref<number | null>(null)
const working = ref(false)
const actionNote = ref('')

function toggleEnhancePanel(index: number): void {
  enhanceInstruction.value = ''
  enhancePanel.value = enhancePanel.value === index ? null : index
}

/**
 * Flushes the pending debounce first, so the rewrite lands on the stored
 * state; the answer replaces that one block and autosaves like any edit.
 */
async function onEnhance(index: number): Promise<void> {
  if (enhancingIndex.value !== null) {
    return
  }
  enhancingIndex.value = index
  actionNote.value = ''
  try {
    await flushSave()
    const instruction = enhanceInstruction.value.trim()
    const { block } = await enhance(noteId, index, instruction || undefined)
    blocks.value = blocks.value.map((entry, entryIndex) => (entryIndex === index ? block : entry))
    enhancePanel.value = null
    enhanceInstruction.value = ''
    scheduleSave()
  } catch (cause) {
    actionNote.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The paragraph could not be enhanced. Check the server log and try again.'
  } finally {
    enhancingIndex.value = null
  }
}

// --- Publish actions (editing keeps the published state) ---

async function onPublish() {
  if (!note.value) {
    return
  }
  working.value = true
  actionNote.value = ''
  try {
    const result = await publish(noteId)
    note.value.slug = result.slug
    note.value.published = true
    note.value.publishedAt = new Date().toISOString()
  } catch (cause) {
    actionNote.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The note could not be published. Check the server log and try again.'
  } finally {
    working.value = false
  }
}

async function onUnpublish() {
  if (!note.value) {
    return
  }
  working.value = true
  actionNote.value = ''
  try {
    await unpublish(noteId)
    note.value.published = false
    note.value.publishedAt = null
  } catch (cause) {
    actionNote.value = (cause as FetchError<{ message?: string }>).data?.message
      ?? 'The note could not be returned to draft. Check the server log and try again.'
  } finally {
    working.value = false
  }
}

/** The shareable address of the published note, copied to the clipboard. */
async function copyPublicLink() {
  if (!note.value) {
    return
  }
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/notes/${note.value.slug}`)
    actionNote.value = 'The public link was copied.'
  } catch {
    actionNote.value = `The link could not be copied: /notes/${note.value.slug}`
  }
}
</script>

<template>
  <div v-if="note" class="space-y-6">
    <UButton
      label="All release notes"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :to="`/projects/${projectId}/release-notes`"
    />

    <div class="space-y-2">
      <UInput
        v-model="title"
        aria-label="Title"
        variant="none"
        size="lg"
        class="w-full text-xl font-semibold"
      />
      <p class="text-sm text-muted">{{ rangeLabel(note.rangeFrom, note.rangeTo) }}</p>
    </div>

    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <UBadge
        v-if="note.published"
        color="success"
        variant="subtle"
        icon="i-lucide-globe"
        label="Published"
        size="sm"
      />
      <UBadge
        v-else
        color="neutral"
        variant="subtle"
        icon="i-lucide-pencil-line"
        label="Draft"
        size="sm"
      />
      <span class="text-sm text-muted">{{ note.voiceName ?? 'Default voice' }}</span>
      <span class="text-sm text-muted">created {{ releaseDate(note.createdAt) }}</span>
      <span v-if="note.publishedAt" class="text-sm text-muted">published {{ releaseDate(note.publishedAt) }}</span>
      <span v-if="autosaveLabel" class="text-sm text-muted" role="status">{{ autosaveLabel }}</span>
    </div>
    <p v-if="note.published" class="text-sm text-muted">Edits appear on the public page immediately.</p>

    <div class="space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="!note.published"
          icon="i-lucide-globe"
          label="Publish"
          :loading="working"
          @click="onPublish"
        />
        <template v-else>
          <UButton
            icon="i-lucide-link"
            label="Copy public link"
            color="neutral"
            variant="outline"
            @click="copyPublicLink"
          />
          <UButton
            icon="i-lucide-pencil-line"
            label="Unpublish"
            color="neutral"
            variant="outline"
            :loading="working"
            @click="onUnpublish"
          />
        </template>
      </div>
      <p v-if="actionNote" class="text-sm text-muted" role="status">{{ actionNote }}</p>
    </div>

    <section aria-label="Blocks" class="space-y-4">
      <p v-if="blocks.length === 0" class="text-sm text-muted">
        This note has no blocks yet — add one below.
      </p>

      <article
        v-for="(block, index) in blocks"
        :key="index"
        class="space-y-3 rounded-lg border border-default p-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <UBadge :label="blockLabel(block.type)" color="neutral" variant="subtle" size="sm" />
          <div class="flex items-center gap-1">
            <UButton
              icon="i-lucide-arrow-up"
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="index === 0"
              :aria-label="`Move block ${index + 1} up`"
              @click="moveBlock(index, -1)"
            />
            <UButton
              icon="i-lucide-arrow-down"
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="index === blocks.length - 1"
              :aria-label="`Move block ${index + 1} down`"
              @click="moveBlock(index, 1)"
            />
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="`Delete block ${index + 1}`"
              @click="deleteBlock(index)"
            />
            <UButton
              v-if="block.type === 'paragraph'"
              icon="i-lucide-sparkles"
              label="Enhance"
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="enhancingIndex === index"
              @click="toggleEnhancePanel(index)"
            />
          </div>
        </div>

        <UInput
          v-if="block.type === 'heading'"
          :model-value="block.text"
          :aria-label="`Heading ${index + 1}`"
          class="w-full"
          @update:model-value="value => setBlockText(index, String(value))"
        />
        <UTextarea
          v-else-if="block.type === 'paragraph'"
          :model-value="block.text"
          :aria-label="`Paragraph ${index + 1}`"
          :rows="4"
          class="w-full"
          @update:model-value="value => setBlockText(index, value)"
        />
        <UTextarea
          v-else
          :model-value="listDrafts[index] ?? ''"
          :aria-label="`List ${index + 1}`"
          :rows="4"
          placeholder="One item per line"
          class="w-full"
          @update:model-value="value => setListItems(index, value)"
        />

        <div v-if="enhancePanel === index" class="flex flex-wrap items-center gap-2 rounded-lg bg-elevated p-2">
          <UInput
            v-model="enhanceInstruction"
            aria-label="Instruction for the rewrite"
            placeholder="Optional: what should change?"
            class="min-w-60 flex-1"
            @keydown.enter.prevent="onEnhance(index)"
          />
          <UButton
            label="Rewrite paragraph"
            size="sm"
            :loading="enhancingIndex === index"
            :disabled="enhancingIndex !== null"
            @click="onEnhance(index)"
          />
          <UButton
            label="Cancel"
            color="neutral"
            variant="ghost"
            size="sm"
            @click="enhancePanel = null"
          />
        </div>
      </article>

      <div class="flex justify-end">
        <UDropdownMenu :items="addBlockItems">
          <UButton icon="i-lucide-plus" label="Add block" color="neutral" variant="outline" size="sm" />
        </UDropdownMenu>
      </div>
    </section>
  </div>
</template>


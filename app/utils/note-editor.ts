import type { ContentBlock, ContentBlocks } from '#shared/types'

/**
 * Editor-side rules for what the server stores: rows only ever hold
 * renderable blocks, so contentless drafts stay local and every index the
 * UI sends must be mapped through the saveable array first.
 */

/** Server rows only ever hold renderable blocks; empty drafts stay local. */
export function hasContent(block: ContentBlock): boolean {
  return block.type === 'list'
    ? (block.items ?? []).some(item => item.trim().length > 0)
    : typeof block.text === 'string' && block.text.trim().length > 0
}

/**
 * The index a local block has in the array the server stores — the local
 * array filtered to saveable blocks, exactly what the autosave PATCHes.
 * -1 when the block itself is contentless (nothing to enhance) or the
 * local index is out of range.
 */
export function serverBlockIndex(blocks: ContentBlocks, localIndex: number): number {
  const block = blocks[localIndex]
  if (!block || !hasContent(block)) {
    return -1
  }
  return blocks.filter(hasContent).indexOf(block)
}

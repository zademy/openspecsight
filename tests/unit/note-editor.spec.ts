import { describe, expect, test } from 'vitest'
import { hasContent, serverBlockIndex } from '../../app/utils/note-editor'
import type { ContentBlocks } from '../../shared/types'

/**
 * The editor-side index mapping: the server only stores saveable blocks,
 * so an index the UI shows is not necessarily an index the API accepts.
 * serverBlockIndex is the rule for translating one into the other — the
 * contract the enhance button depends on not to rewrite the wrong block.
 */

describe('serverBlockIndex', () => {
  const blocks: ContentBlocks = [
    { type: 'heading', text: 'What changed' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: 'Real words.' },
    { type: 'list', items: [] },
    { type: 'list', items: ['One item'] },
  ]

  test('saveable blocks map to their position in the stored (filtered) array', () => {
    expect(serverBlockIndex(blocks, 0)).toBe(0)
    expect(serverBlockIndex(blocks, 2)).toBe(1)
    expect(serverBlockIndex(blocks, 4)).toBe(2)
  })

  test('contentless blocks have no server position', () => {
    expect(serverBlockIndex(blocks, 1)).toBe(-1)
    expect(serverBlockIndex(blocks, 3)).toBe(-1)
  })

  test('an out-of-range local index answers -1', () => {
    expect(serverBlockIndex(blocks, 99)).toBe(-1)
  })

  test('hasContent mirrors the storage rule', () => {
    expect(hasContent({ type: 'paragraph', text: '  x  ' })).toBe(true)
    expect(hasContent({ type: 'paragraph', text: '   ' })).toBe(false)
    expect(hasContent({ type: 'list', items: [' ', 'a'] })).toBe(true)
    expect(hasContent({ type: 'list', items: ['  '] })).toBe(false)
  })
})

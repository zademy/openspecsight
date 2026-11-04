import { describe, expect, test } from 'vitest'
import { renderBlocksHtml, renderBlocksText } from '../../server/utils/mailRenderer'
import type { ContentBlock } from '../../shared/types'

/**
 * Block renderer tests: the exact text and HTML shapes digests and release
 * notes travel in, including the escaping contract that keeps LLM- or
 * user-authored block text inert once it lands in a mail body.
 */

const BLOCKS: ContentBlock[] = [
  { type: 'heading', text: 'This week' },
  { type: 'paragraph', text: 'Shipping focused on the ask pipeline.' },
  { type: 'list', items: ['Ask citations', 'Digest drafts'] },
]

describe('renderBlocksText', () => {
  test('renders heading, paragraph and list with blank lines between blocks', () => {
    expect(renderBlocksText(BLOCKS)).toBe(
      [
        '## This week',
        'Shipping focused on the ask pipeline.',
        '- Ask citations\n- Digest drafts',
      ].join('\n\n'),
    )
  })

  test('empty blocks render as an empty string', () => {
    expect(renderBlocksText([])).toBe('')
  })

  test('html-sensitive text is not escaped in the plain-text version', () => {
    const blocks: ContentBlock[] = [{ type: 'paragraph', text: 'a < b & c' }]
    expect(renderBlocksText(blocks)).toBe('a < b & c')
  })
})

describe('renderBlocksHtml', () => {
  test('renders h2, p and ul-li with newlines between blocks', () => {
    expect(renderBlocksHtml(BLOCKS)).toBe(
      [
        '<h2>This week</h2>',
        '<p>Shipping focused on the ask pipeline.</p>',
        '<ul><li>Ask citations</li><li>Digest drafts</li></ul>',
      ].join('\n'),
    )
  })

  test('empty blocks render as an empty string', () => {
    expect(renderBlocksHtml([])).toBe('')
  })

  test('escapes html-sensitive text in headings, paragraphs and list items', () => {
    const blocks: ContentBlock[] = [
      { type: 'heading', text: '<script>alert(1)</script>' },
      { type: 'paragraph', text: 'Tom & Jerry <3' },
      { type: 'list', items: ['<b>bold</b>', '"quoted" \'single\''] },
    ]
    expect(renderBlocksHtml(blocks)).toBe(
      [
        '<h2>&lt;script&gt;alert(1)&lt;/script&gt;</h2>',
        '<p>Tom &amp; Jerry &lt;3</p>',
        '<ul><li>&lt;b&gt;bold&lt;/b&gt;</li><li>&quot;quoted&quot; &#39;single&#39;</li></ul>',
      ].join('\n'),
    )
  })
})

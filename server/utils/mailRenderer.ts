import type { ContentBlock } from '../../shared/types'

/**
 * Renders content blocks (the shared digest/release-note shape) into the two
 * mail bodies: plain text and content-only inline HTML. Text is not escaped;
 * every string that enters the HTML version is, so LLM- or user-authored
 * block text can never carry markup into a mail client.
 */
export function renderBlocksText(blocks: ContentBlock[]): string {
  const parts = blocks.map((block) => {
    if (block.type === 'heading') return `## ${block.text ?? ''}`
    if (block.type === 'list') return (block.items ?? []).map((item) => `- ${item}`).join('\n')
    return block.text ?? ''
  })
  return parts.join('\n\n')
}

export function renderBlocksHtml(blocks: ContentBlock[]): string {
  const parts = blocks.map((block) => {
    if (block.type === 'heading') return `<h2>${escapeHtml(block.text ?? '')}</h2>`
    if (block.type === 'list') {
      const items = (block.items ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')
      return `<ul>${items}</ul>`
    }
    return `<p>${escapeHtml(block.text ?? '')}</p>`
  })
  return parts.join('\n')
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

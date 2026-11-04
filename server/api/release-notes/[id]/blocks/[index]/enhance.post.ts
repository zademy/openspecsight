import type { ContentBlock } from '../../../../../../shared/types'
import { EnhanceBlockSchema } from '../../../../../../shared/schemas'
import { enhanceNoteBlock, NoteBlockNotEnhancableError, NoteBlockRangeError, NoteEnhanceEmptyError } from '../../../../../services/releaseNotes.service'

/**
 * Rewrites one paragraph block in the note's voice and stores it. 400 for
 * an index with no block and for heading/list blocks (paragraphs are the
 * only enhancable type for now); 404 for an unknown or corrupt note; 502
 * when the rewrite came back empty and nothing was stored.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const rawIndex = getRouterParam(event, 'index') ?? ''
  const id = Number(rawId)
  const index = Number(rawIndex)
  const { instruction } = await readValidatedBody(event, EnhanceBlockSchema.parse)

  let block: ContentBlock | null
  try {
    block = Number.isInteger(id) ? await enhanceNoteBlock(id, index, instruction) : null
  } catch (cause) {
    if (cause instanceof NoteBlockRangeError) {
      throw createError({ statusCode: 400, statusMessage: 'Block not found', message: `No block at index ${rawIndex}` })
    }
    if (cause instanceof NoteBlockNotEnhancableError) {
      throw createError({ statusCode: 400, statusMessage: 'This block cannot be enhanced', message: cause.message })
    }
    if (cause instanceof NoteEnhanceEmptyError) {
      throw createError({ statusCode: 502, statusMessage: 'The rewrite came back empty', message: cause.message })
    }
    throw cause
  }
  if (!block) {
    throw createError({ statusCode: 404, statusMessage: 'Release note not found', message: `No release note with id ${rawId}` })
  }

  return { block }
})

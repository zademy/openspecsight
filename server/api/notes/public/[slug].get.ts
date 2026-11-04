import { getPublicNote } from '../../../services/releaseNotes.service'

/**
 * The public release-note reader, reachable without a session: the exact
 * prefix /api/notes/public/ is exempted in server/middleware/01.auth.ts
 * (nothing else under /api/notes/ is). Answers only published notes, as
 * exactly { title, publishedAt, blocks } — projectId, voiceId and the rest
 * never serialize here. An unknown slug and an unpublished draft get the
 * same 404, so the URL space leaks nothing about drafts.
 */
export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug') ?? ''
  const note = getPublicNote(slug)
  if (!note) {
    throw createError({ statusCode: 404, statusMessage: 'Release note not found', message: 'No published release note at this address' })
  }

  return note
})

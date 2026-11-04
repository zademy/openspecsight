/**
 * Formatting for the changes surfaces: day headings for the release
 * timeline, long dates for release detail, and initials for the functional
 * author avatars (DESIGN.md — no photos, initials only). Dates format from
 * the calendar parts of the stored ISO strings, never the local clock, so a
 * day group renders identically in every timezone.
 */

/** Local Date from a "YYYY-MM-DD" string; null when the parts are not a date. */
export function localDate(date: string): Date | null {
  const parts = date.split('-').map(Number)
  const [year, month, day] = parts
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    return null
  }
  return new Date(year!, month! - 1, day!)
}

/** "2026-11-02" → "Nov 2 · Monday" (en locale, as the app ships single-locale). */
export function dayHeading(date: string): string {
  const local = localDate(date)
  if (!local) {
    return date
  }
  const monthDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(local)
  const weekday = new Intl.DateTimeFormat('en', { weekday: 'long' }).format(local)
  return `${monthDay} · ${weekday}`
}

/** "2026-11-02T09:30:00Z" → "November 2, 2026". */
export function releaseDate(committedAt: string): string {
  const local = localDate(committedAt.slice(0, 10))
  if (!local) {
    return committedAt
  }
  return new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(local)
}

/** "Grace Hopper" → "GH"; a single name keeps its first two letters. */
export function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]
  if (!first) {
    return '?'
  }
  if (parts.length === 1) {
    return first.slice(0, 2).toUpperCase()
  }
  const last = parts[parts.length - 1]!
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
}

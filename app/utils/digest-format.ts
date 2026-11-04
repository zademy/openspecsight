import { localDate } from './changes-format'

/**
 * Formatting for the digests surfaces: the "Oct 28 – Nov 4, 2026" range
 * label and the last-seven-days defaults the New digest modal opens with.
 * Dates format from the calendar parts of the stored ISO strings, never
 * the local clock, so both themes and timezones read the same digest.
 */

const MONTH_DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })

/** The two ends of a digest range as one readable label. */
export function rangeLabel(rangeFrom: string, rangeTo: string): string {
  const from = localDate(rangeFrom)
  const to = localDate(rangeTo)
  if (!from || !to) {
    return `${rangeFrom} – ${rangeTo}`
  }
  if (from.getFullYear() === to.getFullYear()) {
    return `${MONTH_DAY.format(from)} – ${MONTH_DAY_YEAR.format(to)}`
  }
  return `${MONTH_DAY_YEAR.format(from)} – ${MONTH_DAY_YEAR.format(to)}`
}

/** Last seven days as UTC dates — the modal's prefill, mirroring the server default. */
export function suggestedDigestRange(now: Date = new Date()): { rangeFrom: string, rangeTo: string } {
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  return { rangeFrom: from.toISOString().slice(0, 10), rangeTo: now.toISOString().slice(0, 10) }
}

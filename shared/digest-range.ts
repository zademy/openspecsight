/**
 * The one digest range both ends of the app agree on: an eight-day
 * inclusive window — today plus the seven days before it — as UTC calendar
 * dates. The server applies it when a request omits both fields, and the
 * "New digest" modal prefills with it; one pure function, so the two
 * cannot drift apart.
 */
export function defaultDigestRange(now: Date = new Date()): { rangeFrom: string, rangeTo: string } {
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  return { rangeFrom: from.toISOString().slice(0, 10), rangeTo: now.toISOString().slice(0, 10) }
}

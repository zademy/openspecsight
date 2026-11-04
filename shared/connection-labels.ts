import type { ConnectionType } from './types'

/**
 * The map speaks the operator's language: stored snake_case connection types
 * ("shares_data") render humanized everywhere — edge labels on hover and the
 * legend. Unknown types (older databases, hand-edits) degrade to a readable
 * string instead of leaking raw identifiers.
 */
const CONNECTION_TYPE_LABELS: Record<ConnectionType, string> = {
  leads_to: 'Leads to',
  triggers: 'Triggers',
  depends_on: 'Depends on',
  shares_data: 'Shares data',
  authenticates: 'Authenticates',
  notifies: 'Notifies',
  configures: 'Configures',
  embeds_in: 'Embeds in',
  competes_with: 'Competes with',
}

export function humanizeConnectionType(type: string): string {
  return CONNECTION_TYPE_LABELS[type as ConnectionType] ?? type.replaceAll('_', ' ')
}

/** Every distinct humanized type in the given list, sorted — a collapsed edge's label and the legend share this shape. */
export function humanizedTypeList(types: string[]): string {
  return [...new Set(types)].map(humanizeConnectionType).sort().join(', ')
}

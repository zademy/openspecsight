import { describe, expect, test } from 'vitest'
import { humanizeConnectionType } from '../../shared/connection-labels'

/**
 * Edge labels and the map legend speak the operator's language: the stored
 * snake_case connection types render humanized ("shares_data" → "Shares
 * data"). Unknown types (an older database, a hand-edit) must degrade to a
 * readable string instead of leaking raw identifiers.
 */
describe('humanizeConnectionType', () => {
  test('humanizes all nine stored connection types', () => {
    expect(humanizeConnectionType('leads_to')).toBe('Leads to')
    expect(humanizeConnectionType('triggers')).toBe('Triggers')
    expect(humanizeConnectionType('depends_on')).toBe('Depends on')
    expect(humanizeConnectionType('shares_data')).toBe('Shares data')
    expect(humanizeConnectionType('authenticates')).toBe('Authenticates')
    expect(humanizeConnectionType('notifies')).toBe('Notifies')
    expect(humanizeConnectionType('configures')).toBe('Configures')
    expect(humanizeConnectionType('embeds_in')).toBe('Embeds in')
    expect(humanizeConnectionType('competes_with')).toBe('Competes with')
  })

  test('falls back to a readable string for unknown types', () => {
    expect(humanizeConnectionType('mystery_kind')).toBe('mystery kind')
  })
})

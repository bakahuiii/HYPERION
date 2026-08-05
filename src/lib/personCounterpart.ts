import type { IntelItem } from '../types'

type CounterpartRecord = Pick<IntelItem, 'speakerRole' | 'speaker'>

function identityKey(value: string | undefined) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

/**
 * Resolves records that can prove a direct-chat counterpart identity.
 * Per-message names win. A conversation-level name is accepted only when no
 * other-message sender labels exist, so a mislabeled group cannot collapse
 * several named senders into one card.
 */
export function counterpartIdentityEvidence<T extends CounterpartRecord>(records: T[], returnedName: string, expectedName?: string) {
  const otherRecords = records.filter((item) => item.speakerRole === 'other')
  const returnedKey = identityKey(returnedName)
  if (!returnedKey || !otherRecords.length) return { valid: false, records: [] as T[], basis: 'none' as const }

  const namedOtherRecords = otherRecords.filter((item) => identityKey(item.speaker))
  const exact = namedOtherRecords.filter((item) => identityKey(item.speaker) === returnedKey)
  if (exact.length) return { valid: true, records: exact, basis: 'speaker' as const }

  const expectedKey = identityKey(expectedName)
  if (!namedOtherRecords.length && expectedKey && expectedKey === returnedKey) {
    return { valid: true, records: otherRecords, basis: 'conversation' as const }
  }
  return { valid: false, records: [] as T[], basis: 'none' as const }
}

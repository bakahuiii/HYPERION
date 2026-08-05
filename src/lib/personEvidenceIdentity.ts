import type { PersonEvidence } from '../types'

export function compactPersonEvidenceText(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

export function personEvidenceIdentityKey(claim: Pick<PersonEvidence, 'kind' | 'text' | 'quote'>) {
  return `${claim.kind}|${compactPersonEvidenceText(claim.text)}|${compactPersonEvidenceText(claim.quote)}`
}

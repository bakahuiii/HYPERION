import type { IntelItem } from '../types.ts'
import { compactIntelItems } from './intelPersistence.ts'

export interface IntelDeltaPlan {
  compacted: IntelItem[]
  upserts: IntelItem[]
  deleteIds: string[]
  nextSignatures: Map<string, string>
}

export function intelSignatures(items: IntelItem[]) {
  return new Map(compactIntelItems(items).map((item) => [item.id, JSON.stringify(item)]))
}

export function planIntelDelta(previous: ReadonlyMap<string, string>, items: IntelItem[]): IntelDeltaPlan {
  const compacted = compactIntelItems(items)
  const nextSignatures = new Map<string, string>()
  const upserts: IntelItem[] = []
  for (const item of compacted) {
    const signature = JSON.stringify(item)
    nextSignatures.set(item.id, signature)
    if (previous.get(item.id) !== signature) upserts.push(item)
  }
  const deleteIds = [...previous.keys()].filter((id) => !nextSignatures.has(id))
  return { compacted, upserts, deleteIds, nextSignatures }
}

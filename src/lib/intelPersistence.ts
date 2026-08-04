import type { IntelItem } from '../types'

export function compactIntelItem(item: IntelItem): IntelItem {
  if (!item.content?.trim()) return item
  const stored: Partial<IntelItem> = { ...item }
  delete stored.title
  delete stored.summary
  return stored as IntelItem
}

export function hydrateIntelItem(value: unknown): IntelItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<IntelItem>
  if (typeof item.id !== 'string' || typeof item.source !== 'string') return null
  const body = typeof item.content === 'string' && item.content.trim()
    ? item.content
    : typeof item.summary === 'string' ? item.summary : typeof item.title === 'string' ? item.title : ''
  const summary = typeof item.summary === 'string' && item.summary.trim()
    ? item.summary
    : [item.speaker?.trim() ? `${item.speaker.trim()}:` : '', body].filter(Boolean).join(' ').slice(0, 1200)
  const title = typeof item.title === 'string' && item.title.trim()
    ? item.title
    : summary.length > 22 ? `${summary.slice(0, 22)}...` : summary
  return { ...item, title, summary, capturedAt: item.capturedAt ?? '', status: item.status === 'reviewed' ? 'reviewed' : 'new' } as IntelItem
}

export function hydrateIntelItems(items: unknown[]) {
  return items.map(hydrateIntelItem).filter((item): item is IntelItem => Boolean(item))
}

export function compactIntelItems(items: IntelItem[]) {
  return deduplicateIntelAvatars(items.map(compactIntelItem))
}

/** Keeps every message while storing repeated avatar metadata only once. */
export function deduplicateIntelAvatars(items: IntelItem[]) {
  const seen = new Set<string>()
  let changed = false
  const result = items.map((item) => {
    const avatarUrl = item.avatarUrl?.trim()
    if (!avatarUrl) return item
    const conversation = item.conversationId || item.sourceFile || item.source
    const speaker = item.speaker?.trim() || item.speakerRole || 'unknown'
    const key = `${conversation}\u0000${speaker}\u0000${avatarUrl}`
    if (!seen.has(key)) {
      seen.add(key)
      return item
    }
    changed = true
    const compacted = { ...item }
    delete compacted.avatarUrl
    return compacted
  })
  return changed ? result : items
}

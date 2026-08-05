import type { IntelItem } from '../types.ts'

export interface ConversationTimeline {
  id: string
  name: string
  kind: NonNullable<IntelItem['conversationKind']>
  source: IntelItem['source']
  records: IntelItem[]
  firstAt?: string
  lastAt?: string
}

export function chatTimestamp(value: string) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

export function conversationKey(item: IntelItem) {
  if (item.conversationId) return item.conversationId
  const month = item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] ?? 'undated'
  return `legacy:${item.source}:${month}`
}

export function fullConversationRecords(items: IntelItem[], selectedItems: IntelItem[]) {
  const selectedConversationIds = new Set(selectedItems.map(conversationKey))
  return items.filter((item) => selectedConversationIds.has(conversationKey(item)))
}

export function incrementalConversationRecords(items: IntelItem[], newItems: IntelItem[], contextRecords = 16) {
  const newIds = new Set(newItems.map((item) => item.id))
  const selectedConversations = new Set(newItems.map(conversationKey))
  const includedIds = new Set<string>()
  const grouped = new Map<string, IntelItem[]>()
  for (const item of items) {
    const key = conversationKey(item)
    if (!selectedConversations.has(key)) continue
    const records = grouped.get(key)
    if (records) records.push(item)
    else grouped.set(key, [item])
  }
  for (const records of grouped.values()) {
    records.sort((left, right) => chatTimestamp(left.capturedAt) - chatTimestamp(right.capturedAt))
    records.forEach((item, index) => {
      if (!newIds.has(item.id)) return
      for (let cursor = Math.max(0, index - contextRecords); cursor <= index; cursor += 1) includedIds.add(records[cursor].id)
    })
  }
  return items.filter((item) => includedIds.has(item.id))
}

export function buildConversationTimeline(items: IntelItem[]): ConversationTimeline[] {
  const grouped = new Map<string, IntelItem[]>()
  for (const item of items) {
    const key = conversationKey(item)
    const records = grouped.get(key)
    if (records) records.push(item)
    else grouped.set(key, [item])
  }
  return [...grouped.entries()].map(([id, records]) => {
    const ordered = [...records].sort((left, right) => {
      const leftTime = chatTimestamp(left.capturedAt)
      const rightTime = chatTimestamp(right.capturedAt)
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0
      if (Number.isNaN(leftTime)) return 1
      if (Number.isNaN(rightTime)) return -1
      return leftTime - rightTime
    })
    const dated = ordered.filter((item) => Number.isFinite(chatTimestamp(item.capturedAt)))
    const first = ordered[0]
    return {
      id,
      name: first.conversationName || first.source,
      kind: first.conversationKind ?? 'unknown',
      source: first.source,
      records: ordered,
      firstAt: dated[0]?.capturedAt,
      lastAt: dated.at(-1)?.capturedAt,
    }
  }).sort((left, right) => (chatTimestamp(right.lastAt ?? '') || -Infinity) - (chatTimestamp(left.lastAt ?? '') || -Infinity))
}

export function withinLastChatRange(conversation: Pick<ConversationTimeline, 'lastAt'>, start: string, end: string) {
  if (!start && !end) return true
  const lastAt = chatTimestamp(conversation.lastAt ?? '')
  if (!Number.isFinite(lastAt)) return false
  const startAt = start ? new Date(`${start}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
  const endAt = end ? new Date(`${end}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY
  return lastAt >= startAt && lastAt <= endAt
}

export function withinStrictTimeRange(item: IntelItem, start: string, end: string) {
  if (!start && !end) return true
  const capturedAt = chatTimestamp(item.capturedAt)
  if (!Number.isFinite(capturedAt)) return false
  const startAt = start ? new Date(`${start}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
  const endAt = end ? new Date(`${end}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY
  return capturedAt >= startAt && capturedAt <= endAt
}

export function timelineBucket(conversation: Pick<ConversationTimeline, 'lastAt'>) {
  return conversation.lastAt?.slice(0, 7) || '未记录时间'
}

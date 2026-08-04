import type { IntelItem } from '../types'

export type AnalysisWorkflow = 'tasks' | 'people'

function timestamp(value: string) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** Returns the same stable conversation key used by the archive UI. */
export function analysisConversationKey(item: Pick<IntelItem, 'conversationId' | 'source' | 'capturedAt'>) {
  if (item.conversationId) return item.conversationId
  const month = item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] ?? 'undated'
  return `legacy:${item.source}:${month}`
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

/**
 * A compact content fingerprint for one complete conversation. It changes
 * when message text, direction, sender, timestamp, or membership changes, but
 * stores none of the message body in settings.
 */
export function analysisConversationFingerprint(records: IntelItem[]) {
  const ordered = [...records].sort((left, right) => {
    const leftTime = timestamp(left.capturedAt)
    const rightTime = timestamp(right.capturedAt)
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return left.id.localeCompare(right.id)
    if (Number.isNaN(leftTime)) return 1
    if (Number.isNaN(rightTime)) return -1
    return leftTime - rightTime || left.id.localeCompare(right.id)
  })
  const input = ordered.map((item) => [
    item.id,
    item.capturedAt,
    item.speaker ?? '',
    item.speakerRole ?? '',
    item.messageType ?? '',
    item.content ?? item.summary,
  ].join('\u001f')).join('\u001e')
  return `v1-${ordered.length}-${hash(input)}`
}

export interface ConversationWatermarkGroup {
  id: string
  records: IntelItem[]
  fingerprint: string
}

export function groupAnalysisConversations(items: IntelItem[]) {
  const groups = new Map<string, IntelItem[]>()
  for (const item of items) {
    const id = analysisConversationKey(item)
    const records = groups.get(id)
    if (records) records.push(item)
    else groups.set(id, [item])
  }
  return [...groups.entries()].map(([id, records]) => ({
    id,
    records,
    fingerprint: analysisConversationFingerprint(records),
  } satisfies ConversationWatermarkGroup))
}

/** Builds watermarks only for conversations whose every current record was analyzed. */
export function completedConversationWatermarks(items: IntelItem[], analyzedIds: string[]) {
  if (!analyzedIds.length) return {}
  const analyzed = new Set(analyzedIds)
  const watermarks: Record<string, string> = {}
  for (const group of groupAnalysisConversations(items)) {
    if (group.records.every((item) => analyzed.has(item.id))) watermarks[group.id] = group.fingerprint
  }
  return watermarks
}

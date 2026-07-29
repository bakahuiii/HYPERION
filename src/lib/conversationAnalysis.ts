import type { IntelItem } from '../types'

const HISTORY_WINDOW_MS = 61 * 24 * 60 * 60 * 1000
const MAX_OVERLAP_RECORDS = 24
const MAX_OVERLAP_CHARS = 4_000

export interface ConversationAnalysisJob {
  /** Stable parent conversation ID, not a per-segment surrogate. */
  id: string
  name: string
  kind: NonNullable<IntelItem['conversationKind']>
  /** Number of records in the parent conversation. */
  totalRecords: number
  /** Number of records in this request, including its preceding overlap. */
  recordCount: number
  segmentIndex: number
  segmentCount: number
  overlapRecordCount: number
  coreRecordCount: number
  /** IDs belonging to this segment's non-overlap timeline range. */
  coreRecordIds: string[]
  /** A historical segment is still uploaded, but may only emit durable/future tasks. */
  historical: boolean
  priority: number
  records: IntelItem[]
}

export interface ConversationAnalysisPlan {
  jobs: ConversationAnalysisJob[]
  totalConversations: number
  totalSegments: number
  skippedConversations: number
  /** Unique raw messages, never counting overlap twice. */
  recordCount: number
}

function capturedAtTime(value: string) {
  if (!value) return Number.NaN
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? Number.NaN : time
}

function conversationRelevance(item: Pick<IntelItem, 'capturedAt'>, now: number) {
  const captured = capturedAtTime(item.capturedAt)
  if (Number.isNaN(captured)) return 0.08
  const ageDays = Math.max(0, (now - captured) / 86_400_000)
  if (ageDays <= 3) return 1
  if (ageDays <= 7) return 0.92
  if (ageDays <= 14) return 0.78
  if (ageDays <= 30) return 0.62
  if (ageDays <= 60) return 0.42
  if (ageDays <= 120) return 0.24
  if (ageDays <= 365) return 0.1
  return 0.04
}

function conversationKey(item: IntelItem) {
  if (item.conversationId) return item.conversationId
  const month = item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] ?? 'undated'
  // Older imports have no directory provenance. Do not join them into a single
  // unbounded pseudo-conversation.
  return `legacy:${item.source}:${month}`
}

function conversationName(item: IntelItem) {
  if (item.conversationName) return item.conversationName
  const month = item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] ?? 'undated'
  return `${item.source} - ${month}`
}

function conversationKind(item: IntelItem): NonNullable<IntelItem['conversationKind']> {
  return item.conversationKind ?? 'unknown'
}

function recordSize(item: IntelItem) {
  // This is deliberately a conservative character estimate. It includes the
  // compact JSON row scaffolding and avoids a brittle fixed message-count cap.
  return Math.max(96, (item.content || item.summary || '').length + (item.capturedAt || '').length + (item.speaker || '').length + (item.messageType || '').length + 72)
}

function parentCharacterBudget(records: IntelItem[]) {
  const total = records.reduce((sum, record) => sum + recordSize(record), 0)
  // Longer conversations receive smaller requests on a logarithmic curve. The
  // entire conversation is still covered by sequential core ranges; this only
  // controls the size of an individual provider request.
  const scale = Math.log2(Math.max(2, total / 55_000))
  return Math.round(Math.max(14_000, Math.min(34_000, 48_000 / Math.max(1, scale))))
}

function orderedRecords(records: IntelItem[]) {
  return [...records].sort((left, right) => {
    const leftTime = capturedAtTime(left.capturedAt)
    const rightTime = capturedAtTime(right.capturedAt)
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0
    if (Number.isNaN(leftTime)) return 1
    if (Number.isNaN(rightTime)) return -1
    return leftTime - rightTime
  })
}

function precedingOverlap(records: IntelItem[], coreStart: number) {
  let start = coreStart
  let count = 0
  let chars = 0
  while (start > 0 && count < MAX_OVERLAP_RECORDS) {
    const previousSize = recordSize(records[start - 1])
    if (count > 0 && chars + previousSize > MAX_OVERLAP_CHARS) break
    start -= 1
    count += 1
    chars += previousSize
  }
  return start
}

function buildSegments(id: string, name: string, kind: ConversationAnalysisJob['kind'], records: IntelItem[], now: number) {
  const budget = parentCharacterBudget(records)
  const drafts: Array<{
    records: IntelItem[]
    coreRecordIds: string[]
    overlapRecordCount: number
    coreRecordCount: number
    historical: boolean
    priority: number
  }> = []
  let coreStart = 0

  while (coreStart < records.length) {
    let coreEnd = coreStart
    let usedChars = 0
    while (coreEnd < records.length) {
      const nextSize = recordSize(records[coreEnd])
      if (coreEnd > coreStart && usedChars + nextSize > budget) break
      usedChars += nextSize
      coreEnd += 1
    }

    const inputStart = precedingOverlap(records, coreStart)
    const core = records.slice(coreStart, coreEnd)
    const latestCoreTime = Math.max(...core.map((item) => capturedAtTime(item.capturedAt)).filter(Number.isFinite))
    const historical = Number.isFinite(latestCoreTime) && latestCoreTime < now - HISTORY_WINDOW_MS
    const priority = Math.max(...core.map((item) => conversationRelevance(item, now))) + (historical ? 0 : 1)
    drafts.push({
      records: records.slice(inputStart, coreEnd),
      coreRecordIds: core.map((item) => item.id),
      overlapRecordCount: coreStart - inputStart,
      coreRecordCount: core.length,
      historical,
      priority,
    })
    coreStart = coreEnd
  }

  return drafts.map((draft, index) => ({
    id,
    name,
    kind,
    totalRecords: records.length,
    recordCount: draft.records.length,
    segmentIndex: index + 1,
    segmentCount: drafts.length,
    overlapRecordCount: draft.overlapRecordCount,
    coreRecordCount: draft.coreRecordCount,
    coreRecordIds: draft.coreRecordIds,
    historical: draft.historical,
    priority: draft.priority,
    records: draft.records,
  }))
}

export function buildConversationAnalysisPlan(items: IntelItem[], now = Date.now()): ConversationAnalysisPlan {
  const groups = new Map<string, IntelItem[]>()
  items.forEach((item) => {
    const key = conversationKey(item)
    const records = groups.get(key)
    if (records) records.push(item)
    else groups.set(key, [item])
  })

  const jobs: ConversationAnalysisJob[] = []
  let skippedConversations = 0
  for (const [id, records] of groups) {
    const ordered = orderedRecords(records)
    if (!ordered.length) {
      skippedConversations += 1
      continue
    }
    jobs.push(...buildSegments(id, conversationName(records[0]), conversationKind(records[0]), ordered, now))
  }
  // Recent segments run first. Historical segments still run after them and
  // remain part of the same full-conversation coverage.
  jobs.sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name, 'zh-CN') || left.segmentIndex - right.segmentIndex)
  return {
    jobs,
    totalConversations: groups.size,
    totalSegments: jobs.length,
    skippedConversations,
    recordCount: jobs.reduce((count, job) => count + job.coreRecordCount, 0),
  }
}

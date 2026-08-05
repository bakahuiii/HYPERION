import type { AiMultiModelSegmentProfile, IntelItem } from '../types'

const HISTORY_WINDOW_MS = 61 * 24 * 60 * 60 * 1000
// Keep each provider request well below the context/timeout edge of
// compatibility relays. The prompt contains a sizeable fixed instruction
// block and reserves output tokens, so the record budget must stay conservative
// even when a conversation has short messages. Full coverage is preserved by
// sending more ordered segments rather than one oversized request.
const MAX_SEGMENT_CORE_RECORDS = 48
const MAX_SEGMENT_CORE_CHARS = 4_000
const MAX_OVERLAP_RECORDS = 6
const MAX_OVERLAP_CHARS = 1_000

// Person extraction needs a wider chronological view than task extraction.
// Keep this budget independent: changing task segmentation must not silently
// make portraits less contextual or make the task request larger.
const PEOPLE_SEGMENT_CORE_RECORDS = 320
const PEOPLE_SEGMENT_CORE_CHARS = 24_000
const PEOPLE_OVERLAP_RECORDS = 16
const PEOPLE_OVERLAP_CHARS = 3_000

/**
 * The established single-model task window. Future ensemble participants may
 * select another profile, but this value deliberately preserves the proven
 * request size which avoids compatibility-relay 502s.
 */
export const DEFAULT_TASK_SEGMENT_PROFILE: AiMultiModelSegmentProfile = {
  id: 'task-standard',
  maxCoreRecords: MAX_SEGMENT_CORE_RECORDS,
  maxCoreChars: MAX_SEGMENT_CORE_CHARS,
  overlapRecords: MAX_OVERLAP_RECORDS,
  overlapChars: MAX_OVERLAP_CHARS,
  maxOutputTokens: 3_000,
}

/** Wider context is reserved for people evidence extraction, not task calls. */
export const DEFAULT_PEOPLE_SEGMENT_PROFILE: AiMultiModelSegmentProfile = {
  id: 'people-context',
  maxCoreRecords: PEOPLE_SEGMENT_CORE_RECORDS,
  maxCoreChars: PEOPLE_SEGMENT_CORE_CHARS,
  overlapRecords: PEOPLE_OVERLAP_RECORDS,
  overlapChars: PEOPLE_OVERLAP_CHARS,
  maxOutputTokens: 5_500,
}

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

export function inferConversationKind(item: Pick<IntelItem, 'conversationId' | 'conversationKind' | 'conversationName'>): NonNullable<IntelItem['conversationKind']> {
  if (item.conversationKind && item.conversationKind !== 'unknown') return item.conversationKind
  const label = `${item.conversationName ?? ''}/${item.conversationId ?? ''}`
  if (/(?:群聊|群组|群消息|group|groups|chatroom)/i.test(label)) return 'group'
  if (/(?:私聊|单聊|好友|friend|direct|personal)/i.test(label)) return 'direct'
  return 'unknown'
}

function recordSize(item: IntelItem) {
  // Mirror the four-field compact-v2 row sent by aiClient/server instead of
  // counting local audit fields that never enter the model prompt.
  const content = [item.content, item.summary, item.title]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const compactRow = [
    0,
    item.capturedAt || null,
    content?.trim().slice(0, 3_000) || '[non-text message]',
    item.speakerRole || 'unknown',
  ]
  return Math.max(64, JSON.stringify(compactRow).length + 8)
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

function precedingOverlap(records: IntelItem[], coreStart: number, overlapRecords: number, overlapChars: number) {
  let start = coreStart
  let count = 0
  let chars = 0
  while (start > 0 && count < overlapRecords) {
    const previousSize = recordSize(records[start - 1])
    if (count > 0 && chars + previousSize > overlapChars) break
    start -= 1
    count += 1
    chars += previousSize
  }
  return start
}

function buildSegments(
  id: string,
  name: string,
  kind: ConversationAnalysisJob['kind'],
  records: IntelItem[],
  now: number,
  options: { coreRecords: number; coreChars: number; overlapRecords: number; overlapChars: number },
) {
  const budget = options.coreChars
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
      const coreCount = coreEnd - coreStart
      if (coreEnd > coreStart && (coreCount >= options.coreRecords || usedChars + nextSize > budget)) break
      usedChars += nextSize
      coreEnd += 1
    }

    const inputStart = precedingOverlap(records, coreStart, options.overlapRecords, options.overlapChars)
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

export interface ConversationAnalysisPlanOptions {
  coreRecords?: number
  coreChars?: number
  overlapRecords?: number
  overlapChars?: number
}

/** Converts a persisted model capability profile into the existing planner contract. */
export function analysisPlanOptionsForSegmentProfile(profile: Pick<AiMultiModelSegmentProfile, 'maxCoreRecords' | 'maxCoreChars' | 'overlapRecords' | 'overlapChars'>): ConversationAnalysisPlanOptions {
  return {
    coreRecords: profile.maxCoreRecords,
    coreChars: profile.maxCoreChars,
    overlapRecords: profile.overlapRecords,
    overlapChars: profile.overlapChars,
  }
}

export function buildConversationAnalysisPlan(
  items: IntelItem[],
  now = Date.now(),
  options: ConversationAnalysisPlanOptions = {},
): ConversationAnalysisPlan {
  const segmentOptions = {
    coreRecords: Math.max(1, Math.floor(options.coreRecords ?? MAX_SEGMENT_CORE_RECORDS)),
    coreChars: Math.max(256, Math.floor(options.coreChars ?? MAX_SEGMENT_CORE_CHARS)),
    overlapRecords: Math.max(0, Math.floor(options.overlapRecords ?? MAX_OVERLAP_RECORDS)),
    overlapChars: Math.max(0, Math.floor(options.overlapChars ?? MAX_OVERLAP_CHARS)),
  }
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
    jobs.push(...buildSegments(id, conversationName(records[0]), inferConversationKind(records[0]), ordered, now, segmentOptions))
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

/**
 * Builds a complete, deterministic coverage plan for one model capability.
 * It is intentionally pure: callers can compare plans before making any API
 * request, and overlap remains contextual rather than independent evidence.
 */
export function buildConversationAnalysisPlanForProfile(
  items: IntelItem[],
  profile: Pick<AiMultiModelSegmentProfile, 'maxCoreRecords' | 'maxCoreChars' | 'overlapRecords' | 'overlapChars'>,
  now = Date.now(),
) {
  return buildConversationAnalysisPlan(items, now, analysisPlanOptionsForSegmentProfile(profile))
}

/**
 * Person evidence is merged after all windows have completed, so it benefits
 * from fewer, wider chronological requests. Every core record is still sent
 * exactly once; overlap is context only and is removed from coverage counts.
 */
export function buildPeopleConversationAnalysisPlan(items: IntelItem[], now = Date.now()) {
  return buildConversationAnalysisPlanForProfile(items, DEFAULT_PEOPLE_SEGMENT_PROFILE, now)
}

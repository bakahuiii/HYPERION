import type { DailyCheckIn, SelfObservation, SelfObservationKind } from '../types'
import type { SelfAnalysisInput } from './selfJournal'

// This is intentionally independent from task and people segmentation. Self
// analysis needs enough chronological context to preserve a change in tone or
// decision, while retaining the request envelope that has proven stable with
// compatibility relays.
const MAX_CORE_RECORDS = 56
const MAX_CORE_CHARS = 6_000
const MAX_OVERLAP_RECORDS = 8
const MAX_OVERLAP_CHARS = 1_000

const observationKinds: SelfObservationKind[] = [
  'event', 'behavior', 'emotional-state', 'cognition', 'relationship',
  'decision', 'routine', 'stressor', 'coping', 'change', 'uncertainty',
]

export interface SelfAnalysisRecord {
  id: string
  capturedAt: string
  content?: string
  summary: string
  conversationId?: string
  conversationName?: string
  source: string
}

export interface SelfAnalysisSegment {
  id: string
  segmentIndex: number
  segmentCount: number
  records: SelfAnalysisRecord[]
  coreRecordIds: string[]
  coreRecordCount: number
  overlapRecordCount: number
  totalRecords: number
  checkIns: DailyCheckIn[]
}

export interface SelfAnalysisPlan {
  jobs: SelfAnalysisSegment[]
  recordCount: number
  totalSegments: number
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function text(record: Pick<SelfAnalysisRecord, 'content' | 'summary'>) {
  return (record.content?.trim() || record.summary.trim() || '[non-text message]').slice(0, 3_000)
}

function recordSize(record: SelfAnalysisRecord) {
  return Math.max(64, JSON.stringify([record.id, record.capturedAt || null, text(record)]).length + 8)
}

function time(record: Pick<SelfAnalysisRecord, 'capturedAt'>) {
  const value = Date.parse(record.capturedAt)
  return Number.isFinite(value) ? value : Number.NaN
}

function day(value: string) {
  return value.slice(0, 10)
}

function comparableCheckInDate(checkIn: DailyCheckIn) {
  return `${checkIn.date}T12:00:00.000Z`
}

function checkInsForRange(checkIns: DailyCheckIn[], records: SelfAnalysisRecord[]) {
  const start = records[0]?.capturedAt
  const end = records.at(-1)?.capturedAt
  if (!start || !end) return []
  const startDay = day(start)
  const endDay = day(end)
  return checkIns.filter((checkIn) => checkIn.date >= startDay && checkIn.date <= endDay)
}

export function buildSelfAnalysisPlan(input: SelfAnalysisInput): SelfAnalysisPlan {
  const records = input.records
    .map((record) => ({ ...record, summary: record.summary ?? '' }))
    .sort((left, right) => time(left) - time(right) || left.id.localeCompare(right.id))
  const drafts: Array<{ records: SelfAnalysisRecord[]; coreRecordIds: string[]; coreRecordCount: number; overlapRecordCount: number }> = []
  let coreStart = 0

  while (coreStart < records.length) {
    let coreEnd = coreStart
    let usedChars = 0
    while (coreEnd < records.length) {
      const nextSize = recordSize(records[coreEnd])
      if (coreEnd > coreStart && (coreEnd - coreStart >= MAX_CORE_RECORDS || usedChars + nextSize > MAX_CORE_CHARS)) break
      usedChars += nextSize
      coreEnd += 1
    }

    let overlapStart = coreStart
    let overlapChars = 0
    while (overlapStart > 0 && coreStart - overlapStart < MAX_OVERLAP_RECORDS) {
      const nextSize = recordSize(records[overlapStart - 1])
      if (overlapStart < coreStart && overlapChars + nextSize > MAX_OVERLAP_CHARS) break
      overlapStart -= 1
      overlapChars += nextSize
    }
    const core = records.slice(coreStart, coreEnd)
    drafts.push({
      records: records.slice(overlapStart, coreEnd),
      coreRecordIds: core.map((record) => record.id),
      coreRecordCount: core.length,
      overlapRecordCount: coreStart - overlapStart,
    })
    coreStart = coreEnd
  }

  return {
    jobs: drafts.map((draft, index) => ({
      id: `self-${index + 1}`,
      segmentIndex: index + 1,
      segmentCount: drafts.length,
      ...draft,
      totalRecords: records.length,
      checkIns: checkInsForRange(input.dailyCheckins, draft.records),
    })),
    recordCount: records.length,
    totalSegments: drafts.length,
  }
}

export function selfRecordText(record: Pick<SelfAnalysisRecord, 'content' | 'summary'>) {
  return text(record)
}

export function isSelfObservationKind(value: unknown): value is SelfObservationKind {
  return typeof value === 'string' && observationKinds.includes(value as SelfObservationKind)
}

export function selfObservationId(kind: SelfObservationKind, textValue: string, evidence: Array<{ sourceId: string; quote: string }>) {
  const key = `${kind}\u0000${textValue.replace(/\s+/g, '').toLocaleLowerCase('zh-CN')}\u0000${evidence
    .map((item) => `${item.sourceId}:${item.quote.replace(/\s+/g, '')}`)
    .sort()
    .join('|')}`
  return `self-observation-${hash(key)}`
}

/** Keeps overlapping windows and retries idempotent without erasing distinct evidence. */
export function mergeSelfObservations(observations: SelfObservation[]) {
  const byId = new Map<string, SelfObservation>()
  for (const observation of observations) {
    const current = byId.get(observation.id)
    if (!current) {
      byId.set(observation.id, observation)
      continue
    }
    const evidence = [...current.evidence, ...observation.evidence]
      .filter((item, index, values) => values.findIndex((candidate) => candidate.sourceId === item.sourceId && candidate.quote === item.quote) === index)
    const sourceIds = [...new Set(evidence.map((item) => item.sourceId))]
    byId.set(observation.id, {
      ...current,
      evidence,
      sourceIds,
      observedFrom: current.observedFrom < observation.observedFrom ? current.observedFrom : observation.observedFrom,
      observedTo: current.observedTo > observation.observedTo ? current.observedTo : observation.observedTo,
    })
  }
  return [...byId.values()].sort((left, right) => left.observedFrom.localeCompare(right.observedFrom) || left.id.localeCompare(right.id))
}

/**
 * Bounds the final consolidation without dropping a time range. Buckets are
 * chronological three-month windows, further divided only when a dense period
 * exceeds the model's stable claim envelope.
 */
export function groupSelfObservationsForMerge(observations: SelfObservation[], maximum = 120) {
  const groups: SelfObservation[][] = []
  let current: SelfObservation[] = []
  let currentQuarter = ''
  for (const observation of observations) {
    const month = Number(observation.observedFrom.slice(5, 7)) || 1
    const quarter = `${observation.observedFrom.slice(0, 4)}-Q${Math.ceil(month / 3)}`
    if (current.length && (quarter !== currentQuarter || current.length >= maximum)) {
      groups.push(current)
      current = []
    }
    currentQuarter = quarter
    current.push(observation)
  }
  if (current.length) groups.push(current)
  return groups
}

export function analysisRange(observations: SelfObservation[]) {
  const values = observations.flatMap((observation) => [observation.observedFrom, observation.observedTo]).filter(Boolean).sort()
  return { startAt: values[0] ?? '', endAt: values.at(-1) ?? '' }
}

export function checkInTimestamp(checkIn: DailyCheckIn) {
  return comparableCheckInDate(checkIn)
}

import type { DailyAlcoholLevel, DailyCheckIn, DailyMedicationStatus, IntelItem, Profile } from '../types'

export const SELF_JOURNAL_CONVERSATION_ID = 'self-journal'
export const SELF_JOURNAL_CONVERSATION_NAME = '我'
export const SELF_JOURNAL_SOURCE_FILE = 'theia://self-journal'

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function localDate(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000
  return new Date(value.getTime() - offset).toISOString().slice(0, 10)
}

function readableText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n').slice(0, maximum) : ''
}

function boundedHours(value: unknown) {
  const hours = Number(value)
  if (!Number.isFinite(hours)) return undefined
  return Math.round(Math.max(0, Math.min(24, hours)) * 2) / 2
}

function validDate(value: unknown, fallback: string) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}

function medication(value: unknown): DailyMedicationStatus {
  return value === 'yes' || value === 'no' || value === 'reduced' ? value : 'unknown'
}

function alcohol(value: unknown): DailyAlcoholLevel {
  return value === 'none' || value === 'low' || value === 'high' ? value : 'unknown'
}

export function checkInId(date: string) {
  return `self-checkin-${date}`
}

export function normalizeDailyCheckIn(value: unknown, now = new Date()): DailyCheckIn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<DailyCheckIn>
  const date = validDate(input.date, localDate(now))
  const mood = [1, 2, 3, 4, 5].includes(Number(input.mood)) ? Number(input.mood) as DailyCheckIn['mood'] : undefined
  const sleepHours = boundedHours(input.sleepHours)
  const mainFocus = readableText(input.mainFocus, 360)
  const note = readableText(input.note, 1_200)
  const createdAt = typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : now.toISOString()
  const updatedAt = typeof input.updatedAt === 'string' && Number.isFinite(Date.parse(input.updatedAt)) ? input.updatedAt : createdAt
  return {
    id: checkInId(date),
    date,
    ...(mood ? { mood } : {}),
    ...(sleepHours !== undefined ? { sleepHours } : {}),
    medication: medication(input.medication),
    alcohol: alcohol(input.alcohol),
    ...(mainFocus ? { mainFocus } : {}),
    ...(note ? { note } : {}),
    createdAt,
    updatedAt,
  }
}

export function normalizeDailyCheckIns(value: unknown) {
  const byDate = new Map<string, DailyCheckIn>()
  for (const item of Array.isArray(value) ? value : []) {
    const checkIn = normalizeDailyCheckIn(item)
    if (!checkIn) continue
    const existing = byDate.get(checkIn.date)
    if (!existing || Date.parse(checkIn.updatedAt) >= Date.parse(existing.updatedAt)) byDate.set(checkIn.date, checkIn)
  }
  return [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date))
}

export function journalEntry(profile: Profile, content: string, now = new Date()): IntelItem | null {
  const body = readableText(content, 8_000)
  if (!body) return null
  const capturedAt = now.toISOString()
  const idSeed = `${capturedAt}\u0000${body}\u0000${Math.random().toString(36).slice(2)}`
  const name = profile.name.trim() || SELF_JOURNAL_CONVERSATION_NAME
  return {
    id: `self-journal-${Date.now().toString(36)}-${hash(idSeed)}`,
    title: body.length > 40 ? `${body.slice(0, 40)}...` : body,
    summary: body.slice(0, 1_200),
    content: body,
    source: '手动记录',
    sourceFile: SELF_JOURNAL_SOURCE_FILE,
    conversationId: SELF_JOURNAL_CONVERSATION_ID,
    conversationName: SELF_JOURNAL_CONVERSATION_NAME,
    conversationKind: 'direct',
    speaker: name,
    messageType: 'journal',
    speakerRole: 'self',
    capturedAt,
    status: 'reviewed',
  }
}

const medicationLabels: Record<DailyMedicationStatus, string> = { yes: '是', no: '否', reduced: '减量', unknown: '未记录' }
const alcoholLabels: Record<DailyAlcoholLevel, string> = { none: '无', low: '少', high: '多', unknown: '未记录' }

/** The structured daily state is also represented by one stable archive row. */
export function checkInJournalEntry(profile: Profile, checkIn: DailyCheckIn): IntelItem {
  const fields = [
    '[每日状态快照]',
    checkIn.mood ? `状态：${checkIn.mood}/5` : '',
    checkIn.sleepHours !== undefined ? `睡眠：${checkIn.sleepHours} 小时` : '',
    `药物：${medicationLabels[checkIn.medication]}`,
    `酒精：${alcoholLabels[checkIn.alcohol]}`,
    checkIn.mainFocus ? `主要在做：${checkIn.mainFocus}` : '',
    checkIn.note ? `一句话：${checkIn.note}` : '',
  ].filter(Boolean)
  const content = fields.join('\n')
  const name = profile.name.trim() || SELF_JOURNAL_CONVERSATION_NAME
  return {
    id: checkIn.id,
    title: `${checkIn.date} 状态快照`,
    summary: content,
    content,
    source: '手动记录',
    sourceFile: SELF_JOURNAL_SOURCE_FILE,
    conversationId: SELF_JOURNAL_CONVERSATION_ID,
    conversationName: SELF_JOURNAL_CONVERSATION_NAME,
    conversationKind: 'direct',
    speaker: name,
    messageType: 'daily-checkin',
    speakerRole: 'self',
    // A chosen calendar day, not the save moment, is the analytical anchor.
    capturedAt: `${checkIn.date}T12:00:00.000`,
    status: 'reviewed',
  }
}

export function isSelfJournalRecord(item: Pick<IntelItem, 'conversationId'>) {
  return item.conversationId === SELF_JOURNAL_CONVERSATION_ID
}

export function isManualIntelRecord(item: Pick<IntelItem, 'source' | 'sourceFile' | 'conversationId'>) {
  return item.source === '手动记录' || item.sourceFile === SELF_JOURNAL_SOURCE_FILE || isSelfJournalRecord(item)
}

/**
 * A connected export folder is authoritative only for importer-owned rows.
 * Keep locally authored records, and let them win on an accidental ID clash.
 */
export function retainManualIntelRecords(imported: IntelItem[], current: IntelItem[]) {
  const manualById = new Map(current.filter(isManualIntelRecord).map((item) => [item.id, item]))
  const retained = imported.map((item) => {
    const manual = manualById.get(item.id)
    if (!manual) return item
    manualById.delete(item.id)
    return manual
  })
  return [...retained, ...manualById.values()]
}

export interface SelfAnalysisInput {
  analysisTarget: 'self'
  generatedAt: string
  records: Array<Pick<IntelItem, 'id' | 'capturedAt' | 'content' | 'summary' | 'conversationId' | 'conversationName' | 'source'>>
  dailyCheckins: DailyCheckIn[]
}

/**
 * The future self-analysis route consumes this contract, never the
 * counterpart-only person pipeline. It combines every confirmed self message
 * with journals and structured daily anchors in chronological order.
 */
export function buildSelfAnalysisInput(items: IntelItem[], checkIns: DailyCheckIn[], now = new Date()): SelfAnalysisInput {
  const records = items
    .filter((item) => item.speakerRole === 'self')
    .map((item) => ({
      id: item.id,
      capturedAt: item.capturedAt,
      content: item.content,
      summary: item.summary,
      conversationId: item.conversationId,
      conversationName: item.conversationName,
      source: item.source,
    }))
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id))
  return {
    analysisTarget: 'self',
    generatedAt: now.toISOString(),
    records,
    dailyCheckins: normalizeDailyCheckIns(checkIns),
  }
}

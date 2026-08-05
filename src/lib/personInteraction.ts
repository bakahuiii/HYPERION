import type { IntelItem } from '../types'

export interface PersonInteractionSummary {
  firstAt?: string
  lastAt?: string
  totalMessages: number
  selfMessages: number
  otherMessages: number
  unknownMessages: number
  conversationCount: number
}

function timestamp(value?: string) {
  if (!value) return Number.NaN
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function earliest(left?: string, right?: string) {
  if (!left) return right
  if (!right) return left
  const leftTime = timestamp(left)
  const rightTime = timestamp(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime <= rightTime ? left : right
  return left <= right ? left : right
}

function latest(left?: string, right?: string) {
  if (!left) return right
  if (!right) return left
  const leftTime = timestamp(left)
  const rightTime = timestamp(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime >= rightTime ? left : right
  return left >= right ? left : right
}

/** Summarize only exported interaction rows; this is not a relationship score. */
export function summarizePersonInteraction(records: IntelItem[]): PersonInteractionSummary {
  const unique = [...new Map(records.map((record) => [record.id, record])).values()]
  let firstAt: string | undefined
  let lastAt: string | undefined
  let selfMessages = 0
  let otherMessages = 0
  let unknownMessages = 0
  const conversationIds = new Set<string>()
  for (const record of unique) {
    firstAt = earliest(firstAt, record.capturedAt)
    lastAt = latest(lastAt, record.capturedAt)
    if (record.conversationId) conversationIds.add(record.conversationId)
    if (record.speakerRole === 'self') selfMessages += 1
    else if (record.speakerRole === 'other') otherMessages += 1
    else unknownMessages += 1
  }
  return {
    firstAt,
    lastAt,
    totalMessages: unique.length,
    selfMessages,
    otherMessages,
    unknownMessages,
    conversationCount: conversationIds.size,
  }
}

export function relativeInteractionLabel(value?: string, now = Date.now()) {
  const time = timestamp(value)
  if (!Number.isFinite(time)) return '时间未记录'
  const signedDays = Math.floor((now - time) / 86_400_000)
  if (signedDays < 0) {
    const upcomingDays = Math.ceil((time - now) / 86_400_000)
    return upcomingDays === 1 ? '明天' : `${upcomingDays} 天后`
  }
  const diffDays = signedDays
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 30) return `${diffDays} 天前`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} 个月前`
  return `${Math.floor(diffDays / 365)} 年前`
}

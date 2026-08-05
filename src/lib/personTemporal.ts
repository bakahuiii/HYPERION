import type { PersonEvidence, PersonPortraitBlock, PersonPortraitBlockTemporalScope } from '../types'
import { personEvidenceIdentityKey } from './personEvidenceIdentity.ts'

export const PERSON_PORTRAIT_PIPELINE_VERSION = 5
export const PERSON_PORTRAIT_RECENT_WINDOW_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

function timestamp(value?: string) {
  const parsed = new Date(value ?? '').getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

function iso(value?: number) {
  return Number.isFinite(value) ? new Date(value as number).toISOString() : undefined
}

export function personEvidenceObservedAt(claim: Pick<PersonEvidence, 'firstObservedAt' | 'lastObservedAt'>) {
  return timestamp(claim.lastObservedAt) ?? timestamp(claim.firstObservedAt)
}

export function personEvidenceIsPortraitEligible(claim: PersonEvidence) {
  return claim.portraitEligible !== false && claim.category !== 'temporary' && claim.category !== 'filler'
}

export function personEvidenceTemporalScope(
  claim: Pick<PersonEvidence, 'firstObservedAt' | 'lastObservedAt'>,
  analysisAsOf: string,
  recentWindowDays = PERSON_PORTRAIT_RECENT_WINDOW_DAYS,
): 'recent' | 'historical' | 'undated' {
  const observedAt = personEvidenceObservedAt(claim)
  const asOf = timestamp(analysisAsOf)
  if (observedAt === undefined || asOf === undefined) return 'undated'
  return observedAt >= asOf - Math.max(1, recentWindowDays) * DAY_MS ? 'recent' : 'historical'
}

export function personProfileEvidenceScore(claim: PersonEvidence) {
  const compact = `${claim.text} ${claim.quote}`.replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
  let score = claim.kind === 'preference' ? 5 : claim.kind === 'event' ? 8 : 2
  if (claim.stability === 'persistent') score += 6
  else if (claim.stability === 'repeated' || claim.evidenceStrength === 'repeated') score += 4
  if (/(?:喜欢|不喜欢|想要|想去|爱吃|感兴趣|习惯|常去|希望|讨厌|擅长|在意|计划|准备)/.test(compact)) score += 3
  if (claim.quote.trim().length >= 8) score += 1
  if (/^(?:好|哈哈|可以|知道了|收到|嗯|行)[!！?？。,.，]*$/.test(claim.quote.trim())) score -= 6
  if (claim.category === 'temporary' || claim.category === 'filler') score -= 6
  if (claim.category === 'interaction' || claim.category === 'boundary') score += 3
  return score
}

/**
 * Build a bounded model workset without truncating the local evidence archive.
 * Meaningful events and at least one anchor per observed month are selected
 * before recent and repeated claims, so a dense current month cannot erase a
 * relationship-changing episode from the middle of the timeline.
 */
export function selectProfileEvidence(evidence: PersonEvidence[], limit: number, analysisAsOf = new Date().toISOString()) {
  const ordered = [...evidence].sort((left, right) => {
    const leftTime = personEvidenceObservedAt(left)
    const rightTime = personEvidenceObservedAt(right)
    if (leftTime !== undefined && rightTime !== undefined) return leftTime - rightTime
    if (leftTime !== undefined) return -1
    if (rightTime !== undefined) return 1
    return personEvidenceIdentityKey(left).localeCompare(personEvidenceIdentityKey(right))
  })
  if (ordered.length <= limit) return ordered
  const selected = new Set<number>()
  const addRanked = (entries: Array<{ index: number; score: number }>, quota: number) => {
    for (const { index } of entries) {
      if (selected.size >= quota) break
      selected.add(index)
    }
  }
  const ranked = ordered.map((claim, index) => ({ claim, index, score: personProfileEvidenceScore(claim) }))
  addRanked(ranked
    .filter(({ claim }) => personEvidenceIsPortraitEligible(claim)
      && (claim.kind === 'event' || claim.category === 'boundary' || claim.category === 'interaction'))
    .sort((left, right) => right.score - left.score || right.index - left.index), Math.floor(limit * 0.42))
  const monthBest = new Map<string, { index: number; score: number }>()
  for (const entry of ranked) {
    if (!personEvidenceIsPortraitEligible(entry.claim)) continue
    const observedAt = entry.claim.lastObservedAt ?? entry.claim.firstObservedAt
    const month = observedAt?.slice(0, 7) ?? `undated-${entry.index}`
    const current = monthBest.get(month)
    if (!current || entry.score > current.score) monthBest.set(month, { index: entry.index, score: entry.score })
  }
  addRanked([...monthBest.values()].sort((left, right) => left.index - right.index), Math.floor(limit * 0.6))
  addRanked(ranked.filter(({ claim }) => personEvidenceIsPortraitEligible(claim)
    && personEvidenceTemporalScope(claim, analysisAsOf, PERSON_PORTRAIT_RECENT_WINDOW_DAYS) === 'recent')
    .sort((left, right) => right.score - left.score || right.index - left.index), Math.floor(limit * 0.78))
  addRanked(ranked.filter(({ claim }) => claim.evidenceStrength === 'repeated')
    .sort((left, right) => right.score - left.score || right.index - left.index), Math.floor(limit * 0.88))
  addRanked(ranked.sort((left, right) => right.score - left.score || left.index - right.index), limit)
  return [...selected].sort((left, right) => left - right).map((index) => ordered[index])
}

export interface PersonTemporalSummary {
  analysisAsOf: string
  recentWindowDays: number
  recentCutoffAt: string
  recentClaimCount: number
  historicalClaimCount: number
  undatedClaimCount: number
  recentSourceCount: number
  historicalSourceCount: number
  latestEvidenceAt?: string
  latestEvidenceAgeDays?: number
  latestInteractionAt?: string
  latestInteractionAgeDays?: number
  recentEvidenceStatus: 'none' | 'limited' | 'available'
}

export function summarizePersonEvidenceTime(
  evidence: PersonEvidence[],
  analysisAsOf = new Date().toISOString(),
  latestInteractionAt?: string,
  recentWindowDays = PERSON_PORTRAIT_RECENT_WINDOW_DAYS,
): PersonTemporalSummary {
  const asOf = timestamp(analysisAsOf) ?? Date.now()
  const normalizedAsOf = new Date(asOf).toISOString()
  const eligible = evidence.filter(personEvidenceIsPortraitEligible)
  const buckets = {
    recent: [] as PersonEvidence[],
    historical: [] as PersonEvidence[],
    undated: [] as PersonEvidence[],
  }
  for (const claim of eligible) buckets[personEvidenceTemporalScope(claim, normalizedAsOf, recentWindowDays)].push(claim)
  const recentSources = new Set(buckets.recent.flatMap((claim) => claim.sourceIds))
  const historicalSources = new Set(buckets.historical.flatMap((claim) => claim.sourceIds))
  const observedTimes = eligible.map(personEvidenceObservedAt).filter((value): value is number => value !== undefined)
  const latestEvidence = observedTimes.length ? Math.max(...observedTimes) : undefined
  const interaction = timestamp(latestInteractionAt)
  const recentEvidenceStatus = buckets.recent.length === 0
    ? 'none'
    : buckets.recent.length < 6 || recentSources.size < 4
      ? 'limited'
      : 'available'
  return {
    analysisAsOf: normalizedAsOf,
    recentWindowDays,
    recentCutoffAt: new Date(asOf - recentWindowDays * DAY_MS).toISOString(),
    recentClaimCount: buckets.recent.length,
    historicalClaimCount: buckets.historical.length,
    undatedClaimCount: buckets.undated.length,
    recentSourceCount: recentSources.size,
    historicalSourceCount: historicalSources.size,
    ...(iso(latestEvidence) ? { latestEvidenceAt: iso(latestEvidence) } : {}),
    ...(latestEvidence !== undefined ? { latestEvidenceAgeDays: Math.max(0, Math.floor((asOf - latestEvidence) / DAY_MS)) } : {}),
    ...(iso(interaction) ? { latestInteractionAt: iso(interaction) } : {}),
    ...(interaction !== undefined ? { latestInteractionAgeDays: Math.max(0, Math.floor((asOf - interaction) / DAY_MS)) } : {}),
    recentEvidenceStatus,
  }
}

export function portraitBlockTemporalMetadata(
  claims: PersonEvidence[],
  analysisAsOf: string,
  recentWindowDays = PERSON_PORTRAIT_RECENT_WINDOW_DAYS,
): Pick<PersonPortraitBlock, 'temporalScope' | 'observedFrom' | 'observedTo'> {
  const scopes = new Set(claims.map((claim) => personEvidenceTemporalScope(claim, analysisAsOf, recentWindowDays)))
  const dates = claims
    .flatMap((claim) => [timestamp(claim.firstObservedAt), timestamp(claim.lastObservedAt)])
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)
  let temporalScope: PersonPortraitBlockTemporalScope = 'undated'
  if (scopes.has('recent') && scopes.has('historical')) temporalScope = 'change'
  else if (scopes.has('recent')) temporalScope = 'recent'
  else if (scopes.has('historical')) temporalScope = 'historical'
  return {
    temporalScope,
    ...(dates[0] !== undefined ? { observedFrom: new Date(dates[0]).toISOString() } : {}),
    ...(dates.at(-1) !== undefined ? { observedTo: new Date(dates.at(-1) as number).toISOString() } : {}),
  }
}

export function historicalPortraitTextIsQualified(text: string) {
  return /(?:过去|当时|此前|早期|一度|曾经|曾|原先|在[^。；\n]{0,24}(?:年|月|记录|阶段)|截至[^。；\n]{0,18})/.test(text)
}

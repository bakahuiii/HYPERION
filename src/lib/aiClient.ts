import type { AiSettings, AiTaskCandidate, IntelItem, Person, Place, Quest } from '../types'
import { buildConversationAnalysisPlan } from './conversationAnalysis'
import { apiUrl } from './apiUrl'
import { normalizeAiConcurrency } from './aiConcurrency'

export interface AiAttachment {
  name: string
  mimeType: string
  data: string
}

export interface AiStatus {
  configured: boolean
  key: string
  model: string
  apiMode: 'auto' | 'responses' | 'chat-completions'
  baseUrl: string
  provider: string
  keyHint: string
  source: 'settings-ini' | 'local-file' | 'environment'
  models: string[]
  id?: string
  name?: string
  enabled?: boolean
  maxConcurrency?: number
  configurationError?: string
  primaryProviderId?: string
  channels?: AiProviderChannel[]
  configuredChannelCount?: number
  totalMaxConcurrency?: number
  scheduler?: AiProviderScheduler
  warning?: string
}

export interface AiProviderRuntime {
  status: 'ready' | 'disabled' | 'invalid' | 'unconfigured' | 'cooling-down' | 'at-capacity' | string
  healthy: boolean
  activeRequests: number
  availableSlots: number
  cooldownUntil: string | null
  cooldownRemainingMs: number
  successfulRequests: number
  failedRequests: number
  consecutiveFailures: number
  lastSelectedAt: string | null
  lastCompletedAt: string | null
  lastErrorAt: string | null
  lastErrorStatus: number | null
  lastErrorCode: string | null
}

export interface AiProviderChannel {
  id: string
  name: string
  enabled: boolean
  configured: boolean
  key: string
  model: string
  apiMode: AiStatus['apiMode']
  baseUrl: string
  provider: string
  keyHint: string
  source?: AiStatus['source']
  models: string[]
  maxConcurrency: number
  configurationError?: string
  runtime?: AiProviderRuntime
}

export interface AiProviderScheduler {
  queueDepth: number
  activeRequests: number
  availableCapacity: number
  totalMaxConcurrency: number
  coolingDownChannelCount: number
}

export interface AiProviderInput {
  _type?: 'newapi_channel_conn'
  key?: string
  apiKey?: string
  url?: string
  baseURL?: string
  id?: string
  name?: string
  enabled?: boolean
  maxConcurrency?: number
  primary?: boolean
  model?: string
  apiMode?: AiStatus['apiMode']
  models?: string[]
}

export interface AiChannelMutationResult extends AiStatus {
  pool?: AiStatus
  channel?: AiProviderChannel
}

export interface AiModelsResult {
  baseUrl: string
  models: string[]
}

export interface PersonConsolidation {
  facts: string[]
  preferences: string[]
  advice: string[]
  portrait?: string
  model: string
}

export interface TaskGuidanceContext {
  quest: Pick<Quest, 'id' | 'title' | 'description' | 'startAt' | 'dueAt'>
  place?: Pick<Place, 'name' | 'lat' | 'lng' | 'note' | 'precision'>
  people: Array<Pick<Person, 'name' | 'facts' | 'preferences' | 'advice' | 'portrait'>>
  weather?: {
    date: string
    condition: string
    temperatureMin?: number
    temperatureMax?: number
    precipitationProbability?: number
  }
  /** Per-workflow requirements, persisted in the shared options INI. */
  settings?: Pick<AiSettings, 'promptInstructions'>
}

export interface AiProgress {
  completed: number
  total: number
  candidates: number
  rawCandidates?: number
  recordCount?: number
  failedConversations?: number
  skippedUnverifiedConversations?: number
  currentConversation?: string
  retryAttempt?: number
  retryTotal?: number
  retryDelayMs?: number
  currentSegment?: number
  totalSegmentsInConversation?: number
  historicalSegment?: boolean
  /** Number of requests currently in flight across independent conversations. */
  activeWorkers?: number
  /** Effective concurrency after clamping to the selected conversation count. */
  concurrency?: number
}

export interface AiFailedConversation {
  id: string
  name: string
  message: string
  retryable: boolean
  failedSegments?: number
  totalSegments?: number
}

/** Local diagnostic metadata. Raw chat text and credentials are never logged. */
export interface AiDebugEntry {
  at: string
  event: string
  level: 'info' | 'warn' | 'error'
  conversationId?: string
  conversationName?: string
  recordCount?: number
  attempt?: number
  attemptTotal?: number
  retryDelayMs?: number
  status?: number
  candidateCount?: number
  acceptedCandidateCount?: number
  peopleCount?: number
  peopleIncluded?: boolean
  segmentIndex?: number
  segmentCount?: number
  coreRecordCount?: number
  overlapRecordCount?: number
  historical?: boolean
  message?: string
}

type AiDebugWriter = (entry: AiDebugEntry) => void

export interface AiAnalysisDiagnostics {
  attemptedConversations: number
  emptyModelResponses: number
  rawCandidates: number
  rejectedOwnership: number
  rejectedEvidence: number
  rejectedExpired: number
  rejectedDirection: number
  rejectedInvalid: number
  rejectedDuplicate: number
}

const MAX_SERVICE_ATTEMPTS = 5
function analysisConcurrency(value: number | undefined, availableQueues: number) {
  const requested = normalizeAiConcurrency(value)
  return Math.min(requested, Math.max(1, availableQueues))
}

function abortError() {
  const error = new Error('提炼已停止')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

function wasAborted(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

async function requestJson<T>(url: string, options?: { method?: 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  throwIfAborted(options?.signal)
  const response = await fetch(apiUrl(url), options ? {
    method: options.method ?? 'POST',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  } : undefined)
  const raw = await response.text()
  let payload: T & { error?: string; retry_after?: number }
  try { payload = JSON.parse(raw) as T & { error?: string; retry_after?: number } } catch { payload = {} as T & { error?: string; retry_after?: number } }
  if (!response.ok) {
    const error = new Error(payload.error || raw.slice(0, 1200) || `请求失败 (${response.status})`)
    Object.assign(error, { status: response.status, retryAfter: Number(payload.retry_after) })
    throw error
  }
  return payload
}

function retryable(error: unknown) {
  const status = Number((error as { status?: number })?.status)
  return status === 408 || status === 429 || status >= 500 || /\b(?:502|503|504)\b|bad gateway|temporarily unavailable/i.test(error instanceof Error ? error.message : '')
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', cancelled)
      resolve()
    }, milliseconds)
    const cancelled = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      reject(abortError())
    }
    signal?.addEventListener('abort', cancelled, { once: true })
  })
}

async function requestWithRetry<T>(url: string, body: unknown, onRetry?: (notice: { attempt: number; total: number; delayMs: number }) => void, signal?: AbortSignal) {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_SERVICE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal)
    try { return await requestJson<T>(url, { body, signal }) } catch (error) {
      if (wasAborted(error) || signal?.aborted) throw abortError()
      lastError = error
      if (!retryable(error) || attempt === MAX_SERVICE_ATTEMPTS) break
      const status = Number((error as { status?: number })?.status)
      const suggested = Number((error as { retryAfter?: number })?.retryAfter)
      // Gateway errors from an overloaded relay are handled by smaller request
      // segments. Waiting the relay's generic 60-second suggestion only makes
      // a batch appear stuck, so use a short capped backoff for 5xx responses.
      const delayMs = status >= 500
        ? Math.min(3_000, 500 * 2 ** (attempt - 1))
        : Number.isFinite(suggested) && suggested > 0
          ? Math.min(suggested * 1000, 8_000)
          : Math.min(5_000, 800 * attempt ** 2)
      onRetry?.({ attempt: attempt + 1, total: MAX_SERVICE_ATTEMPTS, delayMs })
      await wait(delayMs, signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模型请求失败')
}

export async function getAiStatus() {
  return requestJson<AiStatus>('/api/ai/status')
}

export async function saveAiProvider(config: AiProviderInput) {
  return requestJson<AiStatus>('/api/ai/config', { method: 'POST', body: config })
}

/** Adds a second (or later) independent API channel to the local provider pool. */
export async function createAiProviderChannel(config: AiProviderInput) {
  return requestJson<AiChannelMutationResult>('/api/ai/channels', { method: 'POST', body: config })
}

/** Updates one channel without exposing credentials to the renderer console. */
export async function updateAiProviderChannel(id: string, config: AiProviderInput) {
  return requestJson<AiChannelMutationResult>(`/api/ai/channels/${encodeURIComponent(id)}`, { method: 'POST', body: config })
}

export async function deleteAiProviderChannel(id: string) {
  return requestJson<AiStatus>(`/api/ai/channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function discoverAiModels(config: AiProviderInput) {
  return requestJson<AiModelsResult>('/api/ai/models', { method: 'POST', body: config })
}

export async function resetAiProvider() {
  return requestJson<AiStatus>('/api/ai/config', { method: 'DELETE' })
}

/** Generates optional, task-specific suggestions from already extracted profile evidence. */
export async function generateTaskGuidance(context: TaskGuidanceContext) {
  const payload = await requestWithRetry<{ guidance?: unknown; model?: unknown }>('/api/ai/task-guidance', context)
  return {
    guidance: Array.isArray(payload.guidance)
      ? [...new Set(payload.guidance.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 4)
      : [],
    model: String(payload.model ?? 'unknown'),
  }
}

/** Consolidates only already-evidence-backed notes; it never sends raw chat text. */
export async function consolidatePerson(person: Pick<Person, 'name' | 'facts' | 'preferences' | 'advice' | 'portrait'>, settings?: Pick<AiSettings, 'promptInstructions'>): Promise<PersonConsolidation | null> {
  const verifiedFacts = [...new Set(person.facts.map((fact) => fact.trim()).filter(Boolean))].slice(0, 48)
  const verifiedPreferences = [...new Set((person.preferences ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 18)
  const payload = await requestWithRetry<{ facts?: unknown; preferences?: unknown; advice?: unknown; portrait?: unknown; model?: unknown }>('/api/ai/people/merge', {
    person: {
      name: person.name,
      facts: verifiedFacts,
      preferences: verifiedPreferences,
      advice: [...new Set((person.advice ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 9),
      portrait: person.portrait ?? null,
    },
    settings: {
      promptInstructions: {
        peopleMerge: settings?.promptInstructions?.peopleMerge ?? '',
      },
    },
  })
  const facts = Array.isArray(payload.facts)
    ? [...new Set(payload.facts.map(String).map((fact) => fact.trim()).filter((fact) => verifiedFacts.includes(fact)))].slice(0, 12)
    : []
  if (!facts.length) return null
  const portrait = typeof payload.portrait === 'string' && payload.portrait.trim()
    ? payload.portrait.trim().slice(0, 360)
    : undefined
  const preferences = Array.isArray(payload.preferences)
    ? [...new Set(payload.preferences.map(String).map((item) => item.trim()).filter((item) => verifiedPreferences.includes(item)))].slice(0, 8)
    : []
  const advice = Array.isArray(payload.advice)
    ? [...new Set(payload.advice.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 4)
    : []
  return { facts, preferences, advice, portrait, model: String(payload.model ?? 'unknown') }
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function hasMessageTimestamp(item: IntelItem) {
  return Number.isFinite(new Date(item.capturedAt).getTime())
}

function hasAbsoluteCalendarDate(item: IntelItem) {
  return /20\d{2}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}/.test(item.summary)
}

function isDirectTaskForUser(item: IntelItem) {
  return /(?:请你|麻烦你|需要你|你(?:要|去|得|需要|记得|别忘|先)|别忘了)/.test(item.summary)
}

function supportsUserOwnedTask(evidence: IntelItem[]) {
  return evidence.some((item) => item.speakerRole === 'self')
    || evidence.some((item) => item.speakerRole === 'other' && isDirectTaskForUser(item))
}

function latestEvidenceTime(evidence: IntelItem[]) {
  return [...evidence]
    .filter((item) => item.capturedAt.trim())
    .sort((left, right) => {
      const leftTime = new Date(left.capturedAt).getTime()
      const rightTime = new Date(right.capturedAt).getTime()
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime
      return right.capturedAt.localeCompare(left.capturedAt)
    })[0]?.capturedAt
}

function localDateTime(value: string | undefined, endOfDay = false) {
  if (!value) return Number.NaN
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).getTime()
  return new Date(value).getTime()
}

function isExpiredCandidate(candidate: AiTaskCandidate, evidence: IntelItem[], settings: AiSettings) {
  const now = Date.now()
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startTime = localDateTime(candidate.startAt)
  const dueTime = localDateTime(candidate.dueAt, true)
  if (Number.isFinite(dueTime) && dueTime < todayStart) return true
  if (Number.isFinite(startTime) && startTime < todayStart && (!Number.isFinite(dueTime) || dueTime < now)) return true
  if ((Number.isFinite(startTime) && startTime >= todayStart) || (Number.isFinite(dueTime) && dueTime >= todayStart)) return false

  // Older saved candidates can outlive a compacted raw-intel snapshot. Their
  // cited source timestamp remains a valid fallback for expiry checks.
  const latestTime = localDateTime(latestEvidenceTime(evidence) ?? candidate.sourceCapturedAt)
  if (!Number.isFinite(latestTime)) return false
  const ageDays = Math.max(0, (now - latestTime) / 86_400_000)
  const policy = settings.recencyPolicy ?? 'balanced'
  const transientDays = policy === 'strict' ? 2 : policy === 'broad' ? 7 : 4
  const submissionDays = policy === 'strict' ? 14 : policy === 'broad' ? 60 : 30
  const text = `${candidate.title} ${candidate.description}`
  if (/快递|取件|取货|取餐|外卖|包裹|验证码|签到|临时码|柜.*件/.test(text) && ageDays > transientDays) return true
  if (/提交|投稿|征集|报名|问卷|填表|经验分享|上传材料|交材料/.test(text) && !candidate.dueAt && ageDays > submissionDays) return true
  return false
}

function reversesInvitationDirection(candidate: AiTaskCandidate, evidence: IntelItem[]) {
  const otherOffers = evidence.some((item) => item.speakerRole === 'other' && /(?:我|俺).{0,6}(?:请|邀请|带|陪|帮)你/.test(item.content || item.summary))
  const selfOffers = evidence.some((item) => item.speakerRole === 'self' && /(?:我|俺).{0,6}(?:请|邀请|带|陪|帮)(?:你|他|她)/.test(item.content || item.summary))
  return otherOffers && !selfOffers && /(?:^|开学后|之后|到时).{0,8}(?:请|邀请).{0,24}(?:喝|吃|见面|玩|台球|咖啡)/.test(candidate.title)
}

/**
 * Keep one deterministic screen for both newly returned and already-pending
 * candidates. Only evidence-backed expiry and direction mistakes are removed
 * automatically; ambiguous items remain available for the user's review.
 */
export function candidateRejectionReason(candidate: AiTaskCandidate, evidence: IntelItem[], settings: AiSettings): 'expired' | 'ownership' | undefined {
  if (isExpiredCandidate(candidate, evidence, settings)) return 'expired'
  if (reversesInvitationDirection(candidate, evidence)) return 'ownership'
  return undefined
}

function normalizeCandidate(
  value: Partial<AiTaskCandidate> & { title?: string; description?: string; actionOwner?: unknown },
  model: string,
  index: number,
  allowTemporalFields = false,
  sourceCapturedAt?: string,
): AiTaskCandidate | null {
  if (value.actionOwner !== 'self') return null
  const title = String(value.title ?? '').trim().slice(0, 120)
  const description = String(value.description ?? '').trim().slice(0, 1000)
  const sourceIds = Array.isArray(value.sourceIds) ? value.sourceIds.map(String).slice(0, 30) : []
  if (!title || !description || !sourceIds.length) return null
  const people = Array.isArray(value.people) ? value.people.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12) : []
  const tags = Array.isArray(value.tags) ? value.tags.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 10) : []
  const guidance = Array.isArray(value.guidance) ? value.guidance.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 3) : []
  const key = `${title}|${description}|${sourceIds.join(',')}`
  return {
    id: `ai-${hash(key)}-${index}`,
    title,
    description,
    startAt: allowTemporalFields && typeof value.startAt === 'string' && value.startAt.trim() ? value.startAt.trim().slice(0, 40) : undefined,
    dueAt: allowTemporalFields && typeof value.dueAt === 'string' && value.dueAt.trim() ? value.dueAt.trim().slice(0, 40) : undefined,
    sourceCapturedAt,
    sourceIds,
    people,
    place: typeof value.place === 'string' && value.place.trim() ? value.place.trim().slice(0, 120) : undefined,
    locationPrecision: value.locationPrecision === 'exact' || value.locationPrecision === 'approximate' || value.locationPrecision === 'unknown' ? value.locationPrecision : undefined,
    locationRadiusMeters: Number.isFinite(Number(value.locationRadiusMeters)) && Number(value.locationRadiusMeters) > 0 ? Math.min(100_000, Math.max(50, Math.round(Number(value.locationRadiusMeters)))) : undefined,
    tags,
    guidance,
    model,
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
}

interface PersonEvidenceClaim {
  text?: unknown
  sourceIds?: unknown
  quote?: unknown
}

function normalizedEvidenceText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
}

function verifyPersonClaim(
  value: unknown,
  name: string,
  allowedIds: Set<string>,
  recordsById: Map<string, IntelItem>,
) {
  const claim = value as PersonEvidenceClaim
  const text = typeof claim?.text === 'string' ? claim.text.trim().slice(0, 360) : ''
  const quote = typeof claim?.quote === 'string' ? claim.quote.trim().slice(0, 100) : ''
  const normalizedQuote = normalizedEvidenceText(quote)
  const sourceIds = Array.isArray(claim?.sourceIds)
    ? [...new Set(claim.sourceIds.map(String).filter((id) => allowedIds.has(id)))].slice(0, 12)
    : []
  if (!text || normalizedQuote.length < 2 || !sourceIds.length) return null
  const verifiedSourceIds = sourceIds.filter((id) => {
    const record = recordsById.get(id)
    if (!record || record.speakerRole !== 'other' || record.speaker?.trim() !== name) return false
    return normalizedEvidenceText(record.content || record.summary).includes(normalizedQuote)
  })
  if (!verifiedSourceIds.length) return null
  return { text, sourceIds: verifiedSourceIds }
}

function normalizePerson(
  value: Partial<Person> & { name?: string; facts?: unknown; preferences?: unknown; advice?: unknown; sourceIds?: unknown; platforms?: unknown; portrait?: unknown },
  model: string,
  index: number,
  allowedIds: Set<string>,
  allowedPlatforms: Set<IntelItem['source']>,
  recordsById: Map<string, IntelItem>,
): Person | null {
  const name = String(value.name ?? '').trim().slice(0, 120)
  if (!name) return null
  const factClaims = Array.isArray(value.facts)
    ? value.facts.map((claim) => verifyPersonClaim(claim, name, allowedIds, recordsById)).filter((claim): claim is { text: string; sourceIds: string[] } => Boolean(claim))
    : []
  const preferenceClaims = Array.isArray(value.preferences)
    ? value.preferences.map((claim) => verifyPersonClaim(claim, name, allowedIds, recordsById)).filter((claim): claim is { text: string; sourceIds: string[] } => Boolean(claim))
    : []
  const facts = [...new Set(factClaims.map((claim) => claim.text))].slice(0, 12)
  const preferences = [...new Set(preferenceClaims.map((claim) => claim.text))].slice(0, 8)
  const sourceIds = [...new Set([...factClaims, ...preferenceClaims].flatMap((claim) => claim.sourceIds))].slice(0, 30)
  if (!facts.length && !preferences.length) return null
  const evidence = sourceIds.map((id) => recordsById.get(id)).filter((item): item is IntelItem => Boolean(item))
  const verifiedCounterparts = new Set([...recordsById.values()]
    .filter((item) => item.speakerRole === 'other' && item.speaker?.trim())
    .map((item) => item.speaker!.trim()))
  // A model may summarize a private conversation, but it must never invent a
  // participant or turn the user's own name into the counterpart.
  if (!verifiedCounterparts.has(name) || !evidence.some((item) => item.speakerRole === 'other' && item.speaker?.trim() === name)) return null
  const datedEvidence = evidence
    .map((item) => ({ capturedAt: item.capturedAt, time: new Date(item.capturedAt).getTime() }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => left.time - right.time)
  const firstObservedAt = datedEvidence[0]?.capturedAt ?? evidence.map((item) => item.capturedAt).sort()[0]
  const lastObservedAt = datedEvidence[datedEvidence.length - 1]?.capturedAt ?? evidence.map((item) => item.capturedAt).sort().slice(-1)[0]
  const conversationIds = [...new Set(evidence.map((item) => item.conversationId).filter((id): id is string => Boolean(id)))].slice(0, 30)
  const evidenceSignalCount = facts.length + preferences.length
  const portrait = evidenceSignalCount >= 2 && typeof value.portrait === 'string' && value.portrait.trim()
    ? value.portrait.trim().slice(0, 220)
    : undefined
  const advice = evidenceSignalCount >= 2 && Array.isArray(value.advice)
    ? [...new Set(value.advice.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 4)
    : []
  const avatarUrl = evidence.find((item) => item.speakerRole === 'other' && item.speaker?.trim() === name && item.avatarUrl)?.avatarUrl
  const id = `person-${hash(`${name}|${[...sourceIds].sort().join(',')}`)}-${index}`
  const platforms = [...new Set(evidence.map((item) => item.source).filter((platform): platform is IntelItem['source'] => allowedPlatforms.has(platform)))].slice(0, 8)
  return { id, name, avatarUrl, facts, preferences, advice, sourceIds, conversationIds, firstObservedAt, lastObservedAt, portrait, platforms, model, createdAt: new Date().toISOString() }
}

export async function analyzeIntelLegacy(
  items: IntelItem[],
  attachments: AiAttachment[],
  settings: AiSettings,
  onProgress?: (progress: AiProgress) => void,
  onLog?: (entry: AiDebugEntry) => void,
) {
  const candidates: AiTaskCandidate[] = []
  const seen = new Set<string>()
  const analyzedIds: string[] = []
  const plan = buildConversationAnalysisPlan(items)
  const log = (event: string, level: AiDebugEntry['level'], details: Omit<AiDebugEntry, 'at' | 'event' | 'level'> = {}) => {
    onLog?.({ at: new Date().toISOString(), event, level, ...details })
  }
  log('run_started', 'info', { recordCount: items.length, message: `准备处理 ${plan.jobs.length} 个完整会话` })
  const failedConversations: AiFailedConversation[] = []
  const diagnostics: AiAnalysisDiagnostics = {
    attemptedConversations: 0,
    emptyModelResponses: 0,
    rawCandidates: 0,
    rejectedOwnership: 0,
    rejectedEvidence: 0,
    rejectedExpired: 0,
    rejectedDirection: 0,
    rejectedInvalid: 0,
    rejectedDuplicate: 0,
  }
  let skippedUnverifiedConversations = 0
  let model = 'unknown'
  let consecutiveFailures = 0
  let processedConversations = 0
  let stoppedByServiceFailures = false
  let attachmentsSent = false
  for (const [index, conversation] of plan.jobs.entries()) {
    processedConversations = index + 1
    if (!supportsUserOwnedTask(conversation.records)) {
      skippedUnverifiedConversations += 1
      log('conversation_skipped_unverified_direction', 'warn', { conversationId: conversation.id, conversationName: conversation.name, recordCount: conversation.records.length, message: '导出记录未提供可核验的用户发言或直接请求' })
      onProgress?.({ completed: index + 1, total: plan.jobs.length, candidates: candidates.length, recordCount: plan.recordCount, failedConversations: failedConversations.length, skippedUnverifiedConversations, currentConversation: conversation.name })
      continue
    }
    try {
      diagnostics.attemptedConversations += 1
      log('conversation_request_started', 'info', { conversationId: conversation.id, conversationName: conversation.name, recordCount: conversation.records.length })
      const sourceById = new Map(conversation.records.map((item) => [item.id, item]))
      const requestPayload = {
        conversation: {
          id: conversation.id,
          name: conversation.name,
          kind: conversation.kind,
          totalRecords: conversation.totalRecords,
          recordCount: conversation.records.length,
        },
        records: conversation.records.map((item) => ({
          id: item.id,
          formattedTime: item.capturedAt || null,
          type: item.messageType ?? null,
          content: item.content || item.summary,
          senderDisplayName: item.speaker ?? null,
          speakerRole: item.speakerRole ?? 'unknown',
        })),
        attachments: attachmentsSent ? [] : attachments,
        settings: {
          mode: settings.mode,
          instructions: settings.instructions,
          recencyPolicy: settings.recencyPolicy ?? 'balanced',
          promptInstructions: { task: settings.promptInstructions.task },
          feedback: (settings.feedback ?? []).slice(-8).map((item) => ({ title: item.title, description: item.description, decision: item.decision, reason: item.reason, sourceCapturedAt: item.sourceCapturedAt })),
        },
      }
      const payload = await requestWithRetry<{
        model: string
        candidates: unknown[]
        people?: unknown[]
        peopleIncluded?: boolean
        apiModeUsed?: string
        receivedRecordCount?: number
      }>('/api/ai/analyze', requestPayload, (notice) => {
        log('conversation_retry_scheduled', 'warn', { conversationId: conversation.id, conversationName: conversation.name, recordCount: conversation.records.length, attempt: notice.attempt, attemptTotal: notice.total, retryDelayMs: notice.delayMs, message: `${Math.ceil(notice.delayMs / 1000)} 秒后自动重连` })
        onProgress?.({ completed: index, total: plan.jobs.length, candidates: candidates.length, recordCount: plan.recordCount, failedConversations: failedConversations.length, skippedUnverifiedConversations, currentConversation: conversation.name, retryAttempt: notice.attempt, retryTotal: notice.total, retryDelayMs: notice.delayMs })
      })
      if (payload.receivedRecordCount !== conversation.records.length) throw new Error(`会话“${conversation.name}”上传条数校验失败：本机准备 ${conversation.records.length} 条，服务收到 ${payload.receivedRecordCount ?? 0} 条。`)
      attachmentsSent = true
      consecutiveFailures = 0
      model = payload.model
      const modelCandidates = Array.isArray(payload.candidates) ? payload.candidates : []
      const candidateCountBeforeValidation = modelCandidates.length
      const acceptedCandidateCountBefore = candidates.length
      diagnostics.rawCandidates += modelCandidates.length
      if (!modelCandidates.length) diagnostics.emptyModelResponses += 1
      modelCandidates.forEach((value, candidateIndex) => {
        const raw = value as Partial<AiTaskCandidate> & { actionOwner?: unknown }
        if (raw.actionOwner !== 'self') {
          diagnostics.rejectedOwnership += 1
          return
        }
        const evidence = Array.isArray(raw.sourceIds) ? raw.sourceIds.map(String).map((id) => sourceById.get(id)).filter((item): item is IntelItem => Boolean(item)) : []
        if (!supportsUserOwnedTask(evidence)) {
          diagnostics.rejectedEvidence += 1
          return
        }
        const hasTemporalAnchor = evidence.some((item) => hasMessageTimestamp(item) || hasAbsoluteCalendarDate(item))
        const candidate = normalizeCandidate(raw, model, index * 1000 + candidateIndex, hasTemporalAnchor, latestEvidenceTime(evidence))
        if (!candidate) {
          diagnostics.rejectedInvalid += 1
          return
        }
        const rejectionReason = candidateRejectionReason(candidate, evidence, settings)
        if (rejectionReason === 'expired') {
          diagnostics.rejectedExpired += 1
          return
        }
        if (rejectionReason === 'ownership') {
          diagnostics.rejectedDirection += 1
          return
        }
        const key = `${candidate.title.toLowerCase()}|${candidate.description.toLowerCase()}`
        if (seen.has(key)) {
          diagnostics.rejectedDuplicate += 1
          return
        }
        seen.add(key)
        candidates.push(candidate)
      })
      log('conversation_request_succeeded', 'info', {
        conversationId: conversation.id,
        conversationName: conversation.name,
        recordCount: conversation.records.length,
        candidateCount: candidateCountBeforeValidation,
        acceptedCandidateCount: candidates.length - acceptedCandidateCountBefore,
        message: `模型 ${payload.model}${payload.apiModeUsed ? ` · ${payload.apiModeUsed}` : ''}`,
      })
      analyzedIds.push(...conversation.records.map((item) => item.id))
    } catch (error) {
      const canRetry = retryable(error)
      const message = (error instanceof Error ? error.message : '模型请求失败').slice(0, 280)
      failedConversations.push({
        id: conversation.id,
        name: conversation.name,
        message,
        retryable: canRetry,
      })
      log('conversation_request_failed', 'error', { conversationId: conversation.id, conversationName: conversation.name, recordCount: conversation.records.length, status: Number((error as { status?: number })?.status) || undefined, message })
      consecutiveFailures = canRetry ? consecutiveFailures + 1 : 0
      if (canRetry && consecutiveFailures >= 3) {
        stoppedByServiceFailures = true
        onProgress?.({ completed: index + 1, total: plan.jobs.length, candidates: candidates.length, recordCount: plan.recordCount, failedConversations: failedConversations.length, skippedUnverifiedConversations, currentConversation: conversation.name })
        break
      }
    }
    onProgress?.({ completed: index + 1, total: plan.jobs.length, candidates: candidates.length, recordCount: plan.recordCount, failedConversations: failedConversations.length, skippedUnverifiedConversations, currentConversation: conversation.name })
  }
  log('run_completed', failedConversations.length ? 'warn' : 'info', {
    recordCount: items.length,
    candidateCount: diagnostics.rawCandidates,
    acceptedCandidateCount: candidates.length,
    message: `完成 ${processedConversations}/${plan.jobs.length} 个会话；失败 ${failedConversations.length}，跳过 ${skippedUnverifiedConversations}；校验排除：归属 ${diagnostics.rejectedOwnership}、证据 ${diagnostics.rejectedEvidence}、过期 ${diagnostics.rejectedExpired}、方向 ${diagnostics.rejectedDirection}、格式 ${diagnostics.rejectedInvalid}、重复 ${diagnostics.rejectedDuplicate}`,
  })
  return { candidates, analyzedIds, model, plan, failedConversations, skippedUnverifiedConversations, processedConversations, stoppedByServiceFailures, diagnostics }
}

function hasFutureCalendarTask(candidate: AiTaskCandidate) {
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const start = localDateTime(candidate.startAt)
  const due = localDateTime(candidate.dueAt, true)
  return (Number.isFinite(start) && start >= todayStart) || (Number.isFinite(due) && due >= todayStart)
}

/**
 * Sends every imported message while keeping each individual provider request
 * small enough for compatibility relays. A parent conversation is segmented
 * by a logarithmic character budget, never by a fixed message-count cap.
 */
export async function analyzeIntel(
  items: IntelItem[],
  attachments: AiAttachment[],
  settings: AiSettings,
  onProgress?: (progress: AiProgress) => void,
  onLog?: (entry: AiDebugEntry) => void,
  onPeople?: (people: Person[]) => void,
  options?: { signal?: AbortSignal; concurrency?: number },
) {
  const candidates: AiTaskCandidate[] = []
  const people: Person[] = []
  const seen = new Set<string>()
  const plan = buildConversationAnalysisPlan(items)
  const candidateBatches = new Map<number, AiTaskCandidate[]>()
  const peopleBatches = new Map<number, Person[]>()
  const modelsBySegment = new Map<number, string>()
  const successfulSegments = new Map<string, Set<number>>()
  const peopleIncludedSegments = new Map<string, Set<number>>()
  const directConversationIds = new Set<string>()
  const allRecordIds = new Map<string, Set<string>>()
  const segmentCounts = new Map<string, number>()
  const conversationRecords = new Map<string, IntelItem[]>()
  const failures = new Map<string, AiFailedConversation>()
  const diagnostics: AiAnalysisDiagnostics = {
    attemptedConversations: 0,
    emptyModelResponses: 0,
    rawCandidates: 0,
    rejectedOwnership: 0,
    rejectedEvidence: 0,
    rejectedExpired: 0,
    rejectedDirection: 0,
    rejectedInvalid: 0,
    rejectedDuplicate: 0,
  }
  const log = (event: string, level: AiDebugEntry['level'], details: Omit<AiDebugEntry, 'at' | 'event' | 'level'> = {}) => {
    onLog?.({ at: new Date().toISOString(), event, level, ...details })
  }
  for (const job of plan.jobs) {
    segmentCounts.set(job.id, job.segmentCount)
    if (job.kind === 'direct') directConversationIds.add(job.id)
    const recordIds = allRecordIds.get(job.id) ?? new Set<string>()
    job.coreRecordIds.forEach((id) => recordIds.add(id))
    allRecordIds.set(job.id, recordIds)
  }
  for (const item of items) {
    if (item.conversationKind !== 'direct' || !item.conversationId) continue
    const records = conversationRecords.get(item.conversationId)
    if (records) records.push(item)
    else conversationRecords.set(item.conversationId, [item])
  }

  log('run_started', 'info', {
    recordCount: items.length,
    message: `将 ${plan.totalConversations} 个对话拆为 ${plan.totalSegments} 个连续片段；所有消息均会上传。不同对话最多并发 ${analysisConcurrency(settings.concurrency, plan.totalConversations)} 个，同一对话按时间顺序处理。`,
  })
  const segmentsByConversation = new Map<string, Array<{ segment: typeof plan.jobs[number]; index: number }>>()
  plan.jobs.forEach((segment, index) => {
    const queue = segmentsByConversation.get(segment.id)
    if (queue) queue.push({ segment, index })
    else segmentsByConversation.set(segment.id, [{ segment, index }])
  })
  // A conversation owns one queue: workers parallelize conversations, never
  // segments that depend on the same timeline.
  const conversationQueues = [...segmentsByConversation.values()]
    .map((queue) => queue.sort((left, right) =>
      left.segment.segmentIndex - right.segment.segmentIndex || left.index - right.index))
    // Start the heaviest conversations first so a single long export does not
    // remain on the critical path after all short conversations finish.
    .sort((left, right) => {
      const leftWeight = left.reduce((total, entry) => total + entry.segment.recordCount, 0)
      const rightWeight = right.reduce((total, entry) => total + entry.segment.recordCount, 0)
      return rightWeight - leftWeight || right.length - left.length || (left[0]?.index ?? 0) - (right[0]?.index ?? 0)
    })
  const concurrency = analysisConcurrency(options?.concurrency ?? settings.concurrency, conversationQueues.length)
  // Attachments are global context, so include them in one deterministic
  // segment only; concurrent workers must never duplicate the upload.
  const attachmentOwnerIndex = attachments.length ? 0 : -1
  const progressCandidateKeys = new Set<string>()
  let processedSegments = 0
  let cancelled = false
  let activeWorkers = 0

  const processSegment = async (segment: typeof plan.jobs[number], index: number) => {
    if (options?.signal?.aborted) { cancelled = true; return false }
    activeWorkers += 1
    const acceptedCandidates: AiTaskCandidate[] = []
    const sourceById = new Map(segment.records.map((item) => [item.id, item]))
    const coreIds = new Set(segment.coreRecordIds)
    const coreRecordIndexes = segment.records
      .map((item, recordIndex) => coreIds.has(item.id) ? String(recordIndex + 1) : null)
      .filter((value): value is string => Boolean(value))
    const progress = (retry?: { attempt: number; total: number; delayMs: number }) => {
      onProgress?.({
        completed: processedSegments,
        total: plan.totalSegments,
        candidates: progressCandidateKeys.size,
        recordCount: plan.recordCount,
        failedConversations: failures.size,
        currentConversation: segment.name,
        currentSegment: segment.segmentIndex,
        totalSegmentsInConversation: segment.segmentCount,
        historicalSegment: segment.historical,
        activeWorkers,
        concurrency,
        retryAttempt: retry?.attempt,
        retryTotal: retry?.total,
        retryDelayMs: retry?.delayMs,
      })
    }

    try {
      diagnostics.attemptedConversations += 1
      log('conversation_request_started', 'info', {
        conversationId: segment.id,
        conversationName: segment.name,
        recordCount: segment.recordCount,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        coreRecordCount: segment.coreRecordCount,
        overlapRecordCount: segment.overlapRecordCount,
        historical: segment.historical,
      })
      const requestPayload = {
        conversation: {
          id: segment.id,
          name: segment.name,
          kind: segment.kind,
          totalRecords: segment.totalRecords,
          recordCount: segment.recordCount,
          segmentIndex: segment.segmentIndex,
          segmentCount: segment.segmentCount,
          coreRecordCount: segment.coreRecordCount,
          overlapRecordCount: segment.overlapRecordCount,
          coreRecordIndexes,
          historical: segment.historical,
        },
        workflows: {
          tasks: true,
          // Private conversations can yield a person card from the exact same
          // evidence request. Group conversations remain task-only.
          people: segment.kind === 'direct',
        },
        records: segment.records.map((item) => ({
          id: item.id,
          formattedTime: item.capturedAt || null,
          type: item.messageType ?? null,
          content: item.content || item.summary,
          senderDisplayName: item.speaker ?? null,
          speakerRole: item.speakerRole ?? 'unknown',
        })),
        // A fixed owner avoids every concurrent worker uploading the same files.
        attachments: index === attachmentOwnerIndex ? attachments : [],
        settings: {
          mode: settings.mode,
          instructions: settings.instructions,
          recencyPolicy: settings.recencyPolicy ?? 'balanced',
          promptInstructions: segment.kind === 'direct'
            ? { task: settings.promptInstructions.task, people: settings.promptInstructions.people }
            : { task: settings.promptInstructions.task },
          feedback: (settings.feedback ?? []).slice(-8).map((item) => ({
            title: item.title,
            description: item.description,
            decision: item.decision,
            reason: item.reason,
            sourceCapturedAt: item.sourceCapturedAt,
          })),
        },
      }
      const payload = await requestWithRetry<{
        model: string
        candidates: unknown[]
        people?: unknown[]
        peopleIncluded?: boolean
        apiModeUsed?: string
        receivedRecordCount?: number
      }>('/api/ai/analyze', requestPayload, (notice) => {
        log('conversation_retry_scheduled', 'warn', {
          conversationId: segment.id,
          conversationName: segment.name,
          recordCount: segment.recordCount,
          segmentIndex: segment.segmentIndex,
          segmentCount: segment.segmentCount,
          attempt: notice.attempt,
          attemptTotal: notice.total,
          retryDelayMs: notice.delayMs,
          message: `${(notice.delayMs / 1000).toFixed(1)} 秒后自动重连`,
        })
        progress(notice)
      }, options?.signal)
      if (payload.receivedRecordCount !== segment.recordCount) {
        throw new Error(`会话“${segment.name}”第 ${segment.segmentIndex}/${segment.segmentCount} 段上传校验失败：本机准备 ${segment.recordCount} 条，服务收到 ${payload.receivedRecordCount ?? 0} 条。`)
      }
      modelsBySegment.set(index, payload.model)
      const modelCandidates = Array.isArray(payload.candidates) ? payload.candidates : []
      diagnostics.rawCandidates += modelCandidates.length
      if (!modelCandidates.length) diagnostics.emptyModelResponses += 1
      modelCandidates.forEach((value, candidateIndex) => {
        const raw = value as Partial<AiTaskCandidate> & { actionOwner?: unknown }
        if (raw.actionOwner !== 'self') {
          diagnostics.rejectedOwnership += 1
          return
        }
        const evidence = Array.isArray(raw.sourceIds)
          ? raw.sourceIds.map(String).map((id) => sourceById.get(id)).filter((item): item is IntelItem => Boolean(item))
          : []
        // A segment can use preceding overlap for context, but every new task
        // must be grounded in at least one record from the segment's core range.
        if (!evidence.some((item) => coreIds.has(item.id)) || !supportsUserOwnedTask(evidence)) {
          diagnostics.rejectedEvidence += 1
          return
        }
        const hasTemporalAnchor = evidence.some((item) => hasMessageTimestamp(item) || hasAbsoluteCalendarDate(item))
        const candidate = normalizeCandidate(raw, payload.model, index * 1_000 + candidateIndex, hasTemporalAnchor, latestEvidenceTime(evidence))
        if (!candidate) {
          diagnostics.rejectedInvalid += 1
          return
        }
        // Historical records remain available to the model, but do not revive
        // ordinary past errands. Only an explicit future calendar item survives.
        if (segment.historical && !hasFutureCalendarTask(candidate)) {
          diagnostics.rejectedExpired += 1
          return
        }
        const rejectionReason = candidateRejectionReason(candidate, evidence, settings)
        if (rejectionReason === 'expired') {
          diagnostics.rejectedExpired += 1
          return
        }
        if (rejectionReason === 'ownership') {
          diagnostics.rejectedDirection += 1
          return
        }
        acceptedCandidates.push(candidate)
      })
      candidateBatches.set(index, acceptedCandidates)
      acceptedCandidates.forEach((candidate) => {
        progressCandidateKeys.add(`${candidate.title.replace(/\s+/g, '').toLowerCase()}|${candidate.description.replace(/\s+/g, '').toLowerCase()}`)
      })
      const acceptedPeople: Person[] = []
      if (segment.kind === 'direct' && payload.peopleIncluded === true) {
        const included = peopleIncludedSegments.get(segment.id) ?? new Set<number>()
        included.add(segment.segmentIndex)
        peopleIncludedSegments.set(segment.id, included)
        const allConversationRecords = conversationRecords.get(segment.id) ?? segment.records
        const allowedIds = new Set(segment.records.map((item) => item.id))
        const allowedPlatforms = new Set(segment.records.map((item) => item.source))
        const modelPeople = Array.isArray(payload.people) ? payload.people : []
        modelPeople.forEach((value, personIndex) => {
          const person = normalizePerson(value as Partial<Person>, payload.model, index * 1_000 + personIndex, allowedIds, allowedPlatforms, sourceById)
          // A preceding overlap is context only. A new card claim must anchor
          // itself in this segment's new timeline range.
          if (!person || !person.sourceIds.some((id) => coreIds.has(id))) return
          const fullCounterpartRecords = counterpartRecords(allConversationRecords, person.name)
          const chronologicalCounterpartRecords = [...fullCounterpartRecords].sort((left, right) => {
            const leftTime = new Date(left.capturedAt).getTime()
            const rightTime = new Date(right.capturedAt).getTime()
            if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
            if (Number.isFinite(leftTime)) return -1
            if (Number.isFinite(rightTime)) return 1
            return left.capturedAt.localeCompare(right.capturedAt)
          })
          acceptedPeople.push({
            ...person,
            avatarUrl: fullCounterpartRecords.find((item) => item.avatarUrl)?.avatarUrl ?? person.avatarUrl,
            sourceIds: [...new Set([
              ...person.sourceIds,
              chronologicalCounterpartRecords[0]?.id,
              chronologicalCounterpartRecords.at(-1)?.id,
            ].filter((id): id is string => Boolean(id)))].slice(0, 60),
            conversationIds: [...new Set([
              ...(person.conversationIds ?? []),
              ...fullCounterpartRecords.map((item) => item.conversationId).filter((id): id is string => Boolean(id)),
            ])].slice(0, 30),
            firstObservedAt: observedTime(fullCounterpartRecords) ?? person.firstObservedAt,
            lastObservedAt: observedTime(fullCounterpartRecords, true) ?? person.lastObservedAt,
            platforms: [...new Set([
              ...person.platforms,
              ...fullCounterpartRecords.map((item) => item.source),
            ])],
          })
        })
        peopleBatches.set(index, acceptedPeople)
        if (acceptedPeople.length) onPeople?.(acceptedPeople)
      }
      const completed = successfulSegments.get(segment.id) ?? new Set<number>()
      completed.add(segment.segmentIndex)
      successfulSegments.set(segment.id, completed)
      log('conversation_request_succeeded', 'info', {
        conversationId: segment.id,
        conversationName: segment.name,
        recordCount: segment.recordCount,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        coreRecordCount: segment.coreRecordCount,
        overlapRecordCount: segment.overlapRecordCount,
        historical: segment.historical,
        candidateCount: modelCandidates.length,
        acceptedCandidateCount: acceptedCandidates.length,
        peopleCount: acceptedPeople.length,
        peopleIncluded: segment.kind === 'direct' && payload.peopleIncluded === true,
        message: `模型 ${payload.model}${payload.apiModeUsed ? ` · ${payload.apiModeUsed}` : ''}`,
      })
    } catch (error) {
      if (wasAborted(error) || options?.signal?.aborted) {
        cancelled = true
        log('run_cancelled', 'warn', { conversationId: segment.id, conversationName: segment.name, recordCount: segment.recordCount, segmentIndex: segment.segmentIndex, segmentCount: segment.segmentCount, message: '用户停止了本轮提炼；已完成片段的候选将保留。' })
        return false
      }
      const canRetry = retryable(error)
      const message = (error instanceof Error ? error.message : '模型请求失败').slice(0, 280)
      const previous = failures.get(segment.id)
      failures.set(segment.id, {
        id: segment.id,
        name: segment.name,
        message,
        retryable: previous?.retryable || canRetry,
        failedSegments: (previous?.failedSegments ?? 0) + 1,
        totalSegments: segment.segmentCount,
      })
      log('conversation_request_failed', 'error', {
        conversationId: segment.id,
        conversationName: segment.name,
        recordCount: segment.recordCount,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        coreRecordCount: segment.coreRecordCount,
        overlapRecordCount: segment.overlapRecordCount,
        historical: segment.historical,
        status: Number((error as { status?: number })?.status) || undefined,
        message,
      })
    } finally {
      activeWorkers = Math.max(0, activeWorkers - 1)
    }
    processedSegments += 1
    progress()
    return true
  }

  let nextConversationIndex = 0
  const worker = async () => {
    while (nextConversationIndex < conversationQueues.length) {
      if (options?.signal?.aborted) { cancelled = true; return }
      const queue = conversationQueues[nextConversationIndex]
      nextConversationIndex += 1
      for (const { segment, index } of queue) {
        if (!await processSegment(segment, index)) return
      }
    }
  }
  onProgress?.({ completed: 0, total: plan.totalSegments, candidates: 0, recordCount: plan.recordCount, activeWorkers: 0, concurrency })
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  // Requests may finish in any order. Reduce in the original plan order so
  // deduplication and the returned candidate order remain reproducible.
  for (let index = 0; index < plan.jobs.length; index += 1) {
    for (const candidate of candidateBatches.get(index) ?? []) {
      const key = `${candidate.title.replace(/\s+/g, '').toLowerCase()}|${candidate.description.replace(/\s+/g, '').toLowerCase()}`
      if (seen.has(key)) {
        diagnostics.rejectedDuplicate += 1
        continue
      }
      seen.add(key)
      candidates.push(candidate)
    }
    for (const person of peopleBatches.get(index) ?? []) {
      mergePersonResult(people, person)
    }
  }
  const model = [...modelsBySegment.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)[0] ?? 'unknown'

  const analyzedIds: string[] = []
  const peopleIncludedConversationIds: string[] = []
  let processedConversations = 0
  for (const [conversationId, segmentCount] of segmentCounts) {
    if (successfulSegments.get(conversationId)?.size !== segmentCount) continue
    processedConversations += 1
    analyzedIds.push(...allRecordIds.get(conversationId) ?? [])
    if (directConversationIds.has(conversationId) && peopleIncludedSegments.get(conversationId)?.size === segmentCount) {
      peopleIncludedConversationIds.push(conversationId)
    }
  }
  const failedConversations = [...failures.values()]
  log('run_completed', cancelled || failedConversations.length ? 'warn' : 'info', {
    recordCount: items.length,
    candidateCount: diagnostics.rawCandidates,
    acceptedCandidateCount: candidates.length,
    message: `${cancelled ? '已停止；' : ''}完成 ${processedSegments}/${plan.totalSegments} 个片段，完整完成 ${processedConversations}/${plan.totalConversations} 个会话；失败会话 ${failedConversations.length}。`,
  })
  return {
    candidates,
    people,
    peopleIncludedConversationIds,
    analyzedIds,
    model,
    plan,
    failedConversations,
    skippedUnverifiedConversations: 0,
    processedConversations,
    processedSegments,
    cancelled,
    stoppedByServiceFailures: false,
    diagnostics,
  }
}

function observedTime(records: IntelItem[], latest = false) {
  const dated = records
    .map((item) => ({ value: item.capturedAt, time: new Date(item.capturedAt).getTime() }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => latest ? right.time - left.time : left.time - right.time)
  return dated[0]?.value ?? records.map((item) => item.capturedAt).filter(Boolean).sort(latest ? (left, right) => right.localeCompare(left) : undefined)[0]
}

function isUsableConversationName(value: string | undefined) {
  const name = value?.trim() ?? ''
  if (!name || name.length > 120) return false
  return !/^(?:私聊|单聊|好友|聊天|聊天记录|messages?|data|logs?|records?)$/i.test(name)
}

function directConversationDisplayName(value: string | undefined) {
  // Export folders often use names such as "private_contact". The folder
  // itself is reliable identity evidence, but the container label is not part
  // of the person's display name.
  return (value ?? '').trim().replace(/^(?:\u79c1\u804a|\u5355\u804a|direct|private|dm)[\s_-]*/i, '').trim()
}

function verifiedDirectCounterpart(records: IntelItem[], model: string, index: number): Person | null {
  const names = new Map<string, IntelItem[]>()
  records.filter((item) => item.speakerRole === 'other' && item.speaker?.trim()).forEach((item) => {
    const name = item.speaker!.trim()
    const group = names.get(name)
    if (group) group.push(item)
    else names.set(name, [item])
  })
  const selected = [...names.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0], 'zh-CN'))[0]
  // A folder immediately below an exporter-provided 私聊/单聊 directory is
  // also an explicit conversation identity. It is sufficient for a minimal
  // contact card when the exporter omitted per-message direction fields.
  const directoryName = directConversationDisplayName(records[0]?.conversationName)
  const name = selected?.[0] ?? (isUsableConversationName(directoryName) ? directoryName : '')
  if (!name) return null
  const evidence = selected?.[1] ?? records
  const sourceIds = evidence.map((item) => item.id).slice(0, 30)
  const conversationIds = [...new Set(records.map((item) => item.conversationId).filter((id): id is string => Boolean(id)))].slice(0, 30)
  const firstObservedAt = observedTime(records)
  const lastObservedAt = observedTime(records, true)
  const facts = [
    selected ? (firstObservedAt ? `最早可核实私聊互动：${firstObservedAt}。` : '导出记录显示：存在可核实的私聊互动。') : '导出目录明确标记为私聊记录。',
    lastObservedAt && lastObservedAt !== firstObservedAt ? `最近可核实私聊互动：${lastObservedAt}。` : '',
  ].filter(Boolean)
  return {
    id: `person-${hash(`${name}|${conversationIds.join(',')}`)}-fallback-${index}`,
    name,
    avatarUrl: evidence.find((item) => item.avatarUrl)?.avatarUrl ?? records.find((item) => item.avatarUrl)?.avatarUrl,
    facts,
    sourceIds,
    conversationIds,
    firstObservedAt,
    lastObservedAt,
    platforms: [...new Set(records.map((item) => item.source))],
    model: model === 'unknown' ? 'local-export-verified' : `${model} / local-export-verified`,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Builds contact cards from exporter-provided private-conversation folders.
 * This is intentionally local-only: it never sends message text to a model.
 * It gives long conversations an immediately visible card while their task
 * extraction is still processing hundreds of chronological segments.
 */
export function buildDirectConversationFallbackPeople(items: IntelItem[]): Person[] {
  const conversations = new Map<string, IntelItem[]>()
  for (const item of items) {
    if (item.conversationKind !== 'direct') continue
    const key = item.conversationId ?? `record:${item.id}`
    const records = conversations.get(key)
    if (records) records.push(item)
    else conversations.set(key, [item])
  }

  const people: Person[] = []
  for (const records of conversations.values()) {
    const fallback = verifiedDirectCounterpart(records, 'unknown', people.length)
    if (!fallback) continue
    const duplicate = people.find((person) => person.name === fallback.name
      && (person.conversationIds ?? []).some((id) => (fallback.conversationIds ?? []).includes(id)))
    if (!duplicate) people.push(fallback)
  }
  return people
}

/** Produces one conservative person record per verified private conversation. */
export async function analyzePeopleLegacy(
  items: IntelItem[],
  onProgress?: (progress: AiProgress) => void,
  onPeople?: (people: Person[]) => void,
  settings?: Pick<AiSettings, 'promptInstructions'>,
) {
  const people: Person[] = []
  const seen = new Set<string>()
  const failedBatches: number[] = []
  let model = 'unknown'
  const conversations = new Map<string, IntelItem[]>()
  items.forEach((item) => {
    const key = item.conversationId ?? `record:${item.id}`
    const group = conversations.get(key)
    if (group) group.push(item)
    else conversations.set(key, [item])
  })
  const jobs = [...conversations.entries()]
    .filter(([, records]) => records.some((item) => item.conversationKind === 'direct'))
    .map(([id, records]) => ({
      id,
      name: records[0]?.conversationName || records[0]?.source || '私聊',
      records: [...records].sort((left, right) => {
        const leftTime = new Date(left.capturedAt).getTime()
        const rightTime = new Date(right.capturedAt).getTime()
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
        if (Number.isFinite(leftTime)) return -1
        if (Number.isFinite(rightTime)) return 1
        return 0
      }),
    }))
  for (const [offset, job] of jobs.entries()) {
    const batch = job.records
    const additions: Person[] = []
    try {
      const payload = await requestWithRetry<{ model: string; people: unknown[]; receivedRecordCount?: number }>('/api/ai/people', {
        conversation: { id: job.id, name: job.name, kind: 'direct', totalRecords: batch.length },
        records: batch.map((item) => ({
          id: item.id,
          formattedTime: item.capturedAt || null,
          type: item.messageType ?? null,
          content: item.content || item.summary,
          senderDisplayName: item.speaker ?? null,
          speakerRole: item.speakerRole ?? 'unknown',
        })),
        attachments: [],
        settings: {
          promptInstructions: {
            people: settings?.promptInstructions?.people ?? '',
          },
        },
      })
      if (payload.receivedRecordCount !== batch.length) throw new Error(`人物会话“${job.name}”上传条数校验失败：本机准备 ${batch.length} 条，服务收到 ${payload.receivedRecordCount ?? 0} 条。`)
      model = payload.model
      const allowedIds = new Set(batch.map((item) => item.id))
      const allowedPlatforms = new Set(batch.map((item) => item.source))
      const recordsById = new Map(batch.map((item) => [item.id, item]))
      payload.people.forEach((value, index) => {
        const person = normalizePerson(value as Partial<Person>, model, offset * 1000 + index, allowedIds, allowedPlatforms, recordsById)
        if (!person) return
        const key = `${person.name}|${[...person.conversationIds ?? []].sort().join(',')}`
        if (seen.has(key)) return
        seen.add(key)
        people.push(person)
        additions.push(person)
      })
    } catch {
      // A transient provider failure should not discard people found in other conversations.
      failedBatches.push(offset)
    }
    // This does not need a model response. It guarantees a conservative card
    // for each export-verified direct counterpart, including during provider outages.
    const fallback = verifiedDirectCounterpart(batch, model, offset)
    if (fallback) {
      const key = `${fallback.name}|${[...fallback.conversationIds ?? []].sort().join(',')}`
      if (!seen.has(key)) {
        seen.add(key)
        people.push(fallback)
        additions.push(fallback)
      }
    }
    if (additions.length) onPeople?.(additions)
    onProgress?.({ completed: offset + 1, total: jobs.length, candidates: people.length, failedConversations: failedBatches.length })
  }
  return { people, model, failedBatches }
}

function counterpartRecords(records: IntelItem[], name: string) {
  return records.filter((item) => item.speakerRole === 'other' && item.speaker?.trim() === name)
}

function mergeObservedAt(left: string | undefined, right: string | undefined, latest = false) {
  const values = [left, right].filter((value): value is string => Boolean(value))
  return values.sort((first, second) => {
    const firstTime = new Date(first).getTime()
    const secondTime = new Date(second).getTime()
    if (Number.isFinite(firstTime) && Number.isFinite(secondTime)) return latest ? secondTime - firstTime : firstTime - secondTime
    return latest ? second.localeCompare(first) : first.localeCompare(second)
  })[0]
}

function mergePersonResult(people: Person[], incoming: Person) {
  const index = people.findIndex((person) => person.name === incoming.name
    && (person.conversationIds ?? []).some((id) => (incoming.conversationIds ?? []).includes(id)))
  if (index < 0) {
    people.push(incoming)
    return incoming
  }
  const current = people[index]
  const merged: Person = {
    ...current,
    avatarUrl: current.avatarUrl ?? incoming.avatarUrl,
    // Keep a bounded internal buffer until the app consolidates the verified
    // notes with the model. The user interface does not render this raw list.
    facts: [...new Set([...current.facts, ...incoming.facts])].slice(0, 48),
    preferences: [...new Set([...(current.preferences ?? []), ...(incoming.preferences ?? [])])].slice(0, 18),
    advice: [...new Set([...(current.advice ?? []), ...(incoming.advice ?? [])])].slice(0, 9),
    sourceIds: [...new Set([...current.sourceIds, ...incoming.sourceIds])].slice(0, 60),
    conversationIds: [...new Set([...(current.conversationIds ?? []), ...(incoming.conversationIds ?? [])])],
    firstObservedAt: mergeObservedAt(current.firstObservedAt, incoming.firstObservedAt),
    lastObservedAt: mergeObservedAt(current.lastObservedAt, incoming.lastObservedAt, true),
    portrait: current.portrait ?? incoming.portrait,
    platforms: [...new Set([...current.platforms, ...incoming.platforms])],
    model: incoming.model,
  }
  people[index] = merged
  return merged
}

/** Uses the same complete-coverage segment plan as task extraction. */
export async function analyzePeople(
  items: IntelItem[],
  onProgress?: (progress: AiProgress) => void,
  onPeople?: (people: Person[]) => void,
  onLog?: AiDebugWriter,
  settings?: Pick<AiSettings, 'promptInstructions'>,
  options?: { signal?: AbortSignal; concurrency?: number },
) {
  const plan = buildConversationAnalysisPlan(items)
  const directSegments = plan.jobs.filter((job) => job.kind === 'direct')
  const recordsByConversation = new Map<string, IntelItem[]>()
  items.filter((item) => item.conversationKind === 'direct' && item.conversationId).forEach((item) => {
    const records = recordsByConversation.get(item.conversationId!)
    if (records) records.push(item)
    else recordsByConversation.set(item.conversationId!, [item])
  })
  const people: Person[] = []
  const failedBatches: number[] = []
  let model = 'unknown'
  const log = (event: string, level: AiDebugEntry['level'], details: Omit<AiDebugEntry, 'at' | 'event' | 'level'> = {}) => {
    onLog?.({ at: new Date().toISOString(), event, level, ...details })
  }
  const roleSummary = (records: IntelItem[]) => records.reduce((summary, item) => {
    summary[item.speakerRole ?? 'unknown'] += 1
    return summary
  }, { self: 0, other: 0, unknown: 0 })

  log('people_run_started', 'info', {
    recordCount: items.length,
    message: `人物处理收到 ${items.length} 条记录；可处理私聊片段 ${directSegments.length} 个，对应完整私聊 ${recordsByConversation.size} 个。不同私聊最多并发 ${analysisConcurrency(options?.concurrency, recordsByConversation.size)} 个，同一私聊保持时间顺序。`,
  })
  if (!directSegments.length) {
    log('people_run_no_direct_conversation', 'warn', {
      recordCount: items.length,
      message: '没有被导出目录标记为私聊/单聊的记录，未启动人物模型请求。',
    })
  }

  const segmentsByConversation = new Map<string, Array<{ segment: typeof directSegments[number]; offset: number }>>()
  directSegments.forEach((segment, offset) => {
    const queue = segmentsByConversation.get(segment.id)
    if (queue) queue.push({ segment, offset })
    else segmentsByConversation.set(segment.id, [{ segment, offset }])
  })
  const conversationQueues = [...segmentsByConversation.values()]
    .map((queue) => queue.sort((left, right) =>
      left.segment.segmentIndex - right.segment.segmentIndex || left.offset - right.offset))
    .sort((left, right) => {
      const leftWeight = left.reduce((total, entry) => total + entry.segment.recordCount, 0)
      const rightWeight = right.reduce((total, entry) => total + entry.segment.recordCount, 0)
      return rightWeight - leftWeight || right.length - left.length || (left[0]?.offset ?? 0) - (right[0]?.offset ?? 0)
    })
  const concurrency = analysisConcurrency(options?.concurrency, conversationQueues.length)
  let completedSegments = 0
  let activeWorkers = 0

  onProgress?.({ completed: 0, total: directSegments.length, candidates: 0, currentConversation: conversationQueues[0]?.[0]?.segment.name, activeWorkers: 0, concurrency })

  const processSegment = async (segment: typeof directSegments[number], offset: number) => {
    throwIfAborted(options?.signal)
    activeWorkers += 1
    const additions: Person[] = []
    const sourceById = new Map(segment.records.map((item) => [item.id, item]))
    const coreIds = new Set(segment.coreRecordIds)
    const coreRecordIndexes = segment.records
      .map((item, recordIndex) => coreIds.has(item.id) ? String(recordIndex + 1) : null)
      .filter((value): value is string => Boolean(value))
    const directions = roleSummary(segment.records)
    try {
      log('people_segment_started', 'info', {
        conversationId: segment.id,
        conversationName: segment.name,
        recordCount: segment.recordCount,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        coreRecordCount: segment.coreRecordCount,
        overlapRecordCount: segment.overlapRecordCount,
        historical: segment.historical,
        message: `发言方向：你 ${directions.self}，对方 ${directions.other}，未确认 ${directions.unknown}；带头像 ${segment.records.filter((item) => Boolean(item.avatarUrl)).length} 条。`,
      })
      const payload = await requestWithRetry<{ model: string; people: unknown[]; receivedRecordCount?: number }>('/api/ai/people', {
        conversation: {
          id: segment.id,
          name: segment.name,
          kind: 'direct',
          totalRecords: segment.totalRecords,
          recordCount: segment.recordCount,
          segmentIndex: segment.segmentIndex,
          segmentCount: segment.segmentCount,
          coreRecordCount: segment.coreRecordCount,
          overlapRecordCount: segment.overlapRecordCount,
          coreRecordIndexes,
          historical: segment.historical,
        },
        records: segment.records.map((item) => ({
          id: item.id,
          formattedTime: item.capturedAt || null,
          type: item.messageType ?? null,
          content: item.content || item.summary,
          senderDisplayName: item.speaker ?? null,
          speakerRole: item.speakerRole ?? 'unknown',
        })),
        attachments: [],
        settings: {
          promptInstructions: {
            people: settings?.promptInstructions?.people ?? '',
          },
        },
      }, undefined, options?.signal)
      // fetch can resolve while an abort event is being dispatched. Do not let
      // a late response create a card after the user has stopped this run.
      throwIfAborted(options?.signal)
      if (payload.receivedRecordCount !== segment.recordCount) {
        throw new Error(`人物会话“${segment.name}”第 ${segment.segmentIndex}/${segment.segmentCount} 段上传校验失败。`)
      }
      model = payload.model
      const allowedIds = new Set(segment.records.map((item) => item.id))
      const allowedPlatforms = new Set(segment.records.map((item) => item.source))
      const allConversationRecords = recordsByConversation.get(segment.id) ?? segment.records
      const modelPeople = Array.isArray(payload.people) ? payload.people : []
      modelPeople.forEach((value, index) => {
        const person = normalizePerson(value as Partial<Person>, model, offset * 1_000 + index, allowedIds, allowedPlatforms, sourceById)
        if (!person || !person.sourceIds.some((id) => coreIds.has(id))) return
        const fullCounterpartRecords = counterpartRecords(allConversationRecords, person.name)
        const chronologicalCounterpartRecords = [...fullCounterpartRecords].sort((left, right) => {
          const leftTime = new Date(left.capturedAt).getTime()
          const rightTime = new Date(right.capturedAt).getTime()
          if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
          if (Number.isFinite(leftTime)) return -1
          if (Number.isFinite(rightTime)) return 1
          return left.capturedAt.localeCompare(right.capturedAt)
        })
        const firstObservedAt = observedTime(fullCounterpartRecords)
        const lastObservedAt = observedTime(fullCounterpartRecords, true)
        const avatarUrl = fullCounterpartRecords.find((item) => item.avatarUrl)?.avatarUrl ?? person.avatarUrl
        const merged = mergePersonResult(people, {
          ...person,
          // Keep the first and latest verified messages as evidence whenever
          // we derive the interaction range from the complete conversation.
          sourceIds: [...new Set([...person.sourceIds, chronologicalCounterpartRecords[0]?.id, chronologicalCounterpartRecords.at(-1)?.id].filter((id): id is string => Boolean(id)))].slice(0, 60),
          avatarUrl,
          firstObservedAt: firstObservedAt ?? person.firstObservedAt,
          lastObservedAt: lastObservedAt ?? person.lastObservedAt,
        })
        additions.push(merged)
      })
      log('people_segment_succeeded', 'info', {
        conversationId: segment.id,
        conversationName: segment.name,
        recordCount: segment.recordCount,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        candidateCount: modelPeople.length,
        acceptedCandidateCount: additions.length,
        message: `模型 ${payload.model} 返回 ${modelPeople.length} 个人物，校验后本片段保留 ${additions.length} 个。`,
      })
    } catch (error) {
      if (wasAborted(error) || options?.signal?.aborted) throw abortError()
      // A failed segment must not prevent remaining segments from preserving
      // facts or a conservative verified counterpart card.
      failedBatches.push(offset)
      log('people_segment_failed', 'error', {
        conversationId: segment.id,
        conversationName: segment.name,
        recordCount: segment.recordCount,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        status: Number((error as { status?: number })?.status) || undefined,
        message: (error instanceof Error ? error.message : '人物模型请求失败').slice(0, 280),
      })
    } finally {
      activeWorkers = Math.max(0, activeWorkers - 1)
    }
    throwIfAborted(options?.signal)
    if (additions.length) onPeople?.(additions)
    completedSegments += 1
    onProgress?.({
      completed: completedSegments,
      total: directSegments.length,
      candidates: people.length,
      failedConversations: failedBatches.length,
      currentConversation: segment.name,
      currentSegment: segment.segmentIndex,
      totalSegmentsInConversation: segment.segmentCount,
      historicalSegment: segment.historical,
      activeWorkers,
      concurrency,
    })
  }

  let nextConversationIndex = 0
  const worker = async () => {
    while (nextConversationIndex < conversationQueues.length) {
      throwIfAborted(options?.signal)
      const queue = conversationQueues[nextConversationIndex]
      nextConversationIndex += 1
      for (const { segment, offset } of queue) await processSegment(segment, offset)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  throwIfAborted(options?.signal)

  // Add one local, exporter-verified card for each direct conversation. This
  // preserves an avatar and earliest/latest interaction even if every model
  // request for that person failed or returned no facts.
  for (const records of recordsByConversation.values()) {
    const fallback = verifiedDirectCounterpart(records, model, people.length)
    if (!fallback) continue
    const merged = mergePersonResult(people, fallback)
    onPeople?.([merged])
  }
  log('people_run_completed', failedBatches.length ? 'warn' : 'info', {
    recordCount: items.length,
    candidateCount: people.length,
    message: `人物处理结束：保留 ${people.length} 张人物卡；模型请求失败 ${failedBatches.length} 个片段。`,
  })
  return { people, model, failedBatches }
}

export async function fileToAttachment(file: File): Promise<AiAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return { name: file.name, mimeType: file.type || 'application/octet-stream', data: `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}` }
}

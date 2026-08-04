import type { AiSettings, AiTaskCandidate, IntelItem, Person, PersonEvidence, PersonEvidenceCategory, PersonPortraitBlock, PersonPortraitCoverage, Place, Quest } from '../types'
import { buildConversationAnalysisPlan, buildPeopleConversationAnalysisPlan, inferConversationKind } from './conversationAnalysis'
import { apiUrl, localProxyUrl } from './apiUrl'
import { normalizeAiConcurrency } from './aiConcurrency'
import { portraitUsesProfileNotes } from './peoplePortraitValidation'

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
  configuredMaxConcurrency: number
  effectiveMaxConcurrency: number
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
  effectiveMaxConcurrency: number
  sharedOriginCount?: number
  sharedOrigins?: Array<{
    key: string
    channelIds: string[]
    activeRequests: number
    configuredMaxConcurrency: number
    effectiveMaxConcurrency: number
    availableCapacity: number
    cooldownUntil: string | null
    cooldownRemainingMs: number
    successfulRequests: number
    failedRequests: number
  }>
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

export const AI_STATUS_CHANGED_EVENT = 'theia:ai-status-changed'

function notifyAiStatusChanged(status: AiStatus) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<AiStatus>(AI_STATUS_CHANGED_EVENT, { detail: status }))
  return status
}

export interface PersonConsolidation {
  facts: string[]
  preferences: string[]
  advice: string[]
  portrait?: string
  portraitBlocks: PersonPortraitBlock[]
  portraitCoverage?: PersonPortraitCoverage
  portraitSchemaVersion: number
  /** Record IDs explicitly selected by the final profile pass for its portrait. */
  portraitSourceIds: string[]
  /** Whether the current portrait incorporated the user-confirmed background. */
  profileNotesUsed: boolean
  /** Selected, still-verifiable claims behind the consolidated text. */
  evidence: PersonEvidence[]
  model: string
}

export interface TaskGuidanceContext {
  quest: Pick<Quest, 'id' | 'title' | 'description' | 'startAt' | 'dueAt'>
  place?: Pick<Place, 'name' | 'lat' | 'lng' | 'note' | 'precision'>
  people: Array<Pick<Person, 'name' | 'facts' | 'preferences' | 'advice' | 'portrait' | 'profileNotes' | 'profileNotesUsed'>>
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
  /** Fully settled conversations, independent of how many request segments each needs. */
  completedConversations?: number
  /** Total conversations selected for this workflow. */
  totalConversations?: number
  /** Set when the last segment of one conversation has settled. */
  completedConversationId?: string
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
  totalRecordCount?: number
  attempt?: number
  attemptTotal?: number
  retryDelayMs?: number
  status?: number
  candidateCount?: number
  acceptedCandidateCount?: number
  peopleCount?: number
  rawClaimCount?: number
  acceptedClaimCount?: number
  deduplicatedClaimCount?: number
  singleEvidenceCount?: number
  repeatedEvidenceCount?: number
  portraitGenerated?: boolean
  peopleIncluded?: boolean
  segmentIndex?: number
  segmentCount?: number
  coreRecordCount?: number
  overlapRecordCount?: number
  workflowConcurrency?: number
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
const SERVICE_RETRY_BASE_MS = 250
const SERVICE_RETRY_MAX_MS = 2_000
// A browser normally allows only about six long HTTP/1.1 requests to the Vite
// origin. The local proxy fans this bundle back out through its own scheduler,
// so one browser request can keep all configured provider slots occupied.
const MODEL_BATCH_SIZE = 40
// Keep one extra provider-capacity worth of work in the local scheduler. A
// single 40-job bundle produces a sawtooth (40 -> 0); two bundles let the
// next queued model job start as soon as a slot is released.
const MODEL_QUEUE_PREFETCH_FACTOR = 4
const SESSION_POLL_INTERVAL_MS = 120
// A shared relay can expose many saved channel slots while still having one
// origin behind them. Person extraction is evidence-heavy and should keep a
// small, steady number of complete windows in flight; task extraction retains
// the user's configured concurrency separately.
const PEOPLE_WORKFLOW_CONCURRENCY = 4

type BatchWorkflow = 'tasks' | 'people'

interface BatchResult {
  id: number
  ok: boolean
  result?: unknown
  error?: string
  status?: number
  retryAfter?: number
}

class AiRequestBatcher {
  private queue: Array<{
    id: number
    workflow: BatchWorkflow
    payload: unknown
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }> = []
  private nextId = 1
  private activeBatches = 0
  private scheduled = false
  private legacyBatchUnsupported = false

  constructor(private readonly concurrency: number, private readonly signal?: AbortSignal) {
    signal?.addEventListener('abort', () => {
      const pending = this.queue.splice(0)
      pending.forEach((entry) => entry.reject(abortError()))
    }, { once: true })
  }

  request<T>(workflow: BatchWorkflow, payload: unknown): Promise<T> {
    if (this.signal?.aborted) return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, workflow, payload, resolve: resolve as (value: unknown) => void, reject })
      this.schedule()
    })
  }

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    window.setTimeout(() => {
      this.scheduled = false
      this.pump()
    }, 0)
  }

  private pump() {
    if (this.legacyBatchUnsupported) {
      this.pumpLegacy()
      return
    }
    const maxBatches = Math.max(1, Math.ceil(this.concurrency / MODEL_BATCH_SIZE))
    while (this.activeBatches < maxBatches && this.queue.length) {
      const entries = this.queue.splice(0, MODEL_BATCH_SIZE)
      this.activeBatches += 1
      void requestJson<{ results: BatchResult[] }>('/api/ai/batch', {
        body: { requests: entries.map((entry) => ({ id: entry.id, workflow: entry.workflow, payload: entry.payload })) },
        signal: this.signal,
      }).then((response) => {
        const results = new Map((Array.isArray(response.results) ? response.results : []).map((result) => [result.id, result]))
        entries.forEach((entry) => {
          const result = results.get(entry.id)
          if (result?.ok) {
            entry.resolve(result.result)
            return
          }
          const error = new Error(result?.error || '本机批量模型请求未返回结果')
          Object.assign(error, { status: Number(result?.status), retryAfter: Number(result?.retryAfter) })
          entry.reject(error)
        })
      }).catch((failure) => {
        if (Number((failure as { status?: number })?.status) === 404) {
          // A renderer can receive an HMR update before the companion local
          // service is restarted. Preserve a working, albeit slower, run until
          // that restart brings the batch endpoint online.
          this.legacyBatchUnsupported = true
          this.queue.unshift(...entries)
          return
        }
        const error = failure instanceof Error ? failure : new Error('本机批量模型请求失败')
        entries.forEach((entry) => entry.reject(error))
      }).finally(() => {
        this.activeBatches = Math.max(0, this.activeBatches - 1)
        if (this.queue.length) this.schedule()
      })
    }
  }

  private pumpLegacy() {
    // HTTP/1.1 renderers normally allow about six requests to one origin. The
    // session batcher's input is a prefetch budget, so using it directly here
    // could otherwise launch hundreds of requests after an HMR downgrade.
    const maximumActiveRequests = Math.max(1, Math.min(6, this.concurrency))
    while (this.activeBatches < maximumActiveRequests && this.queue.length) {
      const entry = this.queue.shift()!
      this.activeBatches += 1
      const path = entry.workflow === 'people' ? '/api/ai/people' : '/api/ai/analyze'
      void requestJson<unknown>(path, { body: entry.payload, signal: this.signal })
        .then(entry.resolve)
        .catch((error) => entry.reject(error instanceof Error ? error : new Error('本机模型请求失败')))
        .finally(() => {
          this.activeBatches = Math.max(0, this.activeBatches - 1)
          if (this.queue.length) this.schedule()
        })
    }
  }
}

interface SessionBatchEntry {
  id: number
  workflow: BatchWorkflow
  payload: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Keeps a server-resident backlog of jobs. Unlike /api/ai/batch, a fast job
 * resolves on its own and immediately lets its worker enqueue a replacement;
 * it never has to wait for the slowest job in the same browser batch.
 */
class AiSessionRequestBatcher {
  private queue: SessionBatchEntry[] = []
  private pending = new Map<number, SessionBatchEntry>()
  private nextId = 1
  private scheduled = false
  private pumping = false
  private polling = false
  private pollTimer: number | undefined
  private pollFailureCount = 0
  private resultAckIds = new Set<number>()
  private sessionId: string | null = null
  private fallback: AiRequestBatcher | null = null

  constructor(private readonly concurrency: number, private readonly signal?: AbortSignal) {
    signal?.addEventListener('abort', () => this.cancel(), { once: true })
  }

  request<T>(workflow: BatchWorkflow, payload: unknown): Promise<T> {
    if (this.signal?.aborted) return Promise.reject(abortError())
    if (this.fallback) return this.fallback.request<T>(workflow, payload)
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        workflow,
        payload,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.schedule()
    })
  }

  private schedule() {
    if (this.scheduled || this.fallback) return
    this.scheduled = true
    window.setTimeout(() => {
      this.scheduled = false
      this.pump()
    }, 0)
  }

  private pump() {
    if (this.pumping || this.signal?.aborted || this.fallback) return
    this.pumping = true
    void this.pumpSession().catch((failure) => {
      const error = failure instanceof Error ? failure : new Error('Local AI session transport failed')
      const queued = this.queue.splice(0)
      queued.forEach((entry) => entry.reject(error))
    }).finally(() => {
      this.pumping = false
      if (this.queue.length) this.schedule()
    })
  }

  private async pumpSession() {
    if (!this.sessionId) {
      try {
        const created = await requestJson<{ id?: string }>('/api/ai/sessions', {
          body: {},
          signal: this.signal,
          directLocal: true,
        })
        if (!created.id) throw new Error('Local AI session did not return an id')
        this.sessionId = created.id
      } catch (failure) {
        if (Number((failure as { status?: number })?.status) === 404) {
          this.fallbackToStaticBatch()
          return
        }
        throw failure
      }
    }

    const sessionId = this.sessionId
    if (!sessionId) return
    // `concurrency` is already four times the provider capacity. Accept that
    // many jobs into the proxy so its own provider queue cannot run dry while
    // the renderer merges a completed result.
    const maximumOutstanding = Math.max(MODEL_BATCH_SIZE, this.concurrency)
    const submissions: Array<Promise<void>> = []
    while (this.queue.length && this.pending.size < maximumOutstanding) {
      const capacity = maximumOutstanding - this.pending.size
      const entries = this.queue.splice(0, Math.min(MODEL_BATCH_SIZE, capacity))
      entries.forEach((entry) => this.pending.set(entry.id, entry))
      submissions.push(this.enqueue(sessionId, entries))
    }
    if (submissions.length) await Promise.all(submissions)
    if (this.pending.size) this.schedulePoll(0)
  }

  private async enqueue(sessionId: string, entries: SessionBatchEntry[]) {
    try {
      await requestJson(`/api/ai/sessions/${sessionId}/enqueue`, {
        body: { requests: entries.map((entry) => ({ id: entry.id, workflow: entry.workflow, payload: entry.payload })) },
        signal: this.signal,
        directLocal: true,
      })
    } catch (failure) {
      if (Number((failure as { status?: number })?.status) === 404) {
        this.fallbackToStaticBatch()
        return
      }
      entries.forEach((entry) => {
        this.pending.delete(entry.id)
        entry.reject(failure instanceof Error ? failure : new Error('Local AI session enqueue failed'))
      })
    }
  }

  private schedulePoll(delay: number) {
    if (this.polling || this.pollTimer !== undefined || !this.sessionId || (!this.pending.size && !this.resultAckIds.size) || this.signal?.aborted || this.fallback) return
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = undefined
      void this.pollResults()
    }, delay)
  }

  private async pollResults() {
    const sessionId = this.sessionId
    if (!sessionId || this.polling || this.signal?.aborted || this.fallback) return
    this.polling = true
    let pollFailed = false
    const acknowledgements = [...this.resultAckIds]
    try {
      const acknowledgementQuery = acknowledgements.length ? `&ack=${acknowledgements.join(',')}` : ''
      const response = await requestJson<{ results?: BatchResult[] }>(`/api/ai/sessions/${sessionId}/results?protocol=ack-v1${acknowledgementQuery}`, {
        signal: this.signal,
        directLocal: true,
      })
      acknowledgements.forEach((id) => this.resultAckIds.delete(id))
      const results = Array.isArray(response.results) ? response.results : []
      this.pollFailureCount = 0
      results.forEach((result) => {
        const resultId = Number(result.id)
        if (Number.isSafeInteger(resultId)) this.resultAckIds.add(resultId)
        const entry = this.pending.get(resultId)
        if (!entry) return
        this.pending.delete(entry.id)
        if (result.ok) {
          entry.resolve(result.result)
          return
        }
        const error = new Error(result.error || 'Local AI session job did not return a result')
        Object.assign(error, { status: Number(result.status), retryAfter: Number(result.retryAfter) })
        entry.reject(error)
      })
      if (this.queue.length) this.schedule()
    } catch (failure) {
      if (Number((failure as { status?: number })?.status) === 404) this.fallbackToStaticBatch()
      // A transient short-poll failure must not discard jobs that the local
      // service is still running. The next poll retrieves their results.
      pollFailed = true
      this.pollFailureCount += 1
    } finally {
      this.polling = false
      if (this.sessionId && (this.pending.size || this.resultAckIds.size) && !this.signal?.aborted && !this.fallback) {
        const delay = pollFailed
          ? Math.min(5_000, SESSION_POLL_INTERVAL_MS * (2 ** Math.min(6, this.pollFailureCount)))
          : SESSION_POLL_INTERVAL_MS
        this.schedulePoll(delay)
      }
    }
  }

  private fallbackToStaticBatch() {
    if (this.fallback) return
    const queued = [...this.pending.values(), ...this.queue]
    this.pending.clear()
    this.queue = []
    this.resultAckIds.clear()
    this.sessionId = null
    if (this.pollTimer !== undefined) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    this.fallback = new AiRequestBatcher(this.concurrency, this.signal)
    queued.forEach((entry) => {
      void this.fallback!.request(entry.workflow, entry.payload)
        .then(entry.resolve)
        .catch((failure) => entry.reject(failure instanceof Error ? failure : new Error('Local AI fallback transport failed')))
    })
  }

  dispose() {
    if (this.pollTimer !== undefined) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    this.resultAckIds.clear()
    const sessionId = this.sessionId
    this.sessionId = null
    if (sessionId) {
      // All consumer promises have settled. Release the server-side job-id
      // registry immediately instead of retaining it for the 30-minute TTL.
      void requestJson(`/api/ai/sessions/${sessionId}`, { method: 'DELETE', directLocal: true }).catch(() => undefined)
    }
  }

  private cancel() {
    if (this.pollTimer !== undefined) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    const queued = [...this.queue.splice(0), ...this.pending.values()]
    this.pending.clear()
    this.resultAckIds.clear()
    queued.forEach((entry) => entry.reject(abortError()))
    // This cleanup request intentionally has no aborted signal attached.
    this.dispose()
  }
}

function analysisConcurrency(value: number | undefined, availableQueues: number) {
  const requested = normalizeAiConcurrency(value)
  return Math.min(requested, Math.max(1, availableQueues))
}

function bufferedWorkerConcurrency(providerConcurrency: number, availableJobs: number) {
  return Math.min(Math.max(1, availableJobs), providerConcurrency * MODEL_QUEUE_PREFETCH_FACTOR)
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

async function requestJson<T>(url: string, options?: { method?: 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal; directLocal?: boolean }): Promise<T> {
  throwIfAborted(options?.signal)
  const response = await fetch(options?.directLocal ? localProxyUrl(url) : apiUrl(url), options ? {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  } : undefined)
  const raw = await response.text()
  let payload: T & { error?: string; retry_after?: number; retryAfter?: number }
  try { payload = JSON.parse(raw) as T & { error?: string; retry_after?: number; retryAfter?: number } } catch { payload = {} as T & { error?: string; retry_after?: number; retryAfter?: number } }
  if (!response.ok) {
    const error = new Error(payload.error || raw.slice(0, 1200) || `请求失败 (${response.status})`)
    Object.assign(error, { status: response.status, retryAfter: Number(payload.retry_after ?? payload.retryAfter) })
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

async function requestWithRetry<T>(url: string, body: unknown, onRetry?: (notice: { attempt: number; total: number; delayMs: number }) => void, signal?: AbortSignal, batcher?: { request<TValue>(workflow: BatchWorkflow, payload: unknown): Promise<TValue> }) {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_SERVICE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal)
    try {
      const workflow: BatchWorkflow = url === '/api/ai/people' ? 'people' : 'tasks'
      return batcher ? await batcher.request<T>(workflow, body) : await requestJson<T>(url, { body, signal })
    } catch (error) {
      if (wasAborted(error) || signal?.aborted) throw abortError()
      lastError = error
      if (!retryable(error) || attempt === MAX_SERVICE_ATTEMPTS) break
      // Keep retries responsive, but avoid immediately synchronizing every
      // failed request against the same upstream origin. Relay Retry-After
      // values are hints only and are capped at the local two-second bound.
      const exponentialMs = SERVICE_RETRY_BASE_MS * (2 ** Math.min(3, attempt - 1))
      const upstreamMs = Number((error as { retryAfter?: number })?.retryAfter) * 1_000
      const delayMs = Math.min(
        SERVICE_RETRY_MAX_MS,
        Math.max(exponentialMs, Number.isFinite(upstreamMs) && upstreamMs > 0 ? upstreamMs : 0),
      )
      onRetry?.({ attempt: attempt + 1, total: MAX_SERVICE_ATTEMPTS, delayMs })
      await wait(delayMs, signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模型请求失败')
}

export async function getAiStatus(signal?: AbortSignal) {
  // A status read is independent of extraction work. In development, bypass
  // the Vite proxy so the renderer's limited connection pool stays free for
  // long model requests while Options remains responsive.
  return requestJson<AiStatus>('/api/ai/status', { signal, directLocal: true })
}

export async function saveAiProvider(config: AiProviderInput) {
  return requestJson<AiStatus>('/api/ai/config', { method: 'POST', body: config, directLocal: true }).then(notifyAiStatusChanged)
}

/** Adds a second (or later) independent API channel to the local provider pool. */
export async function createAiProviderChannel(config: AiProviderInput) {
  return requestJson<AiChannelMutationResult>('/api/ai/channels', { method: 'POST', body: config, directLocal: true }).then((result) => {
    notifyAiStatusChanged(result.pool ?? result)
    return result
  })
}

/** Updates one channel without exposing credentials to the renderer console. */
export async function updateAiProviderChannel(id: string, config: AiProviderInput) {
  return requestJson<AiChannelMutationResult>(`/api/ai/channels/${encodeURIComponent(id)}`, { method: 'POST', body: config, directLocal: true }).then((result) => {
    notifyAiStatusChanged(result.pool ?? result)
    return result
  })
}

export async function deleteAiProviderChannel(id: string) {
  return requestJson<AiStatus>(`/api/ai/channels/${encodeURIComponent(id)}`, { method: 'DELETE', directLocal: true }).then(notifyAiStatusChanged)
}

export async function discoverAiModels(config: AiProviderInput, signal?: AbortSignal) {
  return requestJson<AiModelsResult>('/api/ai/models', { method: 'POST', body: config, signal, directLocal: true })
}

export async function resetAiProvider() {
  return requestJson<AiStatus>('/api/ai/config', { method: 'DELETE', directLocal: true }).then(notifyAiStatusChanged)
}

/** Generates optional, task-specific suggestions from already extracted profile evidence. */
export async function generateTaskGuidance(context: TaskGuidanceContext, signal?: AbortSignal) {
  const payload = await requestWithRetry<{ guidance?: unknown; model?: unknown }>('/api/ai/task-guidance', context, undefined, signal)
  return {
    guidance: Array.isArray(payload.guidance)
      ? [...new Set(payload.guidance.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 4)
      : [],
    model: String(payload.model ?? 'unknown'),
  }
}

/**
 * Consolidates claim-level evidence. The merge response is verified again
 * before anything reaches the profile.
 */
export async function consolidatePersonLegacy(
  person: Pick<Person, 'name' | 'facts' | 'preferences' | 'advice' | 'portrait' | 'evidence' | 'profileNotes'>,
  settings?: Pick<AiSettings, 'promptInstructions'>,
): Promise<PersonConsolidation | null> {
  const profileNotes = person.profileNotes?.trim().slice(0, 6_000) ?? ''
  const verifiedEvidence = selectProfileEvidence((person.evidence ?? [])
    .filter((claim) => claim.text.trim() && claim.quote.trim() && claim.sourceIds.length)
    .map((claim) => ({
      ...claim,
      text: claim.text.trim().slice(0, 360),
      quote: claim.quote.trim().slice(0, 100),
      sourceIds: [...new Set(claim.sourceIds.map(String).filter(Boolean))].slice(0, 12),
    })), 96)
  if (!verifiedEvidence.length && !profileNotes) return null
  const payload = await requestWithRetry<{
    facts?: unknown
    preferences?: unknown
    advice?: unknown
    portrait?: unknown
    portraitSourceIds?: unknown
    profileNotesUsed?: unknown
    model?: unknown
  }>('/api/ai/people/merge', {
    person: {
      name: person.name,
      evidence: verifiedEvidence,
      // Kept for older local proxies; the server treats these as compatibility
      // fields and the client never trusts them without a matching claim.
      facts: [...new Set(person.facts.map((fact) => fact.trim()).filter(Boolean))].slice(0, 48),
      preferences: [...new Set((person.preferences ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 18),
      advice: [],
      portrait: null,
      profileNotes: profileNotes || null,
    },
    settings: {
      promptInstructions: {
        peopleMerge: settings?.promptInstructions?.peopleMerge ?? '',
      },
    },
  })

  const normalized = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
  const selected = (value: unknown, kind: PersonEvidence['kind']) => {
    const candidates = Array.isArray(value) ? value : []
    const result: PersonEvidence[] = []
    for (const item of candidates) {
      const claim = item && typeof item === 'object' ? item as { text?: unknown; quote?: unknown; sourceIds?: unknown } : undefined
      const text = typeof claim?.text === 'string' ? claim.text.trim() : typeof item === 'string' ? item.trim() : ''
      const quote = typeof claim?.quote === 'string' ? claim.quote.trim() : ''
      const sourceIds = Array.isArray(claim?.sourceIds) ? claim.sourceIds.map(String) : []
      const match = verifiedEvidence.find((evidence) => evidence.kind === kind && (
        normalized(evidence.text) === normalized(text)
        || (quote && normalized(evidence.quote) === normalized(quote) && sourceIds.some((id) => evidence.sourceIds.includes(id)))
      ))
      if (!match) continue
      const merged: PersonEvidence = {
        ...match,
        sourceIds: [...new Set([...match.sourceIds, ...sourceIds.filter((id) => match.sourceIds.includes(id))])],
      }
      if (!result.some((entry) => entry.kind === merged.kind && normalized(entry.text) === normalized(merged.text))) result.push(merged)
    }
    return result
  }
  const factsEvidence = selected(payload.facts, 'fact').slice(0, 12)
  const preferenceEvidence = selected(payload.preferences, 'preference').slice(0, 8)
  const evidence = [...factsEvidence, ...preferenceEvidence]
  if (!evidence.length && !profileNotes) return null
  const independentSourceCount = new Set(evidence.flatMap((claim) => claim.sourceIds)).size
  const evidenceTerms = evidence.flatMap((claim) => [claim.text, claim.quote])
    .map(normalized)
    .flatMap((value) => Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2)))
    .filter((term) => /^[\u4e00-\u9fffA-Za-z0-9]{2}$/.test(term))
    .filter((term) => !new Set(['\u8868\u793a', '\u63d0\u5230', '\u5355\u6b21', '\u8bc4\u4ef7', '\u5bf9\u8bdd', '\u8bc1\u636e', '\u4fe1\u606f', '\u4e92\u52a8', '\u76ee\u524d', '\u9700\u8981', '\u66f4\u591a']).has(term))
  const hasEvidencePhrase = (value: string) => {
    const compact = normalized(value)
    return evidenceTerms.some((term) => compact.includes(term))
  }
  const portraitCandidate = typeof payload.portrait === 'string' ? payload.portrait.trim().slice(0, 1800) : ''
  const verifiedSourceIds = new Set(verifiedEvidence.flatMap((claim) => claim.sourceIds))
  const portraitSourceIds = Array.isArray(payload.portraitSourceIds)
    ? [...new Set(payload.portraitSourceIds.map(String).filter((id) => verifiedSourceIds.has(id)))].slice(0, 6)
    : []
  const profileNotesUsed = Boolean(profileNotes) && payload.profileNotesUsed === true
  const explicitlyInsufficient = /\u8bc1\u636e\u4e0d\u8db3|\u4fe1\u606f\u4e0d\u8db3|\u9700\u8981\u66f4\u591a\u4fe1\u606f/.test(portraitCandidate)
  // A smooth generic description is not useful evidence. The visible portrait
  // must mention a specific verified term and cite at least two original
  // records. An "insufficient information" response remains valid only when
  // the available signals truly do not support a useful summary.
  const hasEnoughProfileSignals = independentSourceCount >= 3 && evidence.length >= 3
  const needsDetailedPortrait = hasEnoughProfileSignals || profileNotes.length >= 80
  const portraitHasVerifiedBasis = profileNotesUsed || (independentSourceCount >= 2 && portraitSourceIds.length >= 2)
  const portrait = portraitHasVerifiedBasis && portraitCandidate
    && (profileNotesUsed || hasEvidencePhrase(portraitCandidate) || (explicitlyInsufficient && !hasEnoughProfileSignals))
    ? portraitCandidate
    : undefined
  const advice = independentSourceCount >= 2 && Array.isArray(payload.advice)
    ? [...new Set(payload.advice.map(String).map((item) => item.trim()).filter((item) => hasEvidencePhrase(item) || /\u786e\u8ba4.{0,12}(?:\u504f\u597d|\u5b89\u6392|\u65f6\u95f4|\u5730\u70b9)/.test(item)))].slice(0, 4)
    : []
  // When a long chat supplied several verified signals, an ungrounded or
  // empty portrayal should trigger the bounded retry loop in App rather than
  // being marked as a successfully consolidated profile forever.
  if (needsDetailedPortrait && !portrait) return null
  return {
    facts: factsEvidence.map((claim) => claim.text),
    preferences: preferenceEvidence.map((claim) => claim.text),
    advice,
    portrait,
    portraitBlocks: [],
    portraitSchemaVersion: 0,
    portraitSourceIds: portrait ? portraitSourceIds : [],
    profileNotesUsed: Boolean(portrait && profileNotesUsed),
    evidence,
    model: String(payload.model ?? 'unknown'),
  }
}

type PersonMergeResponse = {
  factClaimIds?: unknown
  preferenceClaimIds?: unknown
  facts?: unknown
  preferences?: unknown
  portraitBlocks?: unknown
  advice?: unknown
  coverageNote?: unknown
  profileNotesUsed?: unknown
  model?: unknown
  portraitSchemaVersion?: unknown
}

const PORTRAIT_MANUAL_CLAIM_ID = 'user-profile-notes'

function claimIdForEvidence(claim: PersonEvidence) {
  return claim.id || `claim-${hash(claimKey(claim))}`
}

function claimAnchorTerms(claim: PersonEvidence) {
  const values = [normalizedEvidenceText(claim.text), normalizedEvidenceText(claim.quote)]
  return [...new Set(values.flatMap((value) => {
    const terms: string[] = []
    for (let size = 3; size >= 2; size -= 1) {
      for (let index = 0; index <= value.length - size; index += 1) {
        const term = value.slice(index, index + size)
        if (/^[\u4e00-\u9fffA-Za-z0-9]+$/.test(term)) terms.push(term)
      }
    }
    return terms
  }))].slice(0, 36)
}

function portraitSentenceHasAnchor(text: string, claims: PersonEvidence[]) {
  const compact = normalizedEvidenceText(text)
  return claims.some((claim) => {
    const fullText = normalizedEvidenceText(claim.text)
    const fullQuote = normalizedEvidenceText(claim.quote)
    if ((fullText.length >= 4 && compact.includes(fullText)) || (fullQuote.length >= 4 && compact.includes(fullQuote))) return true
    // A three-character anchor is the minimum for a paraphrase fallback. Two
    // common characters such as "喜欢" are too weak to support a whole
    // sentence and would let unsupported personality clauses slip through.
    return claimAnchorTerms(claim).some((term) => term.length >= 3 && compact.includes(term))
  })
}

function portraitBlockHasAnchor(text: string, claims: PersonEvidence[]) {
  const sentences = text.split(/[。！？!?；;\n]+/).map((sentence) => sentence.trim()).filter(Boolean)
  return sentences.length > 0 && sentences.every((sentence) => portraitSentenceHasAnchor(sentence, claims))
}

function unsupportedHardTokens(text: string, claims: PersonEvidence[], profileNotes: string) {
  const allowed = normalizedEvidenceText([...claims.map((claim) => `${claim.text} ${claim.quote}`), profileNotes].join(' '))
  const hardTokens = text.match(/\d{1,4}(?:年|月|日|点|号|周|次|岁|元|公里|%|％)?/g) ?? []
  return hardTokens.filter((token) => token && !allowed.includes(normalizedEvidenceText(token)))
}

function normalizePortraitCoverage(claims: PersonEvidence[], blocks: PersonPortraitBlock[], note?: string): PersonPortraitCoverage {
  const selected = [...new Map(blocks.flatMap((block) => block.claimIds.map((id) => [id, claims.find((claim) => claim.id === id)] as const)).filter((entry): entry is [string, PersonEvidence] => Boolean(entry[1]))).values()]
  const sourceIds = [...new Set(selected.flatMap((claim) => claim.sourceIds))]
  const dates = selected.flatMap((claim) => [claim.firstObservedAt, claim.lastObservedAt]).filter((value): value is string => Boolean(value))
  const orderedDates = dates.sort((left, right) => new Date(left).getTime() - new Date(right).getTime())
  return {
    claimCount: selected.length,
    sourceCount: sourceIds.length,
    categories: [...new Set(selected.map((claim) => claim.category).filter((category): category is PersonEvidenceCategory => Boolean(category)))],
    ...(orderedDates[0] ? { firstObservedAt: orderedDates[0] } : {}),
    ...(orderedDates.at(-1) ? { lastObservedAt: orderedDates.at(-1) } : {}),
    ...(note ? { note } : {}),
  }
}

function parsePersonMergeResponse(payload: PersonMergeResponse, verifiedEvidence: PersonEvidence[], profileNotes: string) {
  const registry = new Map<string, PersonEvidence>(verifiedEvidence.map((claim) => [claimIdForEvidence(claim), { ...claim, id: claimIdForEvidence(claim) }]))
  const resolveClaimId = (value: unknown, kind: PersonEvidence['kind']) => {
    if (typeof value === 'string' && registry.get(value)?.kind === kind) return value
    if (!value || typeof value !== 'object') return null
    const candidate = value as { id?: unknown; text?: unknown; quote?: unknown; sourceIds?: unknown }
    if (typeof candidate.id === 'string' && registry.get(candidate.id)?.kind === kind) return candidate.id
    const text = normalizedEvidenceText(candidate.text)
    const quote = normalizedEvidenceText(candidate.quote)
    const match = [...registry.values()].find((claim) => claim.kind === kind && (
      (text && normalizedEvidenceText(claim.text) === text) || (quote && normalizedEvidenceText(claim.quote) === quote)
    ))
    return match?.id ?? null
  }
  const normalizeIds = (value: unknown, kind: PersonEvidence['kind'], limit: number) => {
    const values = Array.isArray(value) ? value : []
    return [...new Set(values.map((item) => resolveClaimId(item, kind)).filter((id): id is string => Boolean(id)))].slice(0, limit)
  }
  const factClaimIds = normalizeIds(payload.factClaimIds ?? payload.facts, 'fact', 12)
  const preferenceClaimIds = normalizeIds(payload.preferenceClaimIds ?? payload.preferences, 'preference', 8)
  const issues: string[] = []
  const blocks: PersonPortraitBlock[] = []
  const rawBlocks = Array.isArray(payload.portraitBlocks) ? payload.portraitBlocks : []
  for (const raw of rawBlocks.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') {
      issues.push('portrait_block_not_object')
      continue
    }
    const value = raw as { text?: unknown; claimIds?: unknown; reason?: unknown }
    const text = typeof value.text === 'string' ? value.text.trim().slice(0, 1800) : ''
    const rawClaimIds = Array.isArray(value.claimIds) ? [...new Set(value.claimIds.map(String))].slice(0, 12) : []
    const claimIds = rawClaimIds.filter((id) => registry.has(id) || (id === PORTRAIT_MANUAL_CLAIM_ID && Boolean(profileNotes)))
    const claims = claimIds.map((id) => registry.get(id)).filter((claim): claim is PersonEvidence => Boolean(claim))
    if (!text || !claimIds.length) {
      issues.push('portrait_block_missing_text_or_claims')
      continue
    }
    if (/(?:证据不足|信息不足|无法据此判断|需要更多信息)/.test(text)) {
      issues.push('portrait_block_contains_coverage_disclaimer')
      continue
    }
    if (claims.some((claim) => claim.portraitEligible === false)) {
      issues.push('portrait_block_uses_non_portrait_claim')
      continue
    }
    if (claimIds.includes(PORTRAIT_MANUAL_CLAIM_ID) && !portraitUsesProfileNotes(text, profileNotes)) {
      issues.push('portrait_block_has_no_profile_notes_anchor')
      continue
    }
    if (/(?:\u8bc1\u636e(?:\u4e0d\u8db3|\u6709\u9650)|\u4fe1\u606f(?:\u4e0d\u8db3|\u6709\u9650)|\u65e0\u6cd5(?:\u636e\u6b64\u5224\u65ad|\u786e\u8ba4|\u786e\u5b9a)|\u5c1a\u4e0d\u660e\u786e|\u6682\u65e0\u6cd5\u5224\u65ad|\u9700\u8981\u66f4\u591a\u4fe1\u606f)/.test(text)) {
      issues.push('portrait_block_contains_coverage_disclaimer')
      continue
    }
    if (claims.length && !portraitBlockHasAnchor(text, claims)) {
      issues.push('portrait_block_has_no_claim_anchor')
      continue
    }
    const hardTokens = unsupportedHardTokens(text, claims, profileNotes)
    if (hardTokens.length) {
      issues.push(`portrait_block_has_unsupported_hard_token:${hardTokens.slice(0, 3).join(',')}`)
      continue
    }
    const reason = ['background', 'preference', 'habit', 'interaction', 'change', 'other'].includes(String(value.reason))
      ? String(value.reason) as PersonPortraitBlock['reason']
      : 'other'
    blocks.push({
      id: `portrait-${hash(`${text}|${claimIds.join(',')}`)}`,
      text,
      claimIds,
      sourceIds: [...new Set(claims.flatMap((claim) => claim.sourceIds))].slice(0, 12),
      reason,
    })
  }
  const chatSourceIds = new Set(blocks.flatMap((block) => block.sourceIds))
  const manualUsed = blocks.some((block) => block.claimIds.includes(PORTRAIT_MANUAL_CLAIM_ID))
  const eligibleEvidence = [...registry.values()].filter((claim) => claim.portraitEligible !== false)
  const enoughChatEvidence = chatSourceIds.size >= 2
  if (blocks.length && !manualUsed && !enoughChatEvidence) issues.push('portrait_requires_two_independent_chat_sources')
  if (!blocks.length && (eligibleEvidence.filter((claim) => claim.category !== 'temporary' && claim.category !== 'filler').length >= 3 || profileNotes.length >= 80)) {
    issues.push('portrait_expected_for_available_signals')
  }
  const advice = Array.isArray(payload.advice)
    ? payload.advice.map((item) => {
      if (!item || typeof item !== 'object') return null
      const value = item as { text?: unknown; claimIds?: unknown }
      const text = typeof value.text === 'string' ? value.text.trim().slice(0, 360) : ''
      const claimIds = Array.isArray(value.claimIds) ? [...new Set(value.claimIds.map(String).filter((id) => registry.has(id)))].slice(0, 8) : []
      const claims = claimIds.map((id) => registry.get(id)).filter((claim): claim is PersonEvidence => Boolean(claim))
      if (!text || !claimIds.length || new Set(claims.flatMap((claim) => claim.sourceIds)).size < 2) return null
      return text
    }).filter((item): item is string => Boolean(item)).slice(0, 4)
    : []
  const acceptedBlocks = enoughChatEvidence || manualUsed ? blocks : []
  const portrait = acceptedBlocks.map((block) => block.text).join('\n\n') || undefined
  const evidence = [...factClaimIds, ...preferenceClaimIds].map((id) => registry.get(id)).filter((claim): claim is PersonEvidence => Boolean(claim))
  const coverageNote = typeof payload.coverageNote === 'string' ? payload.coverageNote.trim().slice(0, 240) : undefined
  // Derive this from accepted provenance instead of trusting a model-owned
  // boolean. Manual blocks already passed the deterministic text anchor.
  const profileNotesUsed = Boolean(profileNotes) && manualUsed
  return {
    issues: [...new Set(issues)],
    facts: factClaimIds.map((id) => registry.get(id)?.text).filter((text): text is string => Boolean(text)),
    preferences: preferenceClaimIds.map((id) => registry.get(id)?.text).filter((text): text is string => Boolean(text)),
    advice,
    portrait,
    portraitBlocks: acceptedBlocks,
    portraitSourceIds: [...new Set(acceptedBlocks.flatMap((block) => block.sourceIds))].slice(0, 12),
    portraitCoverage: normalizePortraitCoverage([...registry.values()], acceptedBlocks, coverageNote),
    coverageNote,
    profileNotesUsed: Boolean(portrait && profileNotesUsed),
    portraitSchemaVersion: 1,
    evidence,
  }
}

export async function consolidatePerson(
  person: Pick<Person, 'name' | 'facts' | 'preferences' | 'advice' | 'portrait' | 'evidence' | 'profileNotes'>,
  settings?: Pick<AiSettings, 'promptInstructions'>,
  signal?: AbortSignal,
): Promise<PersonConsolidation | null> {
  const profileNotes = person.profileNotes?.trim().slice(0, 6_000) ?? ''
  const verifiedEvidence = selectProfileEvidence((person.evidence ?? [])
    .filter((claim) => claim.text.trim() && claim.quote.trim() && claim.sourceIds.length)
    .map((claim) => enrichPersonEvidence({
      ...claim,
      id: claimIdForEvidence(claim),
      text: claim.text.trim().slice(0, 360),
      quote: claim.quote.trim().slice(0, 100),
      sourceIds: [...new Set(claim.sourceIds.map(String).filter(Boolean))].slice(0, 12),
    })), 96)
  if (!verifiedEvidence.length && !profileNotes) return null
  const basePayload = {
    person: {
      name: person.name,
      evidence: verifiedEvidence,
      facts: [...new Set(person.facts.map((fact) => fact.trim()).filter(Boolean))].slice(0, 48),
      preferences: [...new Set((person.preferences ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 18),
      advice: [],
      portrait: null,
      profileNotes: profileNotes || null,
    },
    settings: {
      promptInstructions: {
        peopleMerge: settings?.promptInstructions?.peopleMerge ?? '',
      },
    },
  }
  const requestMerge = (repair?: { issues: string[]; previousBlocks: PersonPortraitBlock[] }) => requestWithRetry<PersonMergeResponse>('/api/ai/people/merge', {
    ...basePayload,
    ...(repair ? { repair } : {}),
  }, undefined, signal)
  const first = await requestMerge()
  let parsed = parsePersonMergeResponse(first, verifiedEvidence, profileNotes)
  if (parsed.issues.length) {
    const repaired = await requestMerge({
      issues: parsed.issues,
      previousBlocks: parsed.portraitBlocks,
    })
    parsed = parsePersonMergeResponse(repaired, verifiedEvidence, profileNotes)
  }
  if (parsed.issues.length) return null
  if (!parsed.facts.length && !parsed.preferences.length && !parsed.portrait) return null
  return {
    facts: parsed.facts,
    preferences: parsed.preferences,
    advice: parsed.advice,
    portrait: parsed.portrait,
    portraitBlocks: parsed.portraitBlocks,
    portraitCoverage: parsed.portraitCoverage,
    portraitSchemaVersion: parsed.portraitSchemaVersion,
    portraitSourceIds: parsed.portrait ? parsed.portraitSourceIds : [],
    profileNotesUsed: parsed.profileNotesUsed,
    evidence: parsed.evidence,
    model: String(first.model ?? 'unknown'),
  }
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
  id?: unknown
  text?: unknown
  sourceIds?: unknown
  quote?: unknown
  category?: unknown
  stability?: unknown
  importanceScore?: unknown
  portraitEligible?: unknown
}

function normalizedEvidenceText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
}

const personEvidenceCategoryValues: PersonEvidenceCategory[] = ['identity', 'background', 'preference', 'habit', 'boundary', 'interaction', 'skill', 'temporary', 'filler']

function inferPersonEvidenceCategory(claim: Pick<PersonEvidence, 'kind' | 'text' | 'quote'>): PersonEvidenceCategory {
  const compact = normalizedEvidenceText(`${claim.text} ${claim.quote}`)
  if (/(?:刚才|今天|明天|下周|等会|稍后|五点|正在|待会|收快递|取件|提交|截止|报名|请假|复学)/.test(compact)) return 'temporary'
  if (/(?:不要再|不要打扰|不允许|别叫|拒绝|请勿|不想要)/.test(compact)) return 'boundary'
  if (/(?:喜欢|不喜欢|爱吃|讨厌|感兴趣|喜欢玩|爱玩|想吃|想去|喜欢听|喜欢看)/.test(compact)) return 'preference'
  if (/(?:经常|通常|习惯|每天|每周|一般会|平时)/.test(compact)) return 'habit'
  if (/(?:学校|学生|工作|家人|家乡|居住|来自|专业|年级|身份)/.test(compact)) return 'identity'
  if (/(?:会|一起|见面|吃饭|打台球|请你|邀请|帮忙|联系)/.test(compact)) return 'interaction'
  if (/(?:会做|擅长|学过|会用|考试|课程|技能)/.test(compact)) return 'skill'
  return claim.kind === 'preference' ? 'preference' : 'background'
}

function personEvidenceStability(claim: Pick<PersonEvidence, 'sourceIds' | 'firstObservedAt' | 'lastObservedAt' | 'evidenceStrength'>): PersonEvidence['stability'] {
  const sourceCount = new Set(claim.sourceIds).size
  const first = new Date(claim.firstObservedAt ?? '').getTime()
  const last = new Date(claim.lastObservedAt ?? '').getTime()
  const spanDays = Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) / 86_400_000 : 0
  if (sourceCount >= 3 || (sourceCount >= 2 && spanDays >= 30)) return 'persistent'
  if (sourceCount >= 2 || claim.evidenceStrength === 'repeated') return 'repeated'
  return 'single'
}

function enrichPersonEvidence(claim: PersonEvidence): PersonEvidence {
  const category = claim.category && personEvidenceCategoryValues.includes(claim.category) ? claim.category : inferPersonEvidenceCategory(claim)
  const stability = personEvidenceStability(claim)
  const score = profileSignalScore({ ...claim, category, stability })
  const portraitEligible = claim.portraitEligible !== false && category !== 'temporary' && category !== 'filler'
  return {
    ...claim,
    id: claim.id || `claim-${hash(claimKey(claim))}`,
    category,
    stability,
    importanceScore: Number.isFinite(claim.importanceScore) ? Math.max(0, Math.min(10, Number(claim.importanceScore))) : score,
    portraitEligible,
    origin: claim.origin ?? 'chat',
  }
}

function singleQuoteOverstatesClaim(text: string, quote: string) {
  const compactText = normalizedEvidenceText(text)
  const compactQuote = normalizedEvidenceText(quote)
  // A model sometimes turns “X is tasty” into “likes/eats X often”. For a
  // one-message claim, stable-habit or personality language is valid only
  // when that same strength is explicitly present in the quoted message.
  const strongTerms = [
    '\u559c\u6b22', '\u7231\u5403', '\u70ed\u7231', '\u7ecf\u5e38', '\u603b\u662f', '\u4e60\u60ef',
    '\u6027\u683c', '\u5185\u5411', '\u5916\u5411', '\u5f88\u72ec\u7acb', '\u5f88\u6e29\u67d4',
  ]
  return strongTerms.some((term) => compactText.includes(term) && !compactQuote.includes(term))
}

function verifyPersonClaim(
  value: unknown,
  name: string,
  allowedIds: Set<string>,
  recordsById: Map<string, IntelItem>,
  kind: PersonEvidence['kind'],
): PersonEvidence | null {
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
  if (verifiedSourceIds.length === 1 && singleQuoteOverstatesClaim(text, quote)) return null
  const datedEvidence = verifiedSourceIds
    .map((id) => recordsById.get(id)?.capturedAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => {
      const leftTime = new Date(left).getTime()
      const rightTime = new Date(right).getTime()
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
      return left.localeCompare(right)
    })
  return enrichPersonEvidence({
    kind,
    text,
    quote,
    sourceIds: verifiedSourceIds,
    evidenceStrength: verifiedSourceIds.length >= 2 ? 'repeated' : 'single',
    firstObservedAt: datedEvidence[0],
    lastObservedAt: datedEvidence.at(-1),
  })
}

function claimKey(claim: PersonEvidence) {
  return `${claim.kind}|${normalizedEvidenceText(claim.text)}|${normalizedEvidenceText(claim.quote)}`
}

function mergePersonEvidence(current: PersonEvidence[] = [], incoming: PersonEvidence[] = []) {
  const merged = new Map<string, PersonEvidence>()
  for (const claim of [...current, ...incoming]) {
    if (!claim.text?.trim() || !claim.quote?.trim() || !claim.sourceIds?.length) continue
    const key = claimKey(claim)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, enrichPersonEvidence({ ...claim, sourceIds: [...new Set(claim.sourceIds)].slice(0, 12) }))
      continue
    }
    const sourceIds = [...new Set([...existing.sourceIds, ...claim.sourceIds])].slice(0, 12)
    const times = [existing.firstObservedAt, existing.lastObservedAt, claim.firstObservedAt, claim.lastObservedAt]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => {
        const leftTime = new Date(left).getTime()
        const rightTime = new Date(right).getTime()
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
        return left.localeCompare(right)
      })
    merged.set(key, enrichPersonEvidence({
      ...existing,
      sourceIds,
      evidenceStrength: sourceIds.length >= 2 ? 'repeated' : 'single',
      firstObservedAt: times[0],
      lastObservedAt: times.at(-1),
    }))
  }
  return selectProfileEvidence([...merged.values()], 600)
}

function notesFromEvidence(evidence: PersonEvidence[], kind: PersonEvidence['kind'], limit: number) {
  return [...new Set(evidence.filter((claim) => claim.kind === kind).map((claim) => claim.text.trim()).filter(Boolean))].slice(0, limit)
}

/*
function profileSignalScoreLegacy(claim: PersonEvidence) {
  const compact = normalizedEvidenceText(`${claim.text} ${claim.quote}`)
  let score = claim.kind === 'preference' ? 7 : 2
  if (claim.evidenceStrength === 'repeated') score += 5
  if (/(?:喜欢|不喜欢|想要|想去|爱吃|感兴趣|习惯|常去|希望|讨厌|擅长|在意|计划|准备)/.test(compact)) score += 3
  if (claim.quote.trim().length >= 8) score += 1
  if (/^(?:好|嗯|哦|哈哈|行|可以|知道了|收到)[!！。.]?$/.test(claim.quote.trim())) score -= 6
  return score
}

*/

function profileSignalScore(claim: PersonEvidence) {
  const compact = normalizedEvidenceText(`${claim.text} ${claim.quote}`)
  let score = claim.kind === 'preference' ? 5 : 2
  if (claim.stability === 'persistent') score += 6
  else if (claim.stability === 'repeated' || claim.evidenceStrength === 'repeated') score += 4
  if (/(?:\u559c\u6b22|\u4e0d\u559c\u6b22|\u60f3\u8981|\u60f3\u53bb|\u7231\u5403|\u611f\u5174\u8da3|\u4e60\u60ef|\u5e38\u53bb|\u5e0c\u671b|\u8ba8\u538c|\u64c5\u957f|\u5728\u610f|\u8ba1\u5212|\u51c6\u5907)/.test(compact)) score += 3
  if (claim.quote.trim().length >= 8) score += 1
  if (/^(?:\u597d|\u54c8\u54c8|\u53ef\u4ee5|\u77e5\u9053\u4e86|\u6536\u5230|\u55ef|\u884c)[!！?？。,.，]*$/.test(claim.quote.trim())) score -= 6
  if (claim.category === 'temporary' || claim.category === 'filler') score -= 6
  return score
}

/**
 * Keep long conversations representative without resending raw chat. The
 * profile merge sees verified claims from the beginning, end, and evenly
 * distributed middle of the timeline, instead of only whichever segments
 * happened to finish first.
 */
function selectProfileEvidence(evidence: PersonEvidence[], limit: number) {
  const ordered = [...evidence].sort((left, right) => {
    const leftTime = new Date(left.lastObservedAt ?? left.firstObservedAt ?? '').getTime()
    const rightTime = new Date(right.lastObservedAt ?? right.firstObservedAt ?? '').getTime()
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
    if (Number.isFinite(leftTime)) return -1
    if (Number.isFinite(rightTime)) return 1
    return claimKey(left).localeCompare(claimKey(right))
  })
  if (ordered.length <= limit) return ordered
  const selected = new Set<number>()
  const edgeCount = Math.min(18, Math.floor(limit / 4))
  for (let index = 0; index < edgeCount; index += 1) selected.add(index)
  for (let index = Math.max(edgeCount, ordered.length - edgeCount); index < ordered.length; index += 1) selected.add(index)
  const repeated = ordered.map((claim, index) => ({ claim, index })).filter(({ claim }) => claim.evidenceStrength === 'repeated')
  for (const { index } of repeated) {
    if (selected.size >= Math.floor(limit * 0.45)) break
    selected.add(index)
  }
  // Long conversations can contain hundreds of timestamp-accurate but
  // profile-poor confirmations. Reserve space for direct preferences and
  // repeated, substantive statements before filling the timeline evenly.
  const highSignal = ordered
    .map((claim, index) => ({ index, score: profileSignalScore(claim) }))
    .filter((entry) => entry.score >= 5)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  for (const { index } of highSignal) {
    if (selected.size >= Math.floor(limit * 0.7)) break
    selected.add(index)
  }
  const remainingSlots = Math.max(0, limit - selected.size)
  const middle = ordered.map((_, index) => index).filter((index) => !selected.has(index))
  for (let slot = 0; slot < remainingSlots && middle.length; slot += 1) {
    selected.add(middle[Math.min(middle.length - 1, Math.floor((slot + 0.5) * middle.length / remainingSlots))])
  }
  return [...selected].sort((left, right) => left - right).map((index) => ordered[index])
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
    ? value.facts.map((claim) => verifyPersonClaim(claim, name, allowedIds, recordsById, 'fact')).filter((claim): claim is PersonEvidence => Boolean(claim))
    : []
  const preferenceClaims = Array.isArray(value.preferences)
    ? value.preferences.map((claim) => verifyPersonClaim(claim, name, allowedIds, recordsById, 'preference')).filter((claim): claim is PersonEvidence => Boolean(claim))
    : []
  const evidenceClaims = mergePersonEvidence(factClaims, preferenceClaims)
  const facts = notesFromEvidence(evidenceClaims, 'fact', 12)
  const preferences = notesFromEvidence(evidenceClaims, 'preference', 8)
  const sourceIds = [...new Set(evidenceClaims.flatMap((claim) => claim.sourceIds))].slice(0, 60)
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
  const avatarUrl = evidence.find((item) => item.speakerRole === 'other' && item.speaker?.trim() === name && item.avatarUrl)?.avatarUrl
  const id = `person-${hash(`${name}|${[...sourceIds].sort().join(',')}`)}-${index}`
  const platforms = [...new Set(evidence.map((item) => item.source).filter((platform): platform is IntelItem['source'] => allowedPlatforms.has(platform)))].slice(0, 8)
  // Portrait and advice are deliberately not accepted in this segment pass.
  // They are generated once after all verified claims are available.
  return { id, name, avatarUrl, facts, preferences, evidence: evidenceClaims, advice: [], sourceIds, conversationIds, firstObservedAt, lastObservedAt, platforms, model, createdAt: new Date().toISOString() }
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
        log('conversation_retry_scheduled', 'warn', { conversationId: conversation.id, conversationName: conversation.name, recordCount: conversation.records.length, attempt: notice.attempt, attemptTotal: notice.total, retryDelayMs: notice.delayMs, message: notice.delayMs ? `${Math.ceil(notice.delayMs / 1000)} 秒后自动重连` : '立即重连' })
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
 * Sends every imported message while keeping each individual task request
 * bounded for compatibility relays. Task extraction uses the conservative
 * compact window plan; person extraction has its own wider plan below.
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
  const settledSegments = new Map<string, Set<number>>()
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
    if (inferConversationKind(item) !== 'direct' || !item.conversationId) continue
    const records = conversationRecords.get(item.conversationId)
    if (records) records.push(item)
    else conversationRecords.set(item.conversationId, [item])
  }

  log('run_started', 'info', {
    recordCount: items.length,
    message: `将 ${plan.totalConversations} 个对话拆为 ${plan.totalSegments} 个重叠片段；所有消息均会上传。片段会跨会话交错并行，结果仍按原始时间线归并。`,
  })
  const segmentsByConversation = new Map<string, Array<{ segment: typeof plan.jobs[number]; index: number }>>()
  plan.jobs.forEach((segment, index) => {
    const queue = segmentsByConversation.get(segment.id)
    if (queue) queue.push({ segment, index })
    else segmentsByConversation.set(segment.id, [{ segment, index }])
  })
  // Each segment includes an overlap window and returns evidence against its
  // own core range. Requests therefore have no model-output dependency on the
  // preceding segment. Interleave the queues so short conversations start
  // promptly, then let the global worker pool also fill capacity with later
  // segments from a long conversation.
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
  const concurrency = analysisConcurrency(options?.concurrency ?? settings.concurrency, plan.jobs.length)
  const workerConcurrency = bufferedWorkerConcurrency(concurrency, plan.jobs.length)
  const batcher = new AiSessionRequestBatcher(workerConcurrency, options?.signal)
  const segmentQueue: Array<{ segment: typeof plan.jobs[number]; index: number }> = []
  for (let offset = 0; ; offset += 1) {
    let added = false
    for (const queue of conversationQueues) {
      const entry = queue[offset]
      if (!entry) continue
      segmentQueue.push(entry)
      added = true
    }
    if (!added) break
  }
  // Attachments are global context, so include them in one deterministic
  // segment only; concurrent workers must never duplicate the upload.
  const attachmentOwnerIndex = attachments.length ? 0 : -1
  const progressCandidateKeys = new Set<string>()
  let processedSegments = 0
  let cancelled = false
  let activeWorkers = 0
  const completedConversationCount = () => [...segmentCounts.entries()]
    .filter(([conversationId, segmentCount]) => settledSegments.get(conversationId)?.size === segmentCount)
    .length

  const processSegment = async (segment: typeof plan.jobs[number], index: number) => {
    if (options?.signal?.aborted) { cancelled = true; return false }
    activeWorkers += 1
    const acceptedCandidates: AiTaskCandidate[] = []
    const sourceById = new Map(segment.records.map((item) => [item.id, item]))
    const coreIds = new Set(segment.coreRecordIds)
    const coreRecordIndexes = segment.records
      .map((item, recordIndex) => coreIds.has(item.id) ? String(recordIndex + 1) : null)
      .filter((value): value is string => Boolean(value))
    const progress = (retry?: { attempt: number; total: number; delayMs: number }, completedConversationId?: string) => {
      onProgress?.({
        completed: processedSegments,
        total: plan.totalSegments,
        completedConversations: completedConversationCount(),
        totalConversations: plan.totalConversations,
        completedConversationId,
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
          // People use their own evidence-oriented pass after task extraction.
          // Keeping task requests task-only avoids an empty combined response
          // incorrectly marking a private conversation as fully processed.
          people: false,
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
          promptInstructions: { task: settings.promptInstructions.task },
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
          message: notice.delayMs ? `${(notice.delayMs / 1000).toFixed(1)} 秒后自动重连` : '立即重连',
        })
        progress(notice)
      }, options?.signal, batcher)
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
    const settled = settledSegments.get(segment.id) ?? new Set<number>()
    settled.add(segment.segmentIndex)
    settledSegments.set(segment.id, settled)
    processedSegments += 1
    const conversationSucceeded = successfulSegments.get(segment.id)?.size === (segmentCounts.get(segment.id) ?? Number.POSITIVE_INFINITY)
    progress(undefined, conversationSucceeded ? segment.id : undefined)
    return true
  }

  onProgress?.({
    completed: 0,
    total: plan.totalSegments,
    completedConversations: 0,
    totalConversations: plan.totalConversations,
    candidates: 0,
    recordCount: plan.recordCount,
    activeWorkers: 0,
    concurrency,
  })
  let nextSegmentQueueIndex = 0
  const worker = async () => {
    while (nextSegmentQueueIndex < segmentQueue.length) {
      if (options?.signal?.aborted) { cancelled = true; return }
      const entry = segmentQueue[nextSegmentQueueIndex]
      nextSegmentQueueIndex += 1
      if (!entry || !await processSegment(entry.segment, entry.index)) return
    }
  }
  try {
    await Promise.all(Array.from({ length: workerConcurrency }, () => worker()))
  } finally {
    batcher.dispose()
  }

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
    if (inferConversationKind(item) !== 'direct') continue
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
    .filter(([, records]) => records.some((item) => inferConversationKind(item) === 'direct'))
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
  const evidence = mergePersonEvidence(current.evidence, incoming.evidence)
  const hasModelEvidence = evidence.length > 0
  // Segment results can overlap and may be replayed after a retry. Treat an
  // identical claim set as idempotent so a duplicate response does not clear
  // already-consolidated profile fields.
  const evidenceChanged = JSON.stringify(current.evidence ?? []) !== JSON.stringify(evidence)
  const merged: Person = {
    ...current,
    avatarUrl: current.avatarUrl ?? incoming.avatarUrl,
    // Keep only evidence-backed notes once a model segment has contributed
    // claims. Local fallback timestamps remain available until that happens.
    facts: hasModelEvidence
      ? notesFromEvidence(evidence, 'fact', 96)
      : [...new Set([...current.facts, ...incoming.facts])].slice(0, 48),
    preferences: hasModelEvidence
      ? notesFromEvidence(evidence, 'preference', 24)
      : [...new Set([...(current.preferences ?? []), ...(incoming.preferences ?? [])])].slice(0, 18),
    evidence: hasModelEvidence ? evidence : current.evidence ?? incoming.evidence,
    advice: evidenceChanged ? [] : [...new Set([...(current.advice ?? []), ...(incoming.advice ?? [])])].slice(0, 9),
    sourceIds: [...new Set([...current.sourceIds, ...incoming.sourceIds, ...evidence.flatMap((claim) => claim.sourceIds)])].slice(0, 120),
    conversationIds: [...new Set([...(current.conversationIds ?? []), ...(incoming.conversationIds ?? [])])],
    firstObservedAt: mergeObservedAt(current.firstObservedAt, incoming.firstObservedAt),
    lastObservedAt: mergeObservedAt(current.lastObservedAt, incoming.lastObservedAt, true),
    portrait: evidenceChanged ? undefined : current.portrait ?? incoming.portrait,
    portraitSourceIds: evidenceChanged ? undefined : current.portraitSourceIds ?? incoming.portraitSourceIds,
    profileNotesUsed: evidenceChanged ? undefined : current.profileNotesUsed ?? incoming.profileNotesUsed,
    portraitEvidenceSignature: evidenceChanged ? undefined : current.portraitEvidenceSignature,
    platforms: [...new Set([...current.platforms, ...incoming.platforms])],
    model: incoming.model,
  }
  people[index] = merged
  return merged
}

/** Uses a wider complete-coverage window plan than task extraction. */
export async function analyzePeople(
  items: IntelItem[],
  onProgress?: (progress: AiProgress) => void,
  onPeople?: (people: Person[]) => void,
  onLog?: AiDebugWriter,
  settings?: Pick<AiSettings, 'promptInstructions'>,
  options?: { signal?: AbortSignal; concurrency?: number },
) {
  const plan = buildPeopleConversationAnalysisPlan(items)
  const directSegments = plan.jobs.filter((job) => job.kind === 'direct')
  const recordsByConversation = new Map<string, IntelItem[]>()
  items.filter((item) => inferConversationKind(item) === 'direct' && item.conversationId).forEach((item) => {
    const records = recordsByConversation.get(item.conversationId!)
    if (records) records.push(item)
    else recordsByConversation.set(item.conversationId!, [item])
  })
  const people: Person[] = []
  const failedBatches: number[] = []
  const successfulSegments = new Map<string, Set<number>>()
  const settledSegments = new Map<string, Set<number>>()
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
    workflowConcurrency: Math.min(PEOPLE_WORKFLOW_CONCURRENCY, analysisConcurrency(options?.concurrency, directSegments.length)),
    message: `人物处理收到 ${items.length} 条记录；可处理私聊片段 ${directSegments.length} 个，对应完整私聊 ${recordsByConversation.size} 个。带重叠上下文的片段会跨会话交错并行，人物事实仍按证据归并。`,
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
  const configuredConcurrency = analysisConcurrency(options?.concurrency, directSegments.length)
  const concurrency = Math.min(PEOPLE_WORKFLOW_CONCURRENCY, configuredConcurrency)
  // Do not multiply person workers by the generic task prefetch factor. A
  // wide person window carries substantially more context and should occupy a
  // bounded number of upstream requests, even when the global setting is 40+.
  const workerConcurrency = Math.min(concurrency, directSegments.length)
  const batcher = new AiSessionRequestBatcher(workerConcurrency, options?.signal)
  const segmentQueue: Array<{ segment: typeof directSegments[number]; offset: number }> = []
  for (let queueOffset = 0; ; queueOffset += 1) {
    let added = false
    for (const queue of conversationQueues) {
      const entry = queue[queueOffset]
      if (!entry) continue
      segmentQueue.push(entry)
      added = true
    }
    if (!added) break
  }
  let completedSegments = 0
  let activeWorkers = 0
  const completedConversationCount = () => [...segmentsByConversation.entries()]
    .filter(([conversationId, segments]) => settledSegments.get(conversationId)?.size === segments.length)
    .length

  onProgress?.({
    completed: 0,
    total: directSegments.length,
    completedConversations: 0,
    totalConversations: segmentsByConversation.size,
    candidates: 0,
    currentConversation: conversationQueues[0]?.[0]?.segment.name,
    activeWorkers: 0,
    concurrency,
  })

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
        totalRecordCount: segment.totalRecords,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        coreRecordCount: segment.coreRecordCount,
        overlapRecordCount: segment.overlapRecordCount,
        historical: segment.historical,
        workflowConcurrency: concurrency,
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
      }, undefined, options?.signal, batcher)
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
      const rawClaimCount = modelPeople.reduce<number>((count, value) => {
        const person = value as { facts?: unknown; preferences?: unknown }
        return count + (Array.isArray(person.facts) ? person.facts.length : 0) + (Array.isArray(person.preferences) ? person.preferences.length : 0)
      }, 0)
      let acceptedClaimCount = 0
      modelPeople.forEach((value, index) => {
        const person = normalizePerson(value as Partial<Person>, model, offset * 1_000 + index, allowedIds, allowedPlatforms, sourceById)
        if (!person || !person.sourceIds.some((id) => coreIds.has(id))) return
        acceptedClaimCount += person.evidence?.length ?? 0
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
        totalRecordCount: segment.totalRecords,
        segmentIndex: segment.segmentIndex,
        segmentCount: segment.segmentCount,
        candidateCount: modelPeople.length,
        acceptedCandidateCount: additions.length,
        rawClaimCount,
        acceptedClaimCount,
        deduplicatedClaimCount: additions.reduce<number>((count, person) => count + (person.evidence?.length ?? 0), 0),
        singleEvidenceCount: additions.reduce<number>((count, person) => count + (person.evidence?.filter((claim) => claim.evidenceStrength === 'single').length ?? 0), 0),
        repeatedEvidenceCount: additions.reduce<number>((count, person) => count + (person.evidence?.filter((claim) => claim.evidenceStrength === 'repeated').length ?? 0), 0),
        portraitGenerated: false,
        message: `模型 ${payload.model} 返回 ${modelPeople.length} 个人物，校验后本片段保留 ${additions.length} 个。`,
      })
      const successful = successfulSegments.get(segment.id) ?? new Set<number>()
      successful.add(segment.segmentIndex)
      successfulSegments.set(segment.id, successful)
    } catch (error) {
      if (wasAborted(error) || options?.signal?.aborted) throw abortError()
      // A failed segment must not prevent remaining segments from preserving
      // facts or a conservative verified counterpart card.
      failedBatches.push(offset)
      log('people_segment_failed', 'error', {
        conversationId: segment.id,
        conversationName: segment.name,
        recordCount: segment.recordCount,
        totalRecordCount: segment.totalRecords,
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
    const settled = settledSegments.get(segment.id) ?? new Set<number>()
    settled.add(segment.segmentIndex)
    settledSegments.set(segment.id, settled)
    completedSegments += 1
    onProgress?.({
      completed: completedSegments,
      total: directSegments.length,
      completedConversations: completedConversationCount(),
      totalConversations: segmentsByConversation.size,
      completedConversationId: successfulSegments.get(segment.id)?.size === (segmentsByConversation.get(segment.id)?.length ?? Number.POSITIVE_INFINITY) ? segment.id : undefined,
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

  let nextSegmentQueueIndex = 0
  const worker = async () => {
    while (nextSegmentQueueIndex < segmentQueue.length) {
      throwIfAborted(options?.signal)
      const entry = segmentQueue[nextSegmentQueueIndex]
      nextSegmentQueueIndex += 1
      if (entry) await processSegment(entry.segment, entry.offset)
    }
  }
  try {
    await Promise.all(Array.from({ length: workerConcurrency }, () => worker()))
  } finally {
    batcher.dispose()
  }
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
  const failedConversationIds = [...new Set(failedBatches.map((offset) => directSegments[offset]?.id).filter((id): id is string => Boolean(id)))]
  // The people workflow has its own watermark. Only a conversation whose
  // every direct segment succeeded is eligible; a fallback card or a partial
  // segment must never make the next incremental run skip that conversation.
  const analyzedIds = [...segmentsByConversation.entries()]
    .filter(([conversationId, segments]) => successfulSegments.get(conversationId)?.size === segments.length)
    .flatMap(([conversationId]) => recordsByConversation.get(conversationId) ?? [])
    .map((record) => record.id)
  return { people, model, failedBatches, failedConversationIds, analyzedIds }
}

export async function fileToAttachment(file: File): Promise<AiAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return { name: file.name, mimeType: file.type || 'application/octet-stream', data: `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}` }
}

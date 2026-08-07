import type { IntelItem } from '../types'
import { localProxyUrl } from './apiUrl'
import { compactIntelItem, compactIntelItems, hydrateIntelItems } from './intelPersistence'
import { intelSignatures, planIntelDelta } from './intelDelta'

const DB_NAME = 'hyperion-data'
const STORE_NAME = 'snapshots'
const RECORD_STORE_NAME = 'intelRecords'
const META_STORE_NAME = 'intelMeta'
const INTEL_KEY = 'intel'
let localIntelWriteQueue: Promise<unknown> = Promise.resolve()
let sharedIntelWriteQueue: Promise<unknown> = Promise.resolve()
let localIntelIds: Set<string> | null = null
let localIntelSignatures = new Map<string, string>()
let sharedIntelSignatures: Map<string, string> | null = null
let sharedIntelSourceFingerprint: string | null | undefined

export interface SharedIntelMeta {
  updatedAt: string | null
  sourceFingerprint: string | null
  recordCount: number
}

export interface SharedIntelChanges extends SharedIntelMeta {
  requiresReload: boolean
  upserts: IntelItem[]
  deleteIds: string[]
}

interface SharedIntelSnapshot extends SharedIntelMeta {
  items: IntelItem[]
}

/**
 * Small, body-free conversation metadata used by archive lists. Message text
 * remains in the local archive until a user opens that one conversation.
 */
export interface ArchiveConversationPreview {
  id?: string
  content?: string
  summary?: string
  speaker?: string
  speakerRole?: IntelItem['speakerRole']
  messageType?: string
  capturedAt?: string
}

export interface ArchiveConversationSummary {
  id: string
  name: string
  kind: NonNullable<IntelItem['conversationKind']>
  source: IntelItem['source']
  recordCount: number
  firstAt?: string
  lastAt?: string
  latestPreview?: ArchiveConversationPreview
}

export interface ArchiveConversationIndexPage extends SharedIntelMeta {
  totalConversations: number
  items: ArchiveConversationSummary[]
  nextCursor: string | null
}

export interface ArchiveConversationRecordsPage extends SharedIntelMeta {
  conversation: ArchiveConversationSummary | null
  totalRecords: number
  items: IntelItem[]
  nextCursor: string | null
}

export interface LocalIntelSnapshot {
  updatedAt: string | null
  sourceFingerprint: string | null
  items: IntelItem[]
}

async function sharedIntelRequest<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  const response = await fetch(localProxyUrl(path), body === undefined ? { method, cache: 'no-store' } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const raw = await response.text()
  let payload: T & { error?: string }
  try { payload = JSON.parse(raw) as T & { error?: string } } catch { payload = {} as T & { error?: string } }
  if (!response.ok) {
    const error = new Error(payload.error || raw.slice(0, 400) || `原始聊天归档同步失败 (${response.status})`)
    Object.assign(error, {
      status: response.status,
      currentUpdatedAt: (payload as T & { currentUpdatedAt?: string | null }).currentUpdatedAt ?? null,
    })
    throw error
  }
  return payload
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME)
      if (!database.objectStoreNames.contains(RECORD_STORE_NAME)) database.createObjectStore(RECORD_STORE_NAME, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(META_STORE_NAME)) database.createObjectStore(META_STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadIntelSnapshot(): Promise<LocalIntelSnapshot | null> {
  if (typeof indexedDB === 'undefined') return null
  const database = await openDatabase()
  try {
    const stores = [...database.objectStoreNames]
    if (!stores.includes(RECORD_STORE_NAME) || !stores.includes(META_STORE_NAME)) return null
    const result = await new Promise<{ metadata: unknown; records: unknown[]; legacy: unknown }>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, RECORD_STORE_NAME, META_STORE_NAME], 'readonly')
      const metadataRequest = transaction.objectStore(META_STORE_NAME).get(INTEL_KEY)
      const recordsRequest = transaction.objectStore(RECORD_STORE_NAME).getAll()
      const legacyRequest = transaction.objectStore(STORE_NAME).get(INTEL_KEY)
      transaction.oncomplete = () => resolve({ metadata: metadataRequest.result, records: recordsRequest.result, legacy: legacyRequest.result })
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    let metadata = result.metadata as Partial<LocalIntelSnapshot> | undefined
    let items = Array.isArray(result.records) ? hydrateIntelItems(result.records) : []
    if (!items.length && result.legacy) {
      const legacy = Array.isArray(result.legacy)
        ? { updatedAt: null, sourceFingerprint: null, items: result.legacy }
        : result.legacy as Partial<LocalIntelSnapshot>
      if (Array.isArray(legacy.items)) {
        items = hydrateIntelItems(legacy.items)
        metadata = legacy
      }
    }
    if (!metadata && !items.length) return null
    localIntelIds = new Set(items.map((item) => item.id))
    localIntelSignatures = new Map(items.map((item) => [item.id, JSON.stringify(compactIntelItem(item))]))
    const snapshot = {
      updatedAt: typeof metadata?.updatedAt === 'string' ? metadata.updatedAt : null,
      sourceFingerprint: typeof metadata?.sourceFingerprint === 'string' ? metadata.sourceFingerprint : null,
      items,
    }
    // Upgrade the v1 single-object cache lazily after the first successful
    // read. Failure leaves the legacy object available for another attempt.
    if (!result.records.length && items.length) await writeIntelSnapshot(items, snapshot.sourceFingerprint ?? undefined, snapshot.updatedAt ?? undefined)
    return snapshot
  } finally {
    database.close()
  }
}

async function writeIntelSnapshot(items: IntelItem[], sourceFingerprint?: string, updatedAt?: string) {
  if (typeof indexedDB === 'undefined') return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const compacted = compactIntelItems(items)
      const desiredIds = new Set(compacted.map((item) => item.id))
      if (!localIntelIds) localIntelIds = new Set()
      const transaction = database.transaction([RECORD_STORE_NAME, META_STORE_NAME], 'readwrite')
      const records = transaction.objectStore(RECORD_STORE_NAME)
      for (const id of localIntelIds) if (!desiredIds.has(id)) records.delete(id)
      const nextSignatures = new Map<string, string>()
      for (const item of compacted) {
        const signature = JSON.stringify(item)
        nextSignatures.set(item.id, signature)
        if (localIntelSignatures.get(item.id) !== signature) records.put(item)
      }
      transaction.objectStore(META_STORE_NAME).put({
        id: INTEL_KEY,
        updatedAt: updatedAt || new Date().toISOString(),
        sourceFingerprint: sourceFingerprint || null,
        recordCount: compacted.length,
        schemaVersion: 2,
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      transaction.addEventListener('complete', () => {
        localIntelIds = desiredIds
        localIntelSignatures = nextSignatures
      }, { once: true })
    })
  } finally {
    database.close()
  }
}

export function saveIntelSnapshot(items: IntelItem[], sourceFingerprint?: string, updatedAt?: string) {
  // Analysis and directory imports can update the archive close together.
  // Serialize transactions so an older snapshot cannot finish after a newer one.
  const write = localIntelWriteQueue.then(() => writeIntelSnapshot(items, sourceFingerprint, updatedAt))
  localIntelWriteQueue = write.catch(() => undefined)
  return write
}

/** Reads only the shared archive header, never the potentially large message body. */
export async function loadSharedIntelMeta(): Promise<SharedIntelMeta> {
  const payload = await sharedIntelRequest<SharedIntelMeta>('/api/sync/intel/meta')
  return {
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
    recordCount: Math.max(0, Number(payload.recordCount) || 0),
  }
}

/**
 * Reads only append-only operations committed after a known archive version.
 * It is used for local producers such as Iris, where fetching the full chat
 * archive just to display one new journal entry would freeze the renderer.
 */
export async function loadSharedIntelChanges(since: string, limit = 2_000): Promise<SharedIntelChanges> {
  const payload = await sharedIntelRequest<Partial<SharedIntelChanges>>(
    archiveQuery('/api/sync/intel/changes', { since, limit }),
  )
  const upserts = Array.isArray(payload.upserts) ? hydrateIntelItems(payload.upserts) : []
  return {
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
    recordCount: Math.max(0, Number(payload.recordCount) || 0),
    requiresReload: payload.requiresReload === true,
    upserts,
    deleteIds: Array.isArray(payload.deleteIds)
      ? payload.deleteIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [],
  }
}

function archiveQuery(path: string, parameters: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined || value === '') continue
    query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}

/**
 * Reads a bounded page of archive conversation metadata. This deliberately
 * avoids the legacy full `/api/sync/intel` snapshot endpoint.
 */
export async function loadSharedIntelConversationIndex(options: { query?: string; cursor?: string; limit?: number } = {}): Promise<ArchiveConversationIndexPage> {
  const payload = await sharedIntelRequest<ArchiveConversationIndexPage>(archiveQuery('/api/sync/intel/conversations', options))
  return {
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
    recordCount: Math.max(0, Number(payload.recordCount) || 0),
    totalConversations: Math.max(0, Number(payload.totalConversations) || 0),
    items: Array.isArray(payload.items) ? payload.items.filter((item): item is ArchiveConversationSummary => Boolean(
      item
      && typeof item.id === 'string'
      && typeof item.name === 'string'
      && typeof item.source === 'string'
      && Number.isFinite(Number(item.recordCount)),
    )).map((item) => ({
      ...item,
      recordCount: Math.max(0, Math.floor(Number(item.recordCount))),
      kind: item.kind === 'direct' || item.kind === 'group' ? item.kind : 'unknown',
      latestPreview: item.latestPreview && typeof item.latestPreview === 'object' ? item.latestPreview : undefined,
    })) : [],
    nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null,
  }
}

/** Reads one chronological archive page for the chosen conversation only. */
export async function loadSharedIntelConversationPage(conversationId: string, options: { cursor?: string; limit?: number } = {}): Promise<ArchiveConversationRecordsPage> {
  const path = archiveQuery(`/api/sync/intel/conversations/${encodeURIComponent(conversationId)}`, options)
  const payload = await sharedIntelRequest<ArchiveConversationRecordsPage>(path)
  return {
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    sourceFingerprint: null,
    recordCount: 0,
    conversation: payload.conversation && typeof payload.conversation === 'object'
      ? { ...payload.conversation, recordCount: Math.max(0, Number(payload.conversation.recordCount) || 0) }
      : null,
    totalRecords: Math.max(0, Number(payload.totalRecords) || 0),
    items: Array.isArray(payload.items) ? hydrateIntelItems(payload.items) : [],
    nextCursor: typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null,
  }
}

/** Loads the local-proxy archive when this browser/desktop profile has no local copy. */
export async function loadSharedIntelSnapshot(): Promise<SharedIntelSnapshot> {
  const payload = await sharedIntelRequest<SharedIntelSnapshot>('/api/sync/intel')
  const items = Array.isArray(payload.items) ? hydrateIntelItems(payload.items) : []
  sharedIntelSignatures = intelSignatures(items)
  sharedIntelSourceFingerprint = typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null
  return {
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
    recordCount: Math.max(0, Number(payload.recordCount) || 0),
    items,
  }
}

/** Marks a local snapshot as an established shared baseline after metadata matched. */
export function primeSharedIntelSnapshot(items: IntelItem[], sourceFingerprint?: string | null) {
  sharedIntelSignatures = intelSignatures(items)
  sharedIntelSourceFingerprint = sourceFingerprint ?? null
}

/** Persists raw chat records only to the loopback HYPERION proxy, never an AI provider. */
export function saveSharedIntelSnapshot(items: IntelItem[], sourceFingerprint?: string, expectedUpdatedAt?: string | null | (() => string | null)): Promise<SharedIntelMeta> {
  // Two large POST bodies can finish uploading in the opposite order from
  // their UI changes. Serialize them before fetch so an older import cannot
  // arrive late and overwrite the newer archive.
  const write = sharedIntelWriteQueue.then(async () => {
    const expected = typeof expectedUpdatedAt === 'function' ? expectedUpdatedAt() : expectedUpdatedAt
    const compacted = compactIntelItems(items)
    const fingerprint = sourceFingerprint || null
    const plan = sharedIntelSignatures ? planIntelDelta(sharedIntelSignatures, compacted) : null
    const canUseDelta = Boolean(plan && expected !== undefined && plan.upserts.length + plan.deleteIds.length < Math.max(1, compacted.length * 0.75))
    if (plan && expected !== undefined && plan.upserts.length === 0 && plan.deleteIds.length === 0 && sharedIntelSourceFingerprint === fingerprint) {
      return { updatedAt: expected || null, sourceFingerprint: fingerprint, recordCount: compacted.length }
    }
    const payload = canUseDelta && plan
      ? await sharedIntelRequest<SharedIntelMeta>('/api/sync/intel/delta', 'POST', {
          upserts: plan.upserts,
          deleteIds: plan.deleteIds,
          sourceFingerprint: fingerprint,
          ...(expected !== undefined ? { expectedUpdatedAt: expected || null } : {}),
        })
      : await sharedIntelRequest<SharedIntelMeta>('/api/sync/intel', 'POST', {
          items: compacted,
          sourceFingerprint: fingerprint,
          ...(expected !== undefined ? { expectedUpdatedAt: expected || null } : {}),
        })
    sharedIntelSignatures = plan?.nextSignatures ?? intelSignatures(compacted)
    sharedIntelSourceFingerprint = fingerprint
    return {
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
      sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
      recordCount: Math.max(0, Number(payload.recordCount) || 0),
    }
  })
  sharedIntelWriteQueue = write.catch(() => undefined)
  return write
}

/**
 * Writes a small local producer change without requiring the renderer to hold
 * the complete chat archive. This is used for self-journal additions and
 * deletions while a large archive stays body-deferred.
 */
export function saveSharedIntelDelta(
  upserts: IntelItem[],
  deleteIds: string[],
  expectedUpdatedAt?: string | null | (() => string | null),
): Promise<SharedIntelMeta> {
  const write = sharedIntelWriteQueue.then(async () => {
    const expected = typeof expectedUpdatedAt === 'function' ? expectedUpdatedAt() : expectedUpdatedAt
    const compactedUpserts = compactIntelItems(upserts)
    const payload = await sharedIntelRequest<SharedIntelMeta>('/api/sync/intel/delta', 'POST', {
      upserts: compactedUpserts,
      deleteIds,
      ...(expected !== undefined ? { expectedUpdatedAt: expected || null } : {}),
    })
    if (sharedIntelSignatures) {
      for (const id of deleteIds) sharedIntelSignatures.delete(id)
      for (const item of compactedUpserts) sharedIntelSignatures.set(item.id, JSON.stringify(item))
    }
    return {
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
      sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
      recordCount: Math.max(0, Number(payload.recordCount) || 0),
    }
  })
  sharedIntelWriteQueue = write.catch(() => undefined)
  return write
}

import type { IntelItem } from '../types'
import { localProxyUrl } from './apiUrl'
import { compactIntelItems, hydrateIntelItems } from './intelPersistence'

const DB_NAME = 'theia-data'
const STORE_NAME = 'snapshots'
const INTEL_KEY = 'intel'
let localIntelWriteQueue: Promise<unknown> = Promise.resolve()
let sharedIntelWriteQueue: Promise<unknown> = Promise.resolve()

interface SharedIntelMeta {
  updatedAt: string | null
  sourceFingerprint: string | null
  recordCount: number
}

interface SharedIntelSnapshot extends SharedIntelMeta {
  items: IntelItem[]
}

export interface LocalIntelSnapshot {
  updatedAt: string | null
  sourceFingerprint: string | null
  items: IntelItem[]
}

async function sharedIntelRequest<T>(path: '/api/sync/intel' | '/api/sync/intel/meta', method: 'GET' | 'POST' = 'GET', body?: unknown) {
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
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadIntelSnapshot(): Promise<LocalIntelSnapshot | null> {
  if (typeof indexedDB === 'undefined') return null
  const database = await openDatabase()
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(INTEL_KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (Array.isArray(result)) return { updatedAt: null, sourceFingerprint: null, items: hydrateIntelItems(result) }
    if (!result || typeof result !== 'object' || !Array.isArray((result as LocalIntelSnapshot).items)) return null
    const snapshot = result as LocalIntelSnapshot
    return {
      updatedAt: typeof snapshot.updatedAt === 'string' ? snapshot.updatedAt : null,
      sourceFingerprint: typeof snapshot.sourceFingerprint === 'string' ? snapshot.sourceFingerprint : null,
      items: hydrateIntelItems(snapshot.items),
    }
  } finally {
    database.close()
  }
}

async function writeIntelSnapshot(items: IntelItem[], sourceFingerprint?: string, updatedAt?: string) {
  if (typeof indexedDB === 'undefined') return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put({
        updatedAt: updatedAt || new Date().toISOString(),
        sourceFingerprint: sourceFingerprint || null,
        items: compactIntelItems(items),
      } satisfies LocalIntelSnapshot, INTEL_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
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

/** Loads the local-proxy archive when this browser/desktop profile has no local copy. */
export async function loadSharedIntelSnapshot(): Promise<SharedIntelSnapshot> {
  const payload = await sharedIntelRequest<SharedIntelSnapshot>('/api/sync/intel')
  return {
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
    recordCount: Math.max(0, Number(payload.recordCount) || 0),
    items: Array.isArray(payload.items) ? hydrateIntelItems(payload.items) : [],
  }
}

/** Persists raw chat records only to the loopback THEIA proxy, never an AI provider. */
export function saveSharedIntelSnapshot(items: IntelItem[], sourceFingerprint?: string, expectedUpdatedAt?: string | null | (() => string | null)): Promise<SharedIntelMeta> {
  // Two large POST bodies can finish uploading in the opposite order from
  // their UI changes. Serialize them before fetch so an older import cannot
  // arrive late and overwrite the newer archive.
  const write = sharedIntelWriteQueue.then(async () => {
    const expected = typeof expectedUpdatedAt === 'function' ? expectedUpdatedAt() : expectedUpdatedAt
    const payload = await sharedIntelRequest<SharedIntelMeta>('/api/sync/intel', 'POST', {
      items: compactIntelItems(items),
      sourceFingerprint: sourceFingerprint || null,
      ...(expected !== undefined ? { expectedUpdatedAt: expected || null } : {}),
    })
    return {
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
      sourceFingerprint: typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null,
      recordCount: Math.max(0, Number(payload.recordCount) || 0),
    }
  })
  sharedIntelWriteQueue = write.catch(() => undefined)
  return write
}

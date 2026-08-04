import type { AppData } from '../types'
import { apiUrl } from './apiUrl'
import { toSharedData, type SharedData } from './sharedStateMerge'

export interface SharedSnapshot {
  updatedAt: string | null
  data: SharedData | null
}

export interface SharedMeta { updatedAt: string | null; archiveMessageCount: number }

export class SharedSnapshotConflictError extends Error {
  currentUpdatedAt: string | null

  constructor(message: string, currentUpdatedAt: string | null) {
    super(message)
    this.name = 'SharedSnapshotConflictError'
    this.currentUpdatedAt = currentUpdatedAt
  }
}

function localSyncUrl(path: '/api/sync/snapshot' | '/api/sync/meta') {
  const packagedUrl = apiUrl(path)
  if (packagedUrl !== path) return packagedUrl
  const { protocol, hostname } = window.location
  const isLocalPage = protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost')
  // Large snapshots bypass Vite's development proxy. The API only listens on
  // loopback and the server validates the page origin before sending a reply.
  return isLocalPage ? `${protocol}//${hostname}:8787${path}` : path
}

async function readResponse<T>(response: Response) {
  const raw = await response.text()
  let payload: T & { error?: string }
  try { payload = JSON.parse(raw) as T & { error?: string } } catch { payload = {} as T & { error?: string } }
  if (response.status === 409) {
    const conflict = payload as T & { error?: string; currentUpdatedAt?: string | null }
    throw new SharedSnapshotConflictError(conflict.error || '共享数据已被另一个窗口更新', conflict.currentUpdatedAt ?? null)
  }
  if (!response.ok) throw new Error(payload.error || raw.slice(0, 800) || `本机同步失败 (${response.status})`)
  return payload
}

async function request<T>(method: 'GET' | 'POST', body?: unknown) {
  const response = await fetch(localSyncUrl('/api/sync/snapshot'), body === undefined ? { method, cache: 'no-store' } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return readResponse<T>(response)
}

export function loadSharedSnapshot() {
  return request<SharedSnapshot>('GET').then((snapshot) => {
    if (!snapshot.data) return snapshot
    // Appearance, profile and AI preferences have their own INI-backed source of truth.
    return { ...snapshot, data: toSharedData(snapshot.data as AppData) }
  })
}

export function saveSharedSnapshot(data: AppData | SharedData, expectedUpdatedAt: string | null) {
  const shared = 'intel' in data ? toSharedData(data) : data
  return request<SharedSnapshot>('POST', { data: shared, expectedUpdatedAt })
}

export async function loadSharedMeta() {
  return readResponse<SharedMeta>(await fetch(localSyncUrl('/api/sync/meta'), { cache: 'no-store' }))
}

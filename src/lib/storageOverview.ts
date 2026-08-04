import { localProxyUrl } from './apiUrl'

export interface StorageOverviewEntry {
  id: string
  path: string
  description: string
  exists: boolean
  kind: 'file' | 'directory'
  sizeBytes?: number
  entryCount?: number
}

export interface StorageOverview {
  workspace: string
  entries: StorageOverviewEntry[]
}

export async function loadStorageOverview(signal?: AbortSignal): Promise<StorageOverview> {
  const response = await fetch(localProxyUrl('/api/storage/overview'), { signal })
  const payload = await response.json().catch(() => ({})) as StorageOverview & { error?: string }
  if (!response.ok) throw new Error(payload.error || '无法读取本机存储概览。')
  return payload
}

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
  health?: {
    sharedState: {
      schema: string
      schemaVersion: number
      migration: { state: 'pending' | 'ready' | 'failed'; migrated?: boolean; reason?: string; error?: string }
      rollbackBackups: string[]
    }
    archive: {
      schema: string
      schemaVersion: number
      storageEngine: string
      recordCount: number
      segmentCount: number
      updatedAt: string | null
      integrity?: {
        algorithm: 'sha256' | 'unknown'
        status: 'verified' | 'recovered-unindexed' | 'legacy-pending-migration' | 'empty' | 'unverified'
        unindexedSegmentCount: number
      }
      migration: { state: 'pending' | 'ready' | 'failed'; migrated?: boolean; error?: string }
    }
    recovery: {
      uncleanShutdownDetected: boolean
      previous?: { startedAt?: string } | null
      session?: { startedAt?: string } | null
    }
    rollbackCommand: string
  }
}

export async function loadStorageOverview(signal?: AbortSignal): Promise<StorageOverview> {
  const response = await fetch(localProxyUrl('/api/storage/overview'), { signal })
  const payload = await response.json().catch(() => ({})) as StorageOverview & { error?: string }
  if (!response.ok) throw new Error(payload.error || '无法读取本机存储概览。')
  return payload
}

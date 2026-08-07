import { localProxyUrl } from './apiUrl'

export interface MnemoSyncStatus {
  enabled: boolean
  mnemoRecordCount: number | null
  archiveRecordCount: number | null
  agent: {
    runtimeState?: string
    totalRecordCount?: number | null
    lastEvent?: string | null
    lastError?: string | null
    lastSyncAt?: string | null
  }
  reconciliation: {
    state?: string
    reason?: string | null
    expectedRecordCount?: number | null
    archiveRecordCount?: number | null
    startedAt?: string | null
    completedAt?: string | null
    lastError?: string | null
  }
}

async function request(path: string, method: 'GET' | 'POST' = 'GET') {
  const response = await fetch(localProxyUrl(path), { method, cache: 'no-store' })
  const payload = await response.json().catch(() => ({})) as MnemoSyncStatus & { error?: string }
  if (!response.ok) throw new Error(payload.error || `MNEMO 请求失败 (${response.status})`)
  return payload
}

export function loadMnemoSyncStatus() {
  return request('/api/mnemo/status')
}

export function requestMnemoFullImport() {
  return request('/api/mnemo/import', 'POST')
}

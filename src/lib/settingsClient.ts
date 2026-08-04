import type { AiSettings, AppearanceSettings, Profile } from '../types'
import type { AiStatus } from './aiClient'
import { localProxyUrl } from './apiUrl'

export interface SharedSettings {
  initialized: boolean
  profile: Profile
  appearance: AppearanceSettings
  aiSettings: AiSettings
  provider: AiStatus
}

export interface SharedSettingsInput {
  profile: Profile
  appearance: AppearanceSettings
  aiSettings: AiSettings
}

async function request<T>(method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const response = await fetch(localProxyUrl('/api/settings'), body === undefined ? { method } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  let payload: T & { error?: string }
  try { payload = JSON.parse(raw) as T & { error?: string } } catch { payload = {} as T & { error?: string } }
  if (!response.ok) throw new Error(payload.error || raw.slice(0, 400) || `通用设置请求失败 (${response.status})`)
  return payload
}

// A renderer can schedule several settings writes in one tick (appearance,
// provider preferences, and an extraction checkpoint are independent React
// effects). Keep the POSTs in order so a slower earlier request cannot finish
// after a newer edit and restore stale INI contents.
let settingsWriteQueue: Promise<unknown> = Promise.resolve()

export function loadSharedSettings() {
  return request<SharedSettings>('GET')
}

export function saveSharedSettings(settings: SharedSettingsInput) {
  const write = settingsWriteQueue.then(() => request<SharedSettings>('POST', settings))
  settingsWriteQueue = write.catch(() => undefined)
  return write
}

export function waitForSharedSettingsWrites() {
  return settingsWriteQueue
}

export async function uploadBackgroundAsset(file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < buffer.length; offset += chunkSize) binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize))
  const response = await fetch(localProxyUrl('/api/settings/background'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mimeType: file.type, data: `data:${file.type};base64,${btoa(binary)}` }),
  })
  const raw = await response.text()
  let payload: { url?: string; error?: string }
  try { payload = JSON.parse(raw) as { url?: string; error?: string } } catch { payload = {} }
  if (!response.ok || !payload.url) throw new Error(payload.error || raw.slice(0, 400) || `背景图片上传失败 (${response.status})`)
  return payload.url
}

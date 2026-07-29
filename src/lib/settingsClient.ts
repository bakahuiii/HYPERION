import type { AiSettings, AppearanceSettings, Profile } from '../types'
import type { AiStatus } from './aiClient'

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
  const response = await fetch('/api/settings', body === undefined ? { method } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(payload.error || `通用设置请求失败 (${response.status})`)
  return payload
}

export function loadSharedSettings() {
  return request<SharedSettings>('GET')
}

export function saveSharedSettings(settings: SharedSettingsInput) {
  return request<SharedSettings>('POST', settings)
}

export async function uploadBackgroundAsset(file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < buffer.length; offset += chunkSize) binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize))
  const response = await fetch('/api/settings/background', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mimeType: file.type, data: `data:${file.type};base64,${btoa(binary)}` }),
  })
  const payload = await response.json() as { url?: string; error?: string }
  if (!response.ok || !payload.url) throw new Error(payload.error || `背景图片上传失败 (${response.status})`)
  return payload.url
}

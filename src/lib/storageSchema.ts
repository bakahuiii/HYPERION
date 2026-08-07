export const APP_STORAGE_SCHEMA = 'hyperion-app-state'
export const APP_STORAGE_SCHEMA_VERSION = 1
const LEGACY_APP_STORAGE_SCHEMA = 'theia-app-state'

export interface AppStorageEnvelope<T = unknown> {
  schema: typeof APP_STORAGE_SCHEMA
  schemaVersion: number
  savedAt: string
  data: T
}
export interface UnwrappedAppStorage<T = unknown> {
  data: T
  schemaVersion: number
  migratedFrom?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Reads both the versioned envelope and the legacy plain AppData object.
 * Migration 0 -> 1 is intentionally lossless: schema v1 introduces the
 * envelope while the AppData normalizers remain the field-level migration.
 */
export function unwrapAppStorage<T = unknown>(value: unknown): UnwrappedAppStorage<T> {
  if (!isRecord(value) || (value.schema !== APP_STORAGE_SCHEMA && value.schema !== LEGACY_APP_STORAGE_SCHEMA)) {
    return { data: value as T, schemaVersion: APP_STORAGE_SCHEMA_VERSION, migratedFrom: 0 }
  }

  const schemaVersion = Number(value.schemaVersion)
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('本地数据 schema 版本无效')
  if (schemaVersion > APP_STORAGE_SCHEMA_VERSION) {
    throw new Error(`本地数据由更高版本的 HYPERION 创建（schema ${schemaVersion}），当前版本最高支持 ${APP_STORAGE_SCHEMA_VERSION}`)
  }
  if (!Object.hasOwn(value, 'data')) throw new Error('本地数据缺少 data 字段')
  return { data: value.data as T, schemaVersion, ...(value.schema === LEGACY_APP_STORAGE_SCHEMA ? { migratedFrom: schemaVersion } : {}) }
}

export function wrapAppStorage<T>(data: T, savedAt = new Date().toISOString()): AppStorageEnvelope<T> {
  return {
    schema: APP_STORAGE_SCHEMA,
    schemaVersion: APP_STORAGE_SCHEMA_VERSION,
    savedAt,
    data,
  }
}

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'

import { writeFileAtomically } from './atomicFile.mjs'

export const SHARED_STATE_SCHEMA = 'theia-shared-state/v1'
export const SHARED_STATE_SCHEMA_VERSION = 1

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
function validateSharedState(payload) {
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') throw new Error('共享状态格式无效')
  const version = payload.schema === SHARED_STATE_SCHEMA ? Number(payload.schemaVersion) : 0
  if (!Number.isInteger(version) || version < 0) throw new Error('共享状态 schema 版本无效')
  if (version > SHARED_STATE_SCHEMA_VERSION) {
    throw new Error(`共享状态由更高版本的 THEIA 创建（schema ${version}），当前版本最高支持 ${SHARED_STATE_SCHEMA_VERSION}`)
  }
  return version
}

export function versionSharedState(payload) {
  validateSharedState(payload)
  return { ...payload, schema: SHARED_STATE_SCHEMA, schemaVersion: SHARED_STATE_SCHEMA_VERSION }
}

export async function migrateSharedStateFile(path, backupDirectory) {
  let raw
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return { migrated: false, reason: 'missing' }
    throw error
  }
  const payload = JSON.parse(raw)
  const version = validateSharedState(payload)
  if (version === SHARED_STATE_SCHEMA_VERSION) return { migrated: false, reason: 'current' }

  await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
  const backupPath = resolve(backupDirectory, `shared-state-v${version}-${timestamp()}.json`)
  await writeFileAtomically(backupPath, raw, { encoding: 'utf8', mode: 0o600 })
  await writeFileAtomically(path, JSON.stringify(versionSharedState(payload)), { encoding: 'utf8', mode: 0o600 })
  return { migrated: true, fromVersion: version, toVersion: SHARED_STATE_SCHEMA_VERSION, backupPath }
}

export async function listSharedStateBackups(backupDirectory) {
  try {
    return (await readdir(backupDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^shared-state-v\d+-.*\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function restoreSharedStateBackup(path, backupDirectory, backupName) {
  const safeName = basename(String(backupName ?? ''))
  if (!safeName || safeName !== backupName || !/^shared-state-v\d+-.*\.json$/.test(safeName)) throw new Error('回滚备份名称无效')
  const directory = resolve(backupDirectory)
  const backupPath = resolve(directory, safeName)
  if (!backupPath.startsWith(`${directory}${sep}`)) throw new Error('回滚备份路径越界')
  const raw = await readFile(backupPath, 'utf8')
  validateSharedState(JSON.parse(raw))
  const safetyPath = resolve(directory, `pre-rollback-${timestamp()}.json`)
  try {
    await writeFileAtomically(safetyPath, await readFile(path), { mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await writeFileAtomically(path, raw, { encoding: 'utf8', mode: 0o600 })
  return { restored: true, backupPath, safetyPath }
}

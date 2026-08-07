import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { writeFileAtomically } from './atomicFile.mjs'

export const MNEMO_DELTA_SCHEMA = 'mnemo-delta/v1'

const batchDirectory = /^MNEMO-v1-/
const recordFileName = 'records.json'

function text(value, maximum) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, maximum) : ''
}

function iso(value) {
  const candidate = text(value, 80)
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return ''
  return new Date(candidate).toISOString()
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function normalizeRecord(value, accountId, sourceFile) {
  const input = object(value)
  if (!input) return null
  const id = text(input.id, 420)
  const content = text(input.content, 64 * 1024)
  const capturedAt = iso(input.capturedAt)
  const conversationId = text(input.conversationId, 420)
  const avatarId = text(input.avatarId, 64).toLowerCase()
  if (!id || !content || !capturedAt || !conversationId) return null
  const kind = ['direct', 'group', 'unknown'].includes(input.conversationKind) ? input.conversationKind : 'unknown'
  const speakerRole = ['self', 'other', 'unknown'].includes(input.speakerRole) ? input.speakerRole : 'unknown'
  const summary = text(input.summary, 1_200) || [text(input.speaker, 160), content].filter(Boolean).join(': ').slice(0, 1_200)
  const title = text(input.title, 160) || (summary.length > 22 ? `${summary.slice(0, 22)}...` : summary)
  return {
    id,
    title,
    summary,
    content,
    source: '微信导出',
    sourceFile: `mnemo://${accountId}/${sourceFile}`,
    conversationId,
    conversationName: text(input.conversationName, 240) || conversationId,
    conversationKind: kind,
    ...( /^[a-f0-9]{64}$/.test(avatarId) ? { avatarUrl: `/api/media/avatar/local?id=${avatarId}` } : {}),
    ...(text(input.speaker, 160) ? { speaker: text(input.speaker, 160) } : {}),
    ...(text(input.messageType, 80) ? { messageType: text(input.messageType, 80) } : {}),
    speakerRole,
    capturedAt,
    status: 'new',
  }
}

export function normalizeMnemoDocument(value, options = {}) {
  const input = object(value)
  const producer = object(input?.producer)
  const account = object(input?.account)
  const accountId = text(account?.id, 180)
  if (
    !input
    || input.schema !== MNEMO_DELTA_SCHEMA
    || producer?.name !== 'MNEMO'
    || producer?.layout !== 'immutable-delta-v1'
    || !text(producer?.version, 64)
    || !accountId
    || !Array.isArray(input.records)
    || input.records.length > 10_000
  ) return null
  const sourceFile = text(options.sourceFile, 700)
  const records = new Map()
  for (const candidate of input.records) {
    const record = normalizeRecord(candidate, accountId, sourceFile)
    if (record) records.set(record.id, record)
  }
  if (!records.size) return null
  return {
    accountId,
    generatedAt: iso(input.generatedAt),
    records: [...records.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id)),
  }
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback
}

function cleanState(value) {
  const files = object(value?.files) ?? {}
  const result = {}
  for (const [path, candidate] of Object.entries(files)) {
    const entry = object(candidate)
    if (!path || path.length > 700 || !entry || !/^[a-f0-9]{64}$/i.test(entry.hash)) continue
    result[path] = {
      hash: entry.hash.toLowerCase(),
      size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : 0,
      mtimeMs: Number.isFinite(Number(entry.mtimeMs)) ? Number(entry.mtimeMs) : 0,
      importedAt: iso(entry.importedAt) || new Date(0).toISOString(),
      recordCount: Math.max(0, Number(entry.recordCount) || 0),
    }
  }
  return { version: 1, files: result }
}

async function readState(path) {
  try {
    return cleanState(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return cleanState(null)
    throw error
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFileAtomically(path, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
}

function sourcePath(root, candidate) {
  const path = relative(root, candidate).replace(/\\/g, '/')
  if (!path || path.startsWith('../') || path.includes('/../')) throw new Error('MNEMO inbox file is outside the configured directory')
  return path
}

async function batches(root, maximum) {
  const entries = await readdir(root, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !batchDirectory.test(entry.name)) continue
    const path = resolve(root, entry.name, recordFileName)
    if (!path.startsWith(`${root}${sep}`)) continue
    try {
      const details = await lstat(path)
      if (details.isFile() && !details.isSymbolicLink()) result.push({ path, details })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path)).slice(0, maximum)
}

/** Reads complete immutable MNEMO batches and supplies normalized archive records. */
export function createMnemoInboxWatcher(options) {
  const root = resolve(String(options?.directory || ''))
  const statePath = resolve(String(options?.statePath || ''))
  const onImport = options?.onImport
  if (!options?.directory || !options?.statePath || typeof onImport !== 'function') throw new Error('MNEMO inbox watcher requires directory, statePath, and onImport')

  const intervalMs = bounded(options.intervalMs, 5_000, 1_000, 15 * 60_000)
  const settleMs = bounded(options.settleMs, 1_000, 250, 60_000)
  const maximumFileBytes = bounded(options.maximumFileBytes, 32 * 1024 * 1024, 1_024, 128 * 1024 * 1024)
  const maximumBatches = bounded(options.maximumBatches, 20_000, 1, 100_000)
  const logger = typeof options.logger === 'function' ? options.logger : () => undefined
  let timer = null
  let state = null
  let scanPromise = null
  let status = {
    enabled: true,
    directory: root,
    intervalMs,
    pendingFiles: 0,
    processedFiles: 0,
    importedRecords: 0,
    lastScanAt: null,
    lastSuccessAt: null,
    lastError: null,
  }

  async function scan() {
    if (scanPromise) return scanPromise
    scanPromise = (async () => {
      try {
        if (!(await stat(root)).isDirectory()) throw new Error('THEIA MNEMO inbox is not a directory')
        if (!state) state = await readState(statePath)
        const now = Date.now()
        let pendingFiles = 0
        let processedFiles = 0
        let importedRecords = 0
        for (const candidate of await batches(root, maximumBatches)) {
          const relativePath = sourcePath(root, candidate.path)
          const previous = state.files[relativePath]
          const fingerprint = `${candidate.details.size}:${Math.floor(candidate.details.mtimeMs)}`
          if (previous && `${previous.size}:${Math.floor(previous.mtimeMs)}` === fingerprint) continue
          if (candidate.details.size > maximumFileBytes || now - candidate.details.mtimeMs < settleMs) {
            pendingFiles += 1
            continue
          }
          const raw = await readFile(candidate.path)
          const afterRead = await lstat(candidate.path)
          if (!afterRead.isFile() || afterRead.isSymbolicLink() || afterRead.size !== candidate.details.size || Math.floor(afterRead.mtimeMs) !== Math.floor(candidate.details.mtimeMs)) {
            pendingFiles += 1
            continue
          }
          const hash = createHash('sha256').update(raw).digest('hex')
          if (previous?.hash === hash) {
            state.files[relativePath] = { ...previous, size: afterRead.size, mtimeMs: afterRead.mtimeMs }
            await writeState(statePath, state)
            continue
          }
          let document
          try { document = JSON.parse(raw.toString('utf8')) } catch { pendingFiles += 1; continue }
          const normalized = normalizeMnemoDocument(document, { sourceFile: relativePath })
          if (!normalized) {
            logger('warn', `ignored invalid MNEMO batch: ${relativePath}`)
            state.files[relativePath] = { hash, size: afterRead.size, mtimeMs: afterRead.mtimeMs, importedAt: new Date().toISOString(), recordCount: 0 }
            await writeState(statePath, state)
            continue
          }
          const outcome = await onImport(normalized.records, {
            accountId: normalized.accountId,
            sourceFile: relativePath,
            generatedAt: normalized.generatedAt,
          })
          state.files[relativePath] = { hash, size: afterRead.size, mtimeMs: afterRead.mtimeMs, importedAt: new Date().toISOString(), recordCount: normalized.records.length }
          await writeState(statePath, state)
          processedFiles += 1
          importedRecords += Number(outcome?.importedRecords) || normalized.records.length
          logger('info', `imported MNEMO batch ${relativePath}: ${normalized.records.length} records`)
        }
        status = {
          ...status,
          pendingFiles,
          processedFiles,
          importedRecords,
          lastScanAt: new Date().toISOString(),
          ...(processedFiles ? { lastSuccessAt: new Date().toISOString() } : {}),
          lastError: null,
        }
      } catch (error) {
        status = { ...status, lastScanAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) }
        logger('warn', `MNEMO inbox scan failed: ${status.lastError}`)
      } finally {
        scanPromise = null
      }
      return status
    })()
    return scanPromise
  }

  return {
    async start() {
      await scan()
      if (!timer) {
        timer = setInterval(() => { void scan() }, intervalMs)
        timer.unref?.()
      }
      return status
    },
    stop() { if (timer) clearInterval(timer); timer = null },
    scan,
    status: () => ({ ...status }),
  }
}

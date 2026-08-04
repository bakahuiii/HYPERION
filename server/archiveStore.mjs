import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

import { writeFileAtomically } from './atomicFile.mjs'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export const ARCHIVE_STORE_SCHEMA = 'theia-intel-archive/v1'
const SEGMENT_SUFFIX = '.jsonl.gz'
const DEFAULT_COMPACTION_SEGMENTS = 24

function monotonicTimestamp(previous) {
  const previousTime = typeof previous === 'string' ? Date.parse(previous) : Number.NaN
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString()
}

function compactItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null
  if (typeof item.content !== 'string' || !item.content.trim()) return item
  if (!Object.hasOwn(item, 'title') && !Object.hasOwn(item, 'summary')) return item
  const stored = { ...item }
  delete stored.title
  delete stored.summary
  return stored
}

function archivePayload(value) {
  if (Array.isArray(value)) return { updatedAt: null, sourceFingerprint: null, items: value }
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null
  return {
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    sourceFingerprint: typeof value.sourceFingerprint === 'string' ? value.sourceFingerprint : null,
    items: value.items,
  }
}

function segmentNumber(name) {
  const match = name.match(/^(\d+)-/)
  return match ? Number(match[1]) : 0
}

function segmentName(sequence, updatedAt) {
  return `${String(sequence).padStart(10, '0')}-${updatedAt.replace(/\D/g, '').slice(0, 17)}${SEGMENT_SUFFIX}`
}

async function readLegacyArchive(compressedPath, jsonPath) {
  try {
    const compressed = await readFile(compressedPath)
    try {
      return archivePayload(JSON.parse((await gunzipAsync(compressed)).toString('utf8')))
    } catch (error) {
      throw new Error(`本机原始聊天归档已损坏，无法解压或解析：${error instanceof Error ? error.message : String(error)}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    return archivePayload(JSON.parse(await readFile(jsonPath, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`本机原始聊天归档已损坏，无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readSegment(path) {
  let raw
  try {
    raw = (await gunzipAsync(await readFile(path))).toString('utf8')
  } catch (error) {
    throw new Error(`原始聊天归档已损坏：分段 ${basename(path)} 无法解压（${error instanceof Error ? error.message : String(error)}）`)
  }
  const lines = raw.split('\n').filter(Boolean)
  let header
  try { header = JSON.parse(lines.shift() ?? '{}') } catch { header = null }
  if (!header || header.schema !== ARCHIVE_STORE_SCHEMA || !['snapshot', 'delta'].includes(header.kind)) {
    throw new Error(`原始聊天归档已损坏：分段 ${basename(path)} 的 schema 无效`)
  }
  const operations = []
  for (const [index, line] of lines.entries()) {
    try {
      operations.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`原始聊天归档已损坏：分段 ${basename(path)} 第 ${index + 2} 行无法解析（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return { header, operations }
}

function applySegment(state, segment) {
  if (segment.header.kind === 'snapshot') state.items.clear()
  for (const operation of segment.operations) {
    if (operation?.op === 'delete' && typeof operation.id === 'string') state.items.delete(operation.id)
    if (operation?.op === 'upsert') {
      const item = compactItem(operation.item)
      if (item) state.items.set(item.id, item)
    }
  }
  state.updatedAt = typeof segment.header.updatedAt === 'string' ? segment.header.updatedAt : state.updatedAt
  state.sourceFingerprint = typeof segment.header.sourceFingerprint === 'string' ? segment.header.sourceFingerprint : null
}

async function writeSegment(directory, sequence, header, operations) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lines = [JSON.stringify({ schema: ARCHIVE_STORE_SCHEMA, schemaVersion: 1, ...header }), ...operations.map((operation) => JSON.stringify(operation))]
  const bytes = await gzipAsync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), { level: 6 })
  const name = segmentName(sequence, header.updatedAt)
  await writeFileAtomically(resolve(directory, name), bytes, { mode: 0o600 })
  return name
}

export function createAppendOnlyArchiveStore({ directory, metadataPath, legacyCompressedPath, legacyJsonPath, compactionSegments = DEFAULT_COMPACTION_SEGMENTS }) {
  let state = null
  let knownSegments = []
  let sequence = 0
  let loadedFromLegacy = false

  async function listSegments() {
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(SEGMENT_SUFFIX))
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async function reload(force = false) {
    const names = await listSegments()
    if (!force && state && names.length === knownSegments.length && names.every((name, index) => name === knownSegments[index])) return state
    const next = { updatedAt: null, sourceFingerprint: null, items: new Map() }
    if (names.length) {
      for (const name of names) applySegment(next, await readSegment(resolve(directory, name)))
      loadedFromLegacy = false
    } else {
      const legacy = await readLegacyArchive(legacyCompressedPath, legacyJsonPath)
      if (legacy) {
        next.updatedAt = legacy.updatedAt
        next.sourceFingerprint = legacy.sourceFingerprint
        for (const value of legacy.items) {
          const item = compactItem(value)
          if (item) next.items.set(item.id, item)
        }
        loadedFromLegacy = true
      }
    }
    state = next
    knownSegments = names
    sequence = names.reduce((maximum, name) => Math.max(maximum, segmentNumber(name)), 0)
    return state
  }

  async function writeMetadata() {
    await writeFileAtomically(metadataPath, JSON.stringify({
      schema: ARCHIVE_STORE_SCHEMA,
      schemaVersion: 1,
      storageEngine: 'append-only-jsonl-gzip',
      updatedAt: state.updatedAt,
      sourceFingerprint: state.sourceFingerprint,
      recordCount: state.items.size,
      segmentCount: knownSegments.length,
      rollbackSource: loadedFromLegacy ? legacyCompressedPath : undefined,
    }), { encoding: 'utf8', mode: 0o600 })
  }

  async function migrate() {
    await reload(true)
    if (!loadedFromLegacy) return false
    const updatedAt = monotonicTimestamp(state.updatedAt)
    sequence += 1
    const operations = [...state.items.values()].map((item) => ({ op: 'upsert', item }))
    const name = await writeSegment(directory, sequence, { kind: 'snapshot', updatedAt, sourceFingerprint: state.sourceFingerprint }, operations)
    knownSegments = [name]
    state.updatedAt = updatedAt
    loadedFromLegacy = false
    await writeMetadata()
    return true
  }

  async function compact() {
    await reload(true)
    if (knownSegments.length <= 1) return false
    const oldSegments = [...knownSegments]
    const updatedAt = monotonicTimestamp(state.updatedAt)
    sequence += 1
    const operations = [...state.items.values()].map((item) => ({ op: 'upsert', item }))
    const name = await writeSegment(directory, sequence, { kind: 'snapshot', updatedAt, sourceFingerprint: state.sourceFingerprint }, operations)
    knownSegments = [...oldSegments, name]
    state.updatedAt = updatedAt
    await writeMetadata()
    for (const oldName of oldSegments) await unlink(resolve(directory, oldName)).catch((error) => { if (error?.code !== 'ENOENT') throw error })
    knownSegments = [name]
    await writeMetadata()
    return true
  }

  async function commit(payload) {
    await reload(true)
    const values = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : null
    if (!values) throw new Error('原始聊天归档格式无效')
    if (Object.hasOwn(payload ?? {}, 'expectedUpdatedAt')) {
      const expected = typeof payload.expectedUpdatedAt === 'string' ? payload.expectedUpdatedAt : null
      if (expected !== state.updatedAt) {
        const conflict = new Error('本机原始聊天归档已被另一个窗口更新，请合并后重试')
        conflict.statusCode = 409
        conflict.currentUpdatedAt = state.updatedAt
        throw conflict
      }
    }

    const next = new Map()
    for (const value of values) {
      const item = compactItem(value)
      if (item) next.set(item.id, item)
    }
    const operations = []
    const writeSnapshot = loadedFromLegacy || knownSegments.length === 0
    if (writeSnapshot) {
      for (const item of next.values()) operations.push({ op: 'upsert', item })
    } else {
      for (const id of state.items.keys()) if (!next.has(id)) operations.push({ op: 'delete', id })
      for (const [id, item] of next) {
        const current = state.items.get(id)
        if (!current || JSON.stringify(current) !== JSON.stringify(item)) operations.push({ op: 'upsert', item })
      }
    }

    const updatedAt = monotonicTimestamp(state.updatedAt)
    const sourceFingerprint = typeof payload?.sourceFingerprint === 'string' ? payload.sourceFingerprint : null
    sequence += 1
    const name = await writeSegment(directory, sequence, { kind: writeSnapshot ? 'snapshot' : 'delta', updatedAt, sourceFingerprint }, operations)
    knownSegments.push(name)
    state = { updatedAt, sourceFingerprint, items: next }
    loadedFromLegacy = false
    await writeMetadata()
    if (knownSegments.length >= Math.max(2, Math.floor(compactionSegments))) await compact()
    return { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size }
  }

  async function commitDelta(payload) {
    await reload(true)
    const upserts = Array.isArray(payload?.upserts) ? payload.upserts : null
    const deleteIds = Array.isArray(payload?.deleteIds) ? payload.deleteIds : null
    if (!upserts || !deleteIds) throw new Error('原始聊天归档增量格式无效')
    if (Object.hasOwn(payload ?? {}, 'expectedUpdatedAt')) {
      const expected = typeof payload.expectedUpdatedAt === 'string' ? payload.expectedUpdatedAt : null
      if (expected !== state.updatedAt) {
        const conflict = new Error('本机原始聊天归档已被另一个窗口更新，请合并后重试')
        conflict.statusCode = 409
        conflict.currentUpdatedAt = state.updatedAt
        throw conflict
      }
    }

    const next = new Map(state.items)
    for (const id of deleteIds) if (typeof id === 'string') next.delete(id)
    for (const value of upserts) {
      const item = compactItem(value)
      if (item) next.set(item.id, item)
    }

    const writeSnapshot = loadedFromLegacy || knownSegments.length === 0
    const operations = writeSnapshot
      ? [...next.values()].map((item) => ({ op: 'upsert', item }))
      : [
          ...deleteIds.filter((id) => typeof id === 'string').map((id) => ({ op: 'delete', id })),
          ...upserts.map(compactItem).filter(Boolean).map((item) => ({ op: 'upsert', item })),
        ]
    const updatedAt = monotonicTimestamp(state.updatedAt)
    const sourceFingerprint = Object.hasOwn(payload ?? {}, 'sourceFingerprint')
      ? (typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null)
      : state.sourceFingerprint
    sequence += 1
    const name = await writeSegment(directory, sequence, { kind: writeSnapshot ? 'snapshot' : 'delta', updatedAt, sourceFingerprint }, operations)
    knownSegments.push(name)
    state = { updatedAt, sourceFingerprint, items: next }
    loadedFromLegacy = false
    await writeMetadata()
    if (knownSegments.length >= Math.max(2, Math.floor(compactionSegments))) await compact()
    return { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size }
  }

  async function loadSnapshot() {
    await reload()
    return { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, items: [...state.items.values()] }
  }

  async function loadMeta() {
    await reload()
    return { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, schemaVersion: 1, storageEngine: 'append-only-jsonl-gzip', segmentCount: knownSegments.length }
  }

  return { commit, commitDelta, compact, loadMeta, loadSnapshot, migrate }
}

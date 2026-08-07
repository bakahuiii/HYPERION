import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

import { writeFileAtomically } from './atomicFile.mjs'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export const ARCHIVE_STORE_SCHEMA = 'hyperion-intel-archive/v1'
const LEGACY_ARCHIVE_STORE_SCHEMA = 'theia-intel-archive/v1'
const SEGMENT_SUFFIX = '.jsonl.gz'
const DEFAULT_COMPACTION_SEGMENTS = 24
const ARCHIVE_METADATA_VERSION = 3
const STATE_IDLE_EVICTION_MS = 30_000

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validChecksum(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null
}

function segmentInfo(name, checksum, header, operationCount, byteLength) {
  return {
    name,
    checksum,
    kind: header.kind,
    updatedAt: header.updatedAt,
    operationCount,
    byteLength,
  }
}

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

function isMnemoRecord(item) {
  return (typeof item?.id === 'string' && item.id.startsWith('mnemo:'))
    || (typeof item?.sourceFile === 'string' && item.sourceFile.startsWith('mnemo://'))
}

function countMnemoRecords(items) {
  let count = 0
  for (const item of items) if (isMnemoRecord(item)) count += 1
  return count
}

function archiveItemsEqual(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const skipSourceFile = isMnemoRecord(left) && isMnemoRecord(right)
  const leftKeys = Object.keys(left).filter((key) => !skipSourceFile || key !== 'sourceFile')
  const rightKeys = Object.keys(right).filter((key) => !skipSourceFile || key !== 'sourceFile')
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue === rightValue) continue
    if (!leftValue || !rightValue || typeof leftValue !== 'object' || typeof rightValue !== 'object') return false
    if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) return false
  }
  return true
}

// A connected chat-export directory is authoritative only for that directory.
// It must never erase notes created by HYPERION or Iris while a large archive body
// is deferred in the renderer. Explicit delta deletes remain the supported
// deletion path for these records.
function isLocalManualRecord(item) {
  return typeof item?.sourceFile === 'string' && item.sourceFile.startsWith('hyperion://')
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

async function readSegment(path, expectedChecksum = null) {
  let bytes
  let raw
  try {
    bytes = await readFile(path)
    const checksum = sha256(bytes)
    if (expectedChecksum && checksum !== expectedChecksum) {
      throw new Error(`校验和不匹配（预期 ${expectedChecksum.slice(0, 12)}，实际 ${checksum.slice(0, 12)}）`)
    }
    raw = (await gunzipAsync(bytes)).toString('utf8')
  } catch (error) {
    throw new Error(`原始聊天归档已损坏：分段 ${basename(path)} 无法解压（${error instanceof Error ? error.message : String(error)}）`)
  }
  const lines = raw.split('\n').filter(Boolean)
  let header
  try { header = JSON.parse(lines.shift() ?? '{}') } catch { header = null }
  if (!header || ![ARCHIVE_STORE_SCHEMA, LEGACY_ARCHIVE_STORE_SCHEMA].includes(header.schema) || !['snapshot', 'delta'].includes(header.kind)) {
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
  return {
    header,
    operations,
    checksum: sha256(bytes),
    byteLength: bytes.length,
  }
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
  return segmentInfo(name, sha256(bytes), header, operations.length, bytes.length)
}

async function readArchiveMetadata(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value && typeof value === 'object' && value.schema === ARCHIVE_STORE_SCHEMA ? value : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    // Metadata is a cache for integrity and diagnostics. The append-only
    // segments remain authoritative and can rebuild it after a failed write.
    return null
  }
}

function metadataSegments(value) {
  if (!Array.isArray(value?.segments)) return new Map()
  return new Map(value.segments
    .filter((entry) => entry && typeof entry.name === 'string' && validChecksum(entry.checksum))
    .map((entry) => [entry.name, entry]))
}

function metadataConversationIndex(value) {
  if (!Array.isArray(value?.conversationIndex)) return null
  const entries = value.conversationIndex
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.source === 'string')
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind === 'direct' || entry.kind === 'group' ? entry.kind : 'unknown',
      source: entry.source,
      recordCount: Math.max(0, Math.floor(Number(entry.recordCount) || 0)),
      ...(typeof entry.firstAt === 'string' ? { firstAt: entry.firstAt } : {}),
      ...(typeof entry.lastAt === 'string' ? { lastAt: entry.lastAt } : {}),
      ...(entry.latestPreview && typeof entry.latestPreview === 'object' ? { latestPreview: entry.latestPreview } : {}),
    }))
  return entries.length || value.conversationIndex.length === 0 ? entries : null
}

function sameNames(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

function recordTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

function archiveConversationKey(item) {
  if (typeof item?.conversationId === 'string' && item.conversationId.trim()) return item.conversationId.trim()
  const source = typeof item?.source === 'string' && item.source.trim() ? item.source.trim() : 'unknown'
  const month = typeof item?.capturedAt === 'string' ? item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] : null
  return `legacy:${source}:${month ?? 'undated'}`
}

function conversationPreview(item) {
  const body = typeof item?.content === 'string' && item.content.trim()
    ? item.content.trim()
    : typeof item?.summary === 'string' ? item.summary.trim() : ''
  return {
    ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    ...(body ? { content: body.slice(0, 420) } : {}),
    ...(typeof item?.speaker === 'string' && item.speaker.trim() ? { speaker: item.speaker.trim().slice(0, 160) } : {}),
    ...(typeof item?.speakerRole === 'string' ? { speakerRole: item.speakerRole } : {}),
    ...(typeof item?.messageType === 'string' && item.messageType.trim() ? { messageType: item.messageType.trim().slice(0, 80) } : {}),
    ...(typeof item?.capturedAt === 'string' && item.capturedAt ? { capturedAt: item.capturedAt } : {}),
  }
}

function previewIsLater(candidate, current) {
  if (!current) return true
  const candidateTime = recordTimestamp(candidate?.capturedAt)
  const currentTime = recordTimestamp(current?.capturedAt)
  if (Number.isFinite(candidateTime) && Number.isFinite(currentTime)) return candidateTime >= currentTime
  if (Number.isFinite(candidateTime)) return true
  if (Number.isFinite(currentTime)) return false
  return String(candidate?.id ?? '') >= String(current?.id ?? '')
}

function compareConversation(left, right) {
  const leftTime = recordTimestamp(left.lastAt)
  const rightTime = recordTimestamp(right.lastAt)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1
  return left.id.localeCompare(right.id, 'zh-CN')
}

function compareRecord(left, right) {
  const leftTime = recordTimestamp(left?.capturedAt)
  const rightTime = recordTimestamp(right?.capturedAt)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''), 'zh-CN')
}

function normalizedLimit(value, fallback = 120, maximum = 500) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) ? Math.max(1, Math.min(maximum, number)) : fallback
}

function decodePageCursor(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed : null
  } catch {
    return null
  }
}

function encodePageCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function createAppendOnlyArchiveStore({ directory, metadataPath, legacyCompressedPath, legacyJsonPath, compactionSegments = DEFAULT_COMPACTION_SEGMENTS }) {
  let state = null
  let knownSegments = []
  let knownSegmentInfo = new Map()
  let sequence = 0
  let loadedFromLegacy = false
  let integrity = { status: 'unverified', unindexedSegmentCount: 0 }
  let conversationIndex = null
  let stateEvictionTimer = null

  function retainState() {
    if (stateEvictionTimer) clearTimeout(stateEvictionTimer)
    stateEvictionTimer = null
  }

  function releaseStateWhenIdle() {
    retainState()
    if (!state) return
    stateEvictionTimer = setTimeout(() => {
      state = null
      knownSegments = []
      knownSegmentInfo = new Map()
      sequence = 0
      loadedFromLegacy = false
      integrity = { status: 'unverified', unindexedSegmentCount: 0 }
      conversationIndex = null
      stateEvictionTimer = null
    }, STATE_IDLE_EVICTION_MS)
    stateEvictionTimer.unref?.()
  }

  async function readCurrentMetadata() {
    const metadata = await readArchiveMetadata(metadataPath)
    if (!metadata || !Number.isFinite(Number(metadata.recordCount))) return null
    const names = await listSegments()
    const indexedNames = [...metadataSegments(metadata).keys()].sort()
    if (!sameNames(names, indexedNames)) return null
    if (metadata.integrity?.status !== 'verified') return null
    return metadata
  }

  function archiveMeta(metadata) {
    const mnemoCount = Number(metadata?.mnemoRecordCount)
    return {
      updatedAt: typeof metadata?.updatedAt === 'string' ? metadata.updatedAt : null,
      sourceFingerprint: typeof metadata?.sourceFingerprint === 'string' ? metadata.sourceFingerprint : null,
      recordCount: Math.max(0, Number(metadata?.recordCount) || 0),
      // Older archives did not index their MNEMO subset. Keep that state
      // explicit so startup never mistakes an unknown count for zero.
      mnemoRecordCount: Number.isInteger(mnemoCount) && mnemoCount >= 0 ? mnemoCount : null,
      schemaVersion: 1,
      metadataVersion: Number(metadata?.metadataVersion) || ARCHIVE_METADATA_VERSION,
      storageEngine: 'append-only-jsonl-gzip',
      segmentCount: Math.max(0, Number(metadata?.segmentCount) || 0),
      integrity: {
        algorithm: 'sha256',
        status: typeof metadata?.integrity?.status === 'string' ? metadata.integrity.status : integrity.status,
        unindexedSegmentCount: Math.max(0, Number(metadata?.integrity?.unindexedSegmentCount) || 0),
      },
    }
  }

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
    retainState()
    const names = await listSegments()
    if (!force && state && sameNames(names, knownSegments)) return state
    const next = { updatedAt: null, sourceFingerprint: null, items: new Map(), mnemoRecordCount: 0 }
    const nextSegmentInfo = new Map()
    const metadata = await readArchiveMetadata(metadataPath)
    const manifest = metadataSegments(metadata)
    let unindexedSegmentCount = 0
    if (names.length) {
      for (const name of names) {
        const expectedChecksum = validChecksum(manifest.get(name)?.checksum)
        const segment = await readSegment(resolve(directory, name), expectedChecksum)
        applySegment(next, segment)
        nextSegmentInfo.set(name, segmentInfo(name, segment.checksum, segment.header, segment.operations.length, segment.byteLength))
        if (!expectedChecksum) unindexedSegmentCount += 1
      }
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
    next.mnemoRecordCount = countMnemoRecords(next.items.values())
    state = next
    knownSegments = names
    knownSegmentInfo = nextSegmentInfo
    conversationIndex = null
    sequence = names.reduce((maximum, name) => Math.max(maximum, segmentNumber(name)), 0)
    integrity = names.length
      ? { status: unindexedSegmentCount ? 'recovered-unindexed' : 'verified', unindexedSegmentCount }
      : { status: loadedFromLegacy ? 'legacy-pending-migration' : 'empty', unindexedSegmentCount: 0 }
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
      mnemoRecordCount: state.mnemoRecordCount,
      segmentCount: knownSegments.length,
      metadataVersion: ARCHIVE_METADATA_VERSION,
      ...(conversationIndex ? { conversationIndex } : {}),
      segments: knownSegments.map((name) => knownSegmentInfo.get(name)).filter(Boolean),
      integrity: {
        algorithm: 'sha256',
        status: integrity.status,
        unindexedSegmentCount: integrity.unindexedSegmentCount,
      },
      rollbackSource: loadedFromLegacy ? legacyCompressedPath : undefined,
    }), { encoding: 'utf8', mode: 0o600 })
  }

  async function metadataNeedsMnemoCount() {
    const metadata = await readArchiveMetadata(metadataPath)
    const count = Number(metadata?.mnemoRecordCount)
    return !Number.isInteger(count) || count < 0
  }

  async function migrate() {
    // The old single-file archive is only relevant when no verified segmented
    // store exists. Checking a healthy archive must not expand every message
    // into memory on every HYPERION launch.
    if (!state && await readCurrentMetadata()) return false
    await reload()
    if (!loadedFromLegacy) {
      releaseStateWhenIdle()
      return false
    }
    const updatedAt = monotonicTimestamp(state.updatedAt)
    sequence += 1
    const operations = [...state.items.values()].map((item) => ({ op: 'upsert', item }))
    const info = await writeSegment(directory, sequence, { kind: 'snapshot', updatedAt, sourceFingerprint: state.sourceFingerprint }, operations)
    knownSegments = [info.name]
    knownSegmentInfo = new Map([[info.name, info]])
    state.updatedAt = updatedAt
    loadedFromLegacy = false
    integrity = { status: 'verified', unindexedSegmentCount: 0 }
    conversationIndex = null
    await writeMetadata()
    releaseStateWhenIdle()
    return true
  }

  async function compact() {
    await reload()
    if (knownSegments.length <= 1) {
      releaseStateWhenIdle()
      return false
    }
    const oldSegments = [...knownSegments]
    const updatedAt = monotonicTimestamp(state.updatedAt)
    sequence += 1
    const operations = [...state.items.values()].map((item) => ({ op: 'upsert', item }))
    const info = await writeSegment(directory, sequence, { kind: 'snapshot', updatedAt, sourceFingerprint: state.sourceFingerprint }, operations)
    knownSegments = [...oldSegments, info.name]
    knownSegmentInfo.set(info.name, info)
    state.updatedAt = updatedAt
    await writeMetadata()
    for (const oldName of oldSegments) await unlink(resolve(directory, oldName)).catch((error) => { if (error?.code !== 'ENOENT') throw error })
    knownSegments = [info.name]
    knownSegmentInfo = new Map([[info.name, info]])
    integrity = { status: 'verified', unindexedSegmentCount: 0 }
    conversationIndex = null
    await writeMetadata()
    releaseStateWhenIdle()
    return true
  }

  async function commit(payload) {
    await reload()
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
    for (const [id, item] of state.items) {
      if (isLocalManualRecord(item) && !next.has(id)) next.set(id, item)
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
    if (!operations.length && sourceFingerprint === state.sourceFingerprint) {
      if (await metadataNeedsMnemoCount()) await writeMetadata()
      releaseStateWhenIdle()
      return { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, mnemoRecordCount: state.mnemoRecordCount }
    }
    sequence += 1
    const info = await writeSegment(directory, sequence, { kind: writeSnapshot ? 'snapshot' : 'delta', updatedAt, sourceFingerprint }, operations)
    knownSegments.push(info.name)
    knownSegmentInfo.set(info.name, info)
    state = { updatedAt, sourceFingerprint, items: next, mnemoRecordCount: countMnemoRecords(next.values()) }
    loadedFromLegacy = false
    integrity = { status: 'verified', unindexedSegmentCount: 0 }
    conversationIndex = null
    await writeMetadata()
    // Replacing a large archive with a small one should reclaim its old
    // segments immediately; retaining a giant delete delta defeats removal.
    if (knownSegments.length >= Math.max(2, Math.floor(compactionSegments)) || operations.length >= Math.max(10_000, state.items.size)) await compact()
    const result = { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, mnemoRecordCount: state.mnemoRecordCount }
    releaseStateWhenIdle()
    return result
  }

  async function commitDelta(payload) {
    await reload()
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

    const requestedDeletes = [...new Set(deleteIds.filter((id) => typeof id === 'string'))]
    const requestedUpserts = new Map()
    for (const value of upserts) {
      const item = compactItem(value)
      if (item) requestedUpserts.set(item.id, item)
    }
    const next = new Map(state.items)
    const effectiveDeleteIds = requestedDeletes.filter((id) => !requestedUpserts.has(id) && next.delete(id))
    const effectiveUpserts = []
    for (const item of requestedUpserts.values()) {
      const current = next.get(item.id)
      if (!current || !archiveItemsEqual(current, item)) {
        next.set(item.id, item)
        effectiveUpserts.push(item)
      }
    }

    const writeSnapshot = loadedFromLegacy || knownSegments.length === 0
    const operations = writeSnapshot
      ? [...next.values()].map((item) => ({ op: 'upsert', item }))
      : [
          ...effectiveDeleteIds.map((id) => ({ op: 'delete', id })),
          ...effectiveUpserts.map((item) => ({ op: 'upsert', item })),
        ]
    const updatedAt = monotonicTimestamp(state.updatedAt)
    const sourceFingerprint = Object.hasOwn(payload ?? {}, 'sourceFingerprint')
      ? (typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null)
      : state.sourceFingerprint
    if (!operations.length && sourceFingerprint === state.sourceFingerprint) {
      if (await metadataNeedsMnemoCount()) await writeMetadata()
      releaseStateWhenIdle()
      return { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, mnemoRecordCount: state.mnemoRecordCount }
    }
    sequence += 1
    const info = await writeSegment(directory, sequence, { kind: writeSnapshot ? 'snapshot' : 'delta', updatedAt, sourceFingerprint }, operations)
    knownSegments.push(info.name)
    knownSegmentInfo.set(info.name, info)
    let mnemoRecordCount = state.mnemoRecordCount
    for (const id of effectiveDeleteIds) {
      if (isMnemoRecord(state.items.get(id))) mnemoRecordCount -= 1
    }
    for (const item of effectiveUpserts) {
      const previous = state.items.get(item.id)
      if (isMnemoRecord(previous)) mnemoRecordCount -= 1
      if (isMnemoRecord(item)) mnemoRecordCount += 1
    }
    state = { updatedAt, sourceFingerprint, items: next, mnemoRecordCount: Math.max(0, mnemoRecordCount) }
    loadedFromLegacy = false
    integrity = { status: 'verified', unindexedSegmentCount: 0 }
    conversationIndex = null
    await writeMetadata()
    if (knownSegments.length >= Math.max(2, Math.floor(compactionSegments))) await compact()
    const result = { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, mnemoRecordCount: state.mnemoRecordCount }
    releaseStateWhenIdle()
    return result
  }

  async function loadSnapshot() {
    await reload()
    const result = { updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, items: [...state.items.values()] }
    releaseStateWhenIdle()
    return result
  }

  /**
   * Return only operations written after a known archive watermark.  This is
   * intentionally derived from delta segments, so a renderer can pick up a
   * journal entry or SELENE import without downloading a million-row snapshot.
   * A snapshot/compaction boundary asks the caller to do a full refresh.
   */
  async function loadChanges({ since, limit = 2_000 } = {}) {
    await reload()
    try {
      const watermark = typeof since === 'string' && Number.isFinite(Date.parse(since)) ? since : null
      if (!watermark) return { requiresReload: true, updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, upserts: [], deleteIds: [] }
      const max = Math.max(1, Math.min(20_000, Math.floor(Number(limit) || 2_000)))
      const upserts = new Map()
      const deleteIds = new Set()
      for (const name of knownSegments) {
        const info = knownSegmentInfo.get(name)
        if (!info || !info.updatedAt || info.updatedAt <= watermark) continue
        if (info.kind === 'snapshot') {
          return { requiresReload: true, updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, upserts: [], deleteIds: [] }
        }
        const segment = await readSegment(resolve(directory, name), info.checksum)
        for (const operation of segment.operations) {
          if (operation?.op === 'delete' && typeof operation.id === 'string') {
            deleteIds.add(operation.id)
            upserts.delete(operation.id)
          } else if (operation?.op === 'upsert' && operation.item?.id) {
            upserts.set(operation.item.id, compactItem(operation.item))
            deleteIds.delete(operation.item.id)
          }
          if (upserts.size + deleteIds.size > max) {
            return { requiresReload: true, updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, upserts: [], deleteIds: [] }
          }
        }
      }
      return { requiresReload: false, updatedAt: state.updatedAt, sourceFingerprint: state.sourceFingerprint, recordCount: state.items.size, upserts: [...upserts.values()].filter(Boolean), deleteIds: [...deleteIds] }
    } finally {
      releaseStateWhenIdle()
    }
  }

  async function loadMeta() {
    // Startup needs only this compact header. Avoid expanding a multi-hundred
    // thousand record JSONL snapshot just to paint an archive badge.
    if (!state) {
      const metadata = await readCurrentMetadata()
      if (metadata) return archiveMeta(metadata)
    }
    await reload()
    const result = archiveMeta({
      updatedAt: state.updatedAt,
      sourceFingerprint: state.sourceFingerprint,
      recordCount: state.items.size,
      mnemoRecordCount: state.mnemoRecordCount,
      metadataVersion: ARCHIVE_METADATA_VERSION,
      segmentCount: knownSegments.length,
      integrity,
    })
    releaseStateWhenIdle()
    return result
  }

  function buildConversationIndex() {
    if (conversationIndex) return conversationIndex
    const grouped = new Map()
    for (const item of state.items.values()) {
      const id = archiveConversationKey(item)
      const current = grouped.get(id)
      const capturedAt = typeof item?.capturedAt === 'string' ? item.capturedAt : undefined
      if (current) {
        current.recordCount += 1
        if (!current.name && typeof item?.conversationName === 'string') current.name = item.conversationName
        if (!current.kind && typeof item?.conversationKind === 'string') current.kind = item.conversationKind
        if (!current.firstAt || (Number.isFinite(recordTimestamp(capturedAt)) && recordTimestamp(capturedAt) < recordTimestamp(current.firstAt))) current.firstAt = capturedAt
        if (!current.lastAt || (Number.isFinite(recordTimestamp(capturedAt)) && recordTimestamp(capturedAt) > recordTimestamp(current.lastAt))) current.lastAt = capturedAt
        const preview = conversationPreview(item)
        if (previewIsLater(preview, current.latestPreview)) current.latestPreview = preview
        if (item?.speakerRole === 'other' && previewIsLater(preview, current.latestCounterpartPreview)) current.latestCounterpartPreview = preview
        continue
      }
      const preview = conversationPreview(item)
      grouped.set(id, {
        id,
        name: typeof item?.conversationName === 'string' && item.conversationName.trim() ? item.conversationName.trim() : (typeof item?.source === 'string' ? item.source : '未命名会话'),
        kind: typeof item?.conversationKind === 'string' ? item.conversationKind : 'unknown',
        source: typeof item?.source === 'string' ? item.source : 'unknown',
        recordCount: 1,
        firstAt: capturedAt,
        lastAt: capturedAt,
        latestPreview: preview,
        ...(item?.speakerRole === 'other' ? { latestCounterpartPreview: preview } : {}),
      })
    }
    conversationIndex = [...grouped.values()].map(({ latestCounterpartPreview, ...entry }) => ({
      ...entry,
      latestPreview: latestCounterpartPreview ?? entry.latestPreview,
    })).sort(compareConversation)
    return conversationIndex
  }

  async function loadConversationIndex({ query, cursor, limit } = {}) {
    let metadata = null
    let cachedIndex = null
    if (!state) {
      metadata = await readCurrentMetadata()
      cachedIndex = metadataConversationIndex(metadata)
    }
    if (!cachedIndex) await reload()
    const normalizedQuery = typeof query === 'string' ? query.trim().toLocaleLowerCase('zh-CN') : ''
    const index = cachedIndex ?? buildConversationIndex()
    // Persist the compact directory after its first build. Later launches can
    // browse and search conversations without holding the complete archive.
    if (!cachedIndex) {
      try { await writeMetadata() } catch { /* The in-memory index remains usable for this request. */ }
    }
    const entries = normalizedQuery
      ? index.filter((entry) => `${entry.name}\u0000${entry.id}\u0000${entry.source}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
      : index
    const decodedCursor = decodePageCursor(cursor)
    const offset = decodedCursor
      ? Math.max(0, entries.findIndex((entry) => entry.id === decodedCursor.id && entry.lastAt === decodedCursor.lastAt) + 1)
      : 0
    const page = entries.slice(offset, offset + normalizedLimit(limit))
    const final = page.at(-1)
    const result = {
      updatedAt: cachedIndex ? archiveMeta(metadata).updatedAt : state.updatedAt,
      recordCount: cachedIndex ? archiveMeta(metadata).recordCount : state.items.size,
      totalConversations: entries.length,
      items: page,
      nextCursor: final && offset + page.length < entries.length ? encodePageCursor({ id: final.id, lastAt: final.lastAt ?? null }) : null,
    }
    if (!cachedIndex) releaseStateWhenIdle()
    return result
  }

  async function loadConversationPage(conversationId, { cursor, limit } = {}) {
    await reload()
    const id = typeof conversationId === 'string' ? conversationId.trim().slice(0, 600) : ''
    if (!id) throw new Error('会话标识无效')
    const records = [...state.items.values()].filter((item) => archiveConversationKey(item) === id).sort(compareRecord)
    const decodedCursor = decodePageCursor(cursor)
    const offset = decodedCursor
      ? Math.max(0, records.findIndex((item) => item.id === decodedCursor.id && item.capturedAt === decodedCursor.capturedAt) + 1)
      : 0
    const page = records.slice(offset, offset + normalizedLimit(limit, 200))
    const final = page.at(-1)
    const result = {
      updatedAt: state.updatedAt,
      conversation: buildConversationIndex().find((entry) => entry.id === id) ?? null,
      totalRecords: records.length,
      items: page,
      nextCursor: final && offset + page.length < records.length ? encodePageCursor({ id: final.id, capturedAt: final.capturedAt ?? null }) : null,
    }
    releaseStateWhenIdle()
    return result
  }

  async function verifyIntegrity() {
    await reload(true)
    const result = {
      recordCount: state.items.size,
      segmentCount: knownSegments.length,
      integrity: { ...integrity, algorithm: 'sha256' },
    }
    releaseStateWhenIdle()
    return result
  }

  return { commit, commitDelta, compact, loadMeta, loadSnapshot, loadChanges, loadConversationIndex, loadConversationPage, migrate, verifyIntegrity }
}

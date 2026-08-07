import http from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import {
  createProviderChannel,
  deleteProviderChannel,
  discoverModels,
  editableProviderConfig,
  editableProviderPoolConfig,
  loadProviderConfig,
  loadProviderConfigs,
  normalizeBaseUrl,
  resetProviderConfig,
  saveProviderConfig,
  updateProviderChannel,
} from './providerConfig.mjs'
import { backgroundAssetPath, loadSettings, saveAppSettings, saveBackgroundAsset, saveMapSettings } from './settings.mjs'
import { runtimePaths } from './runtimePaths.mjs'
import { rotateFileCopies } from './fileRotation.mjs'
import { withFileLock, writeFileAtomically } from './atomicFile.mjs'
import { createAppendOnlyArchiveStore } from './archiveStore.mjs'
import { listSharedStateBackups, migrateSharedStateFile, versionSharedState, SHARED_STATE_SCHEMA, SHARED_STATE_SCHEMA_VERSION } from './schemaMigrations.mjs'
import { pruneLogDirectory } from './logRetention.mjs'
import { finishRecoverySession, recordRuntimeFailure, startRecoverySession } from './crashRecovery.mjs'
import { createSeleneInboxWatcher, mergeContextEvents } from './seleneInbox.mjs'
import { createMnemoInboxWatcher } from './mnemoInbox.mjs'
import { createMnemoAgentController } from './mnemoAgent.mjs'
import { readMnemoAvatar } from './mnemoAvatarStore.mjs'

const port = Number(process.env.AI_PORT || 8787)
const maxBodyBytes = 256 * 1024 * 1024
const maxAttachments = 4
const maxAttachmentBytes = 8 * 1024 * 1024
const providerRequestTimeoutMs = Math.min(180_000, Math.max(15_000, Number(process.env.AI_PROVIDER_TIMEOUT_MS) || 90_000))
const fallbackQuotes = [
  { text: '向前走，哪怕只是很小的一步。', from: '离线句库' },
  { text: '把今天能做的事，留在今天完成。', from: '离线句库' },
  { text: '真正重要的事，值得慢慢弄清。', from: '离线句库' },
]

function hyperionEnvironment(name) {
  return process.env[`HYPERION_${name}`] ?? process.env[`THEIA_${name}`]
}

const {
  sharedStatePath,
  sharedIntelPath,
  sharedIntelStoreDirectoryPath,
  sharedIntelMetaPath,
  sharedIntelLegacyPath,
  seleneInboxStatePath,
  mnemoInboxDirectoryPath,
  mnemoInboxStatePath,
  mnemoExportDirectoryPath,
  aiDebugLogPath,
  taskLogDirectoryPath,
  crashLogPath,
  serviceSessionPath,
  avatarCacheDirectoryPath,
  mapTileCacheDirectoryPath,
  settingsPath,
  credentialStorePath,
  backgroundDirectoryPath,
  electronUserDataPath,
  legacyProviderPath,
  desktopPidPath,
  migrationDirectoryPath,
} = runtimePaths
const sharedIntelStore = createAppendOnlyArchiveStore({
  directory: sharedIntelStoreDirectoryPath,
  metadataPath: sharedIntelMetaPath,
  legacyCompressedPath: sharedIntelPath,
  legacyJsonPath: sharedIntelLegacyPath,
})
const gzipAsync = promisify(gzip)
let sharedStateWriteQueue = Promise.resolve()
let sharedIntelWriteQueue = Promise.resolve()
let aiDebugWriteQueue = Promise.resolve()
const activeTaskLogs = new Set()
let taskLogMaintenanceQueue = Promise.resolve()
let mapTileMaintenanceQueue = Promise.resolve()
let recoveryStatus = { uncleanShutdownDetected: false, previous: null, session: null }
let sharedStateMigrationStatus = { state: 'pending', migrated: false }
let archiveMigrationStatus = { state: 'pending', migrated: false }
const seleneInboxWatchers = new Map()
const mnemoInboxWatchers = new Map()
const mnemoAgent = createMnemoAgentController({
  workspace: runtimePaths.workspace,
  outboxDirectory: mnemoInboxDirectoryPath,
  archiveDirectory: mnemoExportDirectoryPath,
  avatarDirectory: avatarCacheDirectoryPath,
})
const aiDebugMaxBytes = 8 * 1024 * 1024
const aiDebugRotationCount = 3
const taskLogMaxFiles = 2_000
const taskLogMaxBytes = 512 * 1024 * 1024
const providerRuntimeById = new Map()
const providerOriginRuntimeByKey = new Map()
const providerCredentialProbeById = new Map()
// Multiple saved channels can point at the same relay. Keep a high safety
// ceiling for an origin, but do not reduce the normal configured pool: five
// channels with maxConcurrency=8 still expose all 40 slots. The limit only
// matters for unusually large pools or after adaptive failure reduction.
const sharedOriginConcurrencyDefault = Math.min(
  64,
  Math.max(1, Math.round(Number(process.env.AI_SHARED_ORIGIN_MAX_CONCURRENCY) || 64)),
)
// A relay can return a long Retry-After value (Cloudflare commonly returns
// 60 seconds for a 502), but a local extraction run must remain responsive.
// Keep the local backoff short and bounded; the original upstream value stays
// in the per-attempt diagnostic metadata for troubleshooting.
const providerCooldownBaseMs = 250
const providerCooldownMaxMs = 2_000
// `auto` mode learns a relay's working protocol for the lifetime of the
// local proxy. Some OpenAI-compatible relays expose `/responses` but return
// malformed Responses payloads for tool-capable models; retrying that same
// endpoint for every conversation only burns time and upstream quota.
const providerApiModeById = new Map()
const providerAcquisitionQueue = []
let providerDispatchScheduled = false
let providerDispatchInProgress = false
let providerDispatchRequested = false
let providerDispatchTimer = null
let providerDispatchTimerAt = 0
let providerSelectionSequence = 0
// The renderer cannot keep enough long HTTP requests open to fill a large
// provider pool. Sessions retain a local backlog so a finished provider slot
// can immediately receive another extraction job without waiting for a whole
// browser batch to finish.
const aiSessions = new Map()
const aiSessionTtlMs = 30 * 60 * 1000
const aiSessionMaxEnqueue = 40
const aiSessionResultPageSize = 120
const recoveryMonitorKey = Symbol.for('hyperion.runtimeRecoveryMonitor')

function installRuntimeFailureMonitor() {
  if (globalThis[recoveryMonitorKey]) return
  globalThis[recoveryMonitorKey] = true
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    void recordRuntimeFailure(crashLogPath, origin, error).catch(() => undefined)
  })
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomically(path, payload) {
  await writeFileAtomically(path, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
}

async function directoryFileSize(path, entries) {
  let total = 0
  const files = entries.filter((entry) => entry.isFile())
  for (let offset = 0; offset < files.length; offset += 128) {
    const sizes = await Promise.all(files.slice(offset, offset + 128).map(async (entry) => {
      try { return (await stat(resolve(path, entry.name))).size } catch { return 0 }
    }))
    total += sizes.reduce((sum, size) => sum + size, 0)
  }
  return total
}

async function storageEntry(id, path, description, includeDirectorySize = false) {
  try {
    const details = await stat(path)
    if (details.isDirectory()) {
      let entries
      try { entries = await readdir(path, { withFileTypes: true }) } catch { /* metadata is optional */ }
      const entryCount = entries?.length
      const sizeBytes = includeDirectorySize && entries ? await directoryFileSize(path, entries) : undefined
      return {
        id,
        path,
        description,
        exists: true,
        kind: 'directory',
        ...(Number.isFinite(entryCount) ? { entryCount } : {}),
        ...(Number.isFinite(sizeBytes) ? { sizeBytes } : {}),
      }
    }
    return { id, path, description, exists: true, kind: 'file', sizeBytes: details.size }
  } catch (error) {
    if (error?.code === 'ENOENT') return { id, path, description, exists: false, kind: 'file' }
    throw error
  }
}

async function storageOverview() {
  const [entries, migrationBackups, archiveMeta] = await Promise.all([
    Promise.all([
    storageEntry('shared-state', sharedStatePath, '任务、人物、地点、候选任务和界面状态的共享快照。'),
    storageEntry('shared-intel', sharedIntelStoreDirectoryPath, '原始聊天增量归档。使用带 schema 的 gzip JSONL 分段，避免每次修改都重写整个归档。', true),
    storageEntry('shared-intel-rollback', sharedIntelPath, '0.3.x gzip 归档回滚源；迁移完成后仍保留，供人工回滚。'),
    storageEntry('settings', settingsPath, '通用 INI：名称、外观、模型通道和提炼偏好。桌面版只保留凭据引用，不写入明文 API Key。'),
    storageEntry('credentials', credentialStorePath, '桌面版 API Key 的系统加密凭据 blob；由当前系统账户解密。'),
    storageEntry('backgrounds', backgroundDirectoryPath, '已上传的自定义背景图片。', true),
    storageEntry('debug-log', aiDebugLogPath, '模型请求调试日志，不含聊天正文、附件或密钥。'),
    storageEntry('task-logs', taskLogDirectoryPath, '按任务与时间戳分文件保存的完整本地模型输入、输出和失败信息，不含 API Key。', true),
    storageEntry('crash-log', crashLogPath, '非正常退出与运行时崩溃记录；最大 2MB，保留 2 份轮转副本。'),
    storageEntry('avatar-cache', avatarCacheDirectoryPath, '从导出记录的微信/QQ头像地址下载的本地缓存。', true),
    storageEntry('map-tile-cache', mapTileCacheDirectoryPath, '公共地图瓦片的有界本地缓存；容量由地图服务设置控制。', true),
    storageEntry('electron-user-data', electronUserDataPath, '桌面客户端的 Chromium 会话、缓存和窗口运行数据；退出客户端后仍会保留。'),
    storageEntry('desktop-pid', desktopPidPath, '桌面客户端运行标记；关闭客户端后会自动清除。'),
    storageEntry('migrations', migrationDirectoryPath, 'schema 升级前的只读回滚备份；可通过 npm run data:rollback 查看和恢复。', true),
    storageEntry('legacy-provider', legacyProviderPath, '旧版模型通道配置；若仍存在，仅用于一次性迁移。'),
    ]),
    listSharedStateBackups(migrationDirectoryPath),
    loadSharedIntelMeta().catch(() => null),
  ])
  return {
    workspace: runtimePaths.workspace,
    entries,
    health: {
      sharedState: {
        schema: SHARED_STATE_SCHEMA,
        schemaVersion: SHARED_STATE_SCHEMA_VERSION,
        migration: sharedStateMigrationStatus,
        rollbackBackups: migrationBackups,
      },
      archive: {
        schema: archiveMeta?.schema ?? 'hyperion-intel-archive/v1',
        schemaVersion: Number(archiveMeta?.schemaVersion) || 1,
        storageEngine: archiveMeta?.storageEngine ?? 'append-only-jsonl-gzip',
        recordCount: Number(archiveMeta?.recordCount) || 0,
        segmentCount: Number(archiveMeta?.segmentCount) || 0,
        updatedAt: archiveMeta?.updatedAt ?? null,
        integrity: archiveMeta?.integrity && typeof archiveMeta.integrity === 'object'
          ? {
              algorithm: archiveMeta.integrity.algorithm === 'sha256' ? 'sha256' : 'unknown',
              status: typeof archiveMeta.integrity.status === 'string' ? archiveMeta.integrity.status : 'unverified',
              unindexedSegmentCount: Math.max(0, Number(archiveMeta.integrity.unindexedSegmentCount) || 0),
            }
          : { algorithm: 'unknown', status: 'unverified', unindexedSegmentCount: 0 },
        migration: archiveMigrationStatus,
      },
      recovery: recoveryStatus,
      rollbackCommand: 'npm run data:rollback -- --latest',
    },
  }
}

async function rotateAiDebugLog(nextBytes) {
  let currentSize = 0
  try { currentSize = (await stat(aiDebugLogPath)).size } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (currentSize + nextBytes <= aiDebugMaxBytes) return
  await rotateFileCopies(aiDebugLogPath, aiDebugRotationCount)
}

function logAiDebug(event, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    event,
    ...details,
  }
  // This log intentionally excludes raw records, attachment bodies, API keys,
  // and request headers. It is for diagnosing the local pipeline only.
  const line = `${JSON.stringify(entry)}\n`
  console.info(`[HYPERION AI] ${line.trim()}`)
  const write = aiDebugWriteQueue.then(async () => {
    await mkdir(dirname(aiDebugLogPath), { recursive: true, mode: 0o700 })
    await rotateAiDebugLog(Buffer.byteLength(line, 'utf8'))
    await appendFile(aiDebugLogPath, line, 'utf8')
  })
  aiDebugWriteQueue = write.catch(() => undefined)
}

function taskLogTimestamp(date = new Date()) {
  const part = (value, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}-${part(date.getMilliseconds(), 3)}`
}

function taskLogIdentity(kind, payload) {
  const conversation = payload?.conversation ?? {}
  const label = conversation.name ?? payload?.person?.name ?? payload?.quest?.title ?? kind
  const safeLabel = cleanString(label, 72).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'local-task'
  const digest = createHash('sha256').update(JSON.stringify({ kind, label, at: Date.now(), random: Math.random() })).digest('hex').slice(0, 10)
  return `${taskLogTimestamp()}-${kind}-${safeLabel.slice(0, 40)}-${digest}.jsonl`
}

function taskLogPayload(value) {
  // Provider credentials are never part of normal analysis payloads, but the
  // sanitizer keeps a future caller from accidentally writing one to disk.
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(?:key|api[_-]?key|authorization|token)$/i.test(key)) return '[redacted]'
    if (typeof item === 'string' && item.startsWith('data:')) return `[attachment omitted: ${Buffer.byteLength(item, 'utf8')} bytes]`
    return item
  }))
}

async function startTaskLog(kind, payload) {
  try {
    await mkdir(taskLogDirectoryPath, { recursive: true, mode: 0o700 })
    const path = resolve(taskLogDirectoryPath, taskLogIdentity(kind, payload))
    const startedAt = new Date().toISOString()
    await writeFile(path, `${JSON.stringify({ schema: 'hyperion-task-log/v1', startedAt, kind, request: taskLogPayload(payload) })}\n`, { encoding: 'utf8', mode: 0o600 })
    activeTaskLogs.add(path)
    return { path, startedAt }
  } catch (error) {
    console.warn(`[HYPERION AI] Unable to start task log: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function compressTaskLog(path) {
  if (!path || !path.endsWith('.jsonl') || activeTaskLogs.has(path)) return
  const compressedPath = `${path}.gz`
  try {
    const source = await readFile(path)
    const compressed = await gzipAsync(source, { level: 6 })
    await writeFileAtomically(compressedPath, compressed, { mode: 0o600 })
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[HYPERION AI] Unable to compact task log: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function compactExistingTaskLogs() {
  try {
    const entries = await readdir(taskLogDirectoryPath, { withFileTypes: true })
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = resolve(taskLogDirectoryPath, entry.name)
      if (activeTaskLogs.has(path)) continue
      try {
        const details = await stat(path)
        if (details.mtimeMs > cutoff) continue
      } catch { continue }
      await compressTaskLog(path)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[HYPERION AI] Unable to compact task logs: ${error instanceof Error ? error.message : String(error)}`)
  }
  scheduleTaskLogMaintenance()
}

function scheduleTaskLogMaintenance() {
  const maintenance = taskLogMaintenanceQueue.then(() => pruneLogDirectory(taskLogDirectoryPath, {
    maxFiles: taskLogMaxFiles,
    maxBytes: taskLogMaxBytes,
    exclude: activeTaskLogs,
  }))
  taskLogMaintenanceQueue = maintenance.catch(() => undefined)
  return maintenance
}

async function finishTaskLog(log, event, details) {
  if (!log) return
  try {
    await appendFile(log.path, `${JSON.stringify({ at: new Date().toISOString(), event, ...taskLogPayload(details) })}\n`, { encoding: 'utf8', mode: 0o600 })
    activeTaskLogs.delete(log.path)
    // Finish the compaction before the request resolves. This keeps the
    // storage view and shutdown/cleanup deterministic while retaining the
    // compressed-at-rest format for completed logs.
    await compressTaskLog(log.path)
    scheduleTaskLogMaintenance()
  } catch (error) {
    activeTaskLogs.delete(log.path)
    console.warn(`[HYPERION AI] Unable to finish task log: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function segmentDebugFields(conversation) {
  const totalRecordCount = Number(conversation?.totalRecords)
  const segmentIndex = Number(conversation?.segmentIndex)
  const segmentCount = Number(conversation?.segmentCount)
  const coreRecordCount = Number(conversation?.coreRecordCount)
  const overlapRecordCount = Number(conversation?.overlapRecordCount)
  return {
    totalRecordCount: Number.isInteger(totalRecordCount) ? totalRecordCount : null,
    segmentIndex: Number.isInteger(segmentIndex) ? segmentIndex : null,
    segmentCount: Number.isInteger(segmentCount) ? segmentCount : null,
    coreRecordCount: Number.isInteger(coreRecordCount) ? coreRecordCount : null,
    overlapRecordCount: Number.isInteger(overlapRecordCount) ? overlapRecordCount : null,
    historical: conversation?.historical === true,
    recordFormat: cleanString(conversation?.recordFormat, 40) || null,
    analysisAsOf: cleanString(conversation?.analysisAsOf, 80) || null,
    timeZone: cleanString(conversation?.timeZone, 80) || null,
    utcOffsetMinutes: Number.isFinite(Number(conversation?.utcOffsetMinutes)) ? Number(conversation.utcOffsetMinutes) : null,
  }
}

function providerDebugFields(value) {
  const metadata = value?.metadata?.provider ?? value?.providerMetadata
  if (!metadata) return {}
  const attempts = Array.isArray(metadata.attempts) ? metadata.attempts : []
  const lastAttempt = attempts.at(-1)
  return {
    providerChannelId: metadata.channelId ?? null,
    providerChannelName: metadata.channelName ?? null,
    providerQueueWaitMs: Number(metadata.queueWaitMs) || 0,
    providerAttemptCount: Number(metadata.attemptCount) || 0,
    providerFallbackCount: Number(metadata.fallbackCount) || 0,
    providerRetryAfter: Number(metadata.retryAfter) || null,
    providerUsage: metadata.usage ?? null,
    providerRequestBytes: Number(lastAttempt?.requestBytes) || null,
    providerResponseBytes: Number(lastAttempt?.responseBytes) || null,
  }
}

async function loadSharedState() {
  const payload = await readJsonFile(sharedStatePath)
  if (!payload || typeof payload !== 'object' || !payload.data) return null
  if (payload.schemaVersion && Number(payload.schemaVersion) > SHARED_STATE_SCHEMA_VERSION) {
    throw new Error(`共享状态 schema ${payload.schemaVersion} 高于当前支持版本 ${SHARED_STATE_SCHEMA_VERSION}`)
  }
  // Raw archives are intentionally not part of a dashboard snapshot. Older
  // files may still contain `intel`; keep those bytes untouched on disk while
  // stripping them before they can freeze browser/desktop synchronization.
  const { intel: _legacyIntel, ...data } = payload.data
  return { ...payload, data }
}

async function loadSharedIntel() {
  return sharedIntelStore.loadSnapshot()
}

async function loadSharedIntelMeta() {
  return sharedIntelStore.loadMeta()
}

async function loadSharedIntelChanges(options) {
  return sharedIntelStore.loadChanges(options)
}

async function loadSharedIntelConversationIndex(options) {
  return sharedIntelStore.loadConversationIndex(options)
}

async function loadSharedIntelConversationPage(conversationId, options) {
  return sharedIntelStore.loadConversationPage(conversationId, options)
}

async function writeSharedIntelUnlocked(payload) {
  return sharedIntelStore.commit(payload)
}

async function writeSharedIntel(payload) {
  return withFileLock(`${sharedIntelStoreDirectoryPath}.lock`, () => writeSharedIntelUnlocked(payload))
}

async function writeSharedIntelDelta(payload) {
  return withFileLock(`${sharedIntelStoreDirectoryPath}.lock`, () => sharedIntelStore.commitDelta(payload))
}

function migrateLegacySharedIntel() {
  // Startup migration shares the same serialized writer as renderer imports.
  // Otherwise a first import racing startup could be overwritten by the old
  // JSON snapshot that migration read a moment earlier.
  const migration = sharedIntelWriteQueue.then(async () => {
    const migrated = await withFileLock(`${sharedIntelStoreDirectoryPath}.lock`, () => sharedIntelStore.migrate())
    if (migrated) console.log('[HYPERION] migrated the legacy gzip chat archive to append-only segment storage; the legacy file remains available for rollback')
    return migrated
  })
  sharedIntelWriteQueue = migration.catch(() => undefined)
  return migration
}

function saveSharedIntel(payload) {
  // The archive can be large. Serializing writes prevents two browser/desktop
  // clients from competing for the same temporary file during startup.
  const write = sharedIntelWriteQueue.then(() => writeSharedIntel(payload))
  sharedIntelWriteQueue = write.catch(() => undefined)
  return write
}

function saveSharedIntelDelta(payload) {
  const write = sharedIntelWriteQueue.then(() => writeSharedIntelDelta(payload))
  sharedIntelWriteQueue = write.catch(() => undefined)
  return write
}

async function writeSharedState(payload) {
  if (!payload?.data || typeof payload.data !== 'object') throw new Error('同步数据格式无效')
  // Preserve an inline archive written by an older renderer before stripping
  // it from future snapshots. New renderers never send raw records here.
  const legacy = await readJsonFile(sharedStatePath)
  if (Object.prototype.hasOwnProperty.call(payload, 'expectedUpdatedAt')) {
    const expectedUpdatedAt = typeof payload.expectedUpdatedAt === 'string' ? payload.expectedUpdatedAt : null
    const currentUpdatedAt = typeof legacy?.updatedAt === 'string' ? legacy.updatedAt : null
    if (expectedUpdatedAt !== currentUpdatedAt) {
      const conflict = new Error('共享数据已被另一个窗口更新，请合并后重试')
      conflict.statusCode = 409
      conflict.currentUpdatedAt = currentUpdatedAt
      throw conflict
    }
  }
  const preservedIntel = Array.isArray(payload.intel) ? payload.intel
    : Array.isArray(payload.data.intel) ? payload.data.intel
      : Array.isArray(legacy?.intel) ? legacy.intel
        : Array.isArray(legacy?.data?.intel) ? legacy.data.intel
          : undefined
  if (preservedIntel) await writeSharedIntel({ items: preservedIntel })
  // Do not rewrite the companion archive after migration. It may contain
  // hundreds of thousands of messages and is outside shared UI state.
  const { intel: _ignoredIntel, ...data } = payload.data
  const previousTime = typeof legacy?.updatedAt === 'string' ? Date.parse(legacy.updatedAt) : Number.NaN
  const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString()
  const snapshot = versionSharedState({ updatedAt, data })
  await writeJsonAtomically(sharedStatePath, snapshot)
  return snapshot
}

function saveSharedState(payload) {
  // Desktop and browser may sync at nearly the same time. A single temporary
  // file is safe only when snapshot writes are serialized.
  const write = sharedStateWriteQueue.then(() => withFileLock(`${sharedStatePath}.lock`, () => writeSharedState(payload)))
  sharedStateWriteQueue = write.catch(() => undefined)
  return write
}

/**
 * Apply a narrow server-side mutation to the current shared state.
 *
 * Server-side writes must never use the renderer's fetch-and-replace route:
 * that route can race a desktop/browser save and would require moving the
 * whole state document through the bot. The current state is instead read
 * while holding the same write lock used by normal snapshot saves.
 */
function mutateSharedState(mutator) {
  const write = sharedStateWriteQueue.then(() => withFileLock(`${sharedStatePath}.lock`, async () => {
    const current = await loadSharedState()
    if (!current?.data || typeof current.data !== 'object') {
      const error = new Error('HYPERION 尚未初始化共享数据；请先启动一次桌面版或浏览器版。')
      Object.assign(error, { status: 409, code: 'HYPERION_STATE_UNINITIALIZED' })
      throw error
    }
    const next = await mutator(current.data, current)
    if (!next || typeof next !== 'object') throw new Error('本机状态更新未返回有效数据')
    return writeSharedState({ data: next, expectedUpdatedAt: current.updatedAt })
  }))
  sharedStateWriteQueue = write.catch(() => undefined)
  return write
}

function configuredSeleneInboxDirectories() {
  const configuredInbox = hyperionEnvironment('SELENE_INBOX')
  const configured = typeof configuredInbox === 'string'
    ? configuredInbox.split(';').map((value) => value.trim()).filter(Boolean)
    : []
  // Development installs live under <work>/HYPERION/source.  SELENE's synced
  // inbox and its desktop writer are sibling projects, so recognize them
  // without requiring an environment variable. Packaged installs remain
  // explicit through HYPERION_SELENE_INBOX.
  const workRoot = resolve(runtimePaths.workspace, '..', '..')
  // A custom runtime root is used by release installs and isolated test runs;
  // it should not unexpectedly crawl an unrelated development workspace.
  const discoveredDefaults = process.env.HYPERION_RUNTIME_ROOT ? [] : [
    resolve(workRoot, 'SELENE-Inbox'),
    resolve(workRoot, '.tmp', 'selene.win.tmp'),
    resolve(workRoot, 'SELENE', 'exports'),
    resolve(workRoot, 'SELENE', 'outbox'),
  ]
  return [...new Set([...configured, ...discoveredDefaults].map((value) => resolve(value)))]
}

async function desktopSeleneConfiguredDirectories() {
  if (process.env.HYPERION_RUNTIME_ROOT && process.env.HYPERION_SELENE_AUTO_DISCOVERY !== '1') return []
  const localAppData = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA.trim() : ''
  if (!localAppData) return []
  try {
    const settings = await readJsonFile(resolve(localAppData, 'SELENE', 'desktop-settings.json'))
    const directory = typeof settings?.ExportDirectory === 'string' ? settings.ExportDirectory.trim() : ''
    return directory ? [resolve(directory)] : []
  } catch (error) {
    console.warn(`[HYPERION] cannot read SELENE desktop export setting: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

async function availableSeleneInboxDirectories() {
  const available = []
  const configured = [...new Set([...configuredSeleneInboxDirectories(), ...await desktopSeleneConfiguredDirectories()])]
  for (const directory of configured) {
    try {
      if ((await stat(directory)).isDirectory()) available.push(directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[HYPERION] cannot inspect SELENE directory ${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return available
}

function seleneWatcherStatePath(directory) {
  const suffix = createHash('sha256').update(directory).digest('hex').slice(0, 12)
  return `${seleneInboxStatePath}.${suffix}.json`
}

async function importSeleneInboxEvents(events) {
  let result = { added: 0, updated: 0, duplicates: Array.isArray(events) ? events.length : 0, contextEventCount: 0 }
  await mutateSharedState((data) => {
    const merged = mergeContextEvents(data.contextEvents, events)
    result = {
      added: merged.added,
      updated: merged.updated,
      duplicates: merged.duplicates,
      contextEventCount: merged.events.length,
    }
    return { ...data, contextEvents: merged.events }
  })
  return result
}

async function startSeleneInboxSync() {
  const directories = await availableSeleneInboxDirectories()
  for (const directory of directories) {
    if (seleneInboxWatchers.has(directory)) continue
    const watcher = createSeleneInboxWatcher({
      directory,
      statePath: seleneWatcherStatePath(directory),
      intervalMs: hyperionEnvironment('SELENE_SYNC_INTERVAL_MS'),
      settleMs: hyperionEnvironment('SELENE_SYNC_SETTLE_MS'),
      onImport: importSeleneInboxEvents,
      logger: (level, message) => console[level === 'warn' ? 'warn' : 'log'](`[HYPERION] ${message}`),
    })
    seleneInboxWatchers.set(directory, watcher)
    await watcher.start()
  }
  return [...seleneInboxWatchers.values()]
}

function configuredMnemoInboxDirectories() {
  // MNEMO is a HYPERION-owned sidecar. Do not accept arbitrary external JSON
  // inboxes while manual import is disabled; its private outbox is the only
  // supported chat intake path.
  return [resolve(mnemoInboxDirectoryPath)]
}

async function availableMnemoInboxDirectories() {
  const available = []
  for (const directory of configuredMnemoInboxDirectories()) {
    try {
      if ((await stat(directory)).isDirectory()) available.push(directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[HYPERION] cannot inspect MNEMO directory ${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return available
}

function mnemoWatcherStatePath(directory) {
  const suffix = createHash('sha256').update(directory).digest('hex').slice(0, 12)
  return `${mnemoInboxStatePath}.${suffix}.json`
}

async function importMnemoInboxRecords(records, metadata = {}) {
  const deleteIds = Array.isArray(metadata?.deleteIds)
    ? metadata.deleteIds.filter((id) => typeof id === 'string' && id.startsWith('mnemo:'))
    : []
  const write = sharedIntelWriteQueue.then(async () => {
    const saved = await writeSharedIntelDelta({ upserts: records, deleteIds })
    return { importedRecords: records.length, deletedRecords: deleteIds.length, archiveRecordCount: Number(saved?.recordCount) || 0 }
  })
  sharedIntelWriteQueue = write.catch(() => undefined)
  return write
}

async function startMnemoInboxSync() {
  const directories = await availableMnemoInboxDirectories()
  for (const directory of directories) {
    if (mnemoInboxWatchers.has(directory)) continue
    const watcher = createMnemoInboxWatcher({
      directory,
      statePath: mnemoWatcherStatePath(directory),
      intervalMs: process.env.HYPERION_MNEMO_INBOX_INTERVAL_MS,
      settleMs: process.env.HYPERION_MNEMO_INBOX_SETTLE_MS,
      onImport: importMnemoInboxRecords,
      logger: (level, message) => console[level === 'warn' ? 'warn' : 'log'](`[HYPERION] ${message}`),
    })
    mnemoInboxWatchers.set(directory, watcher)
    await watcher.start()
  }
  return [...mnemoInboxWatchers.values()]
}

async function startMnemoIntegration() {
  await mkdir(mnemoInboxDirectoryPath, { recursive: true, mode: 0o700 })
  const agent = await mnemoAgent.start()
  await startMnemoInboxSync()
  return agent
}

function botLocalDate(now = new Date()) {
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function botJournalRecord(data, content) {
  const body = cleanString(content, 8_000)
  if (!body) throw new Error('日记内容不能为空')
  const capturedAt = new Date().toISOString()
  const id = `bot-journal-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const speaker = cleanString(data?.profile?.name, 120) || '我'
  return {
    id,
    title: body.length > 40 ? `${body.slice(0, 40)}...` : body,
    summary: body.slice(0, 1_200),
    content: body,
    source: '手动记录',
    sourceFile: 'hyperion://self-journal',
    conversationId: 'self-journal',
    conversationName: '我',
    conversationKind: 'direct',
    speaker,
    messageType: 'journal',
    speakerRole: 'self',
    capturedAt,
    status: 'reviewed',
  }
}

function botCheckIn(data, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('状态数据格式无效')
  const now = new Date()
  if (fields.date !== undefined && (typeof fields.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fields.date))) throw new Error('状态日期必须是 YYYY-MM-DD')
  if (fields.mood !== undefined && ![1, 2, 3, 4, 5].includes(Number(fields.mood))) throw new Error('心情必须是 1 到 5')
  if (fields.sleepHours !== undefined && (!Number.isFinite(Number(fields.sleepHours)) || Number(fields.sleepHours) < 0 || Number(fields.sleepHours) > 24)) throw new Error('睡眠时长必须在 0 到 24 小时之间')
  if (fields.medication !== undefined && !['yes', 'no', 'reduced', 'unknown'].includes(fields.medication)) throw new Error('药物状态无效')
  if (fields.alcohol !== undefined && !['none', 'low', 'high', 'unknown'].includes(fields.alcohol)) throw new Error('酒精状态无效')
  const date = typeof fields.date === 'string' ? fields.date : botLocalDate(now)
  const existing = Array.isArray(data?.dailyCheckins) ? data.dailyCheckins.find((item) => item?.date === date) : null
  const mood = [1, 2, 3, 4, 5].includes(Number(fields.mood)) ? Number(fields.mood) : existing?.mood
  const requestedHours = Number(fields.sleepHours)
  const sleepHours = Number.isFinite(requestedHours) && requestedHours >= 0 && requestedHours <= 24
    ? Math.round(requestedHours * 2) / 2
    : existing?.sleepHours
  const medication = ['yes', 'no', 'reduced', 'unknown'].includes(fields.medication) ? fields.medication : (existing?.medication ?? 'unknown')
  const alcohol = ['none', 'low', 'high', 'unknown'].includes(fields.alcohol) ? fields.alcohol : (existing?.alcohol ?? 'unknown')
  const mainFocus = cleanString(fields.mainFocus, 360) || existing?.mainFocus
  const note = cleanString(fields.note, 1_200) || existing?.note
  const createdAt = typeof existing?.createdAt === 'string' ? existing.createdAt : now.toISOString()
  return {
    id: `self-checkin-${date}`,
    date,
    ...(mood ? { mood } : {}),
    ...(sleepHours !== undefined ? { sleepHours } : {}),
    medication,
    alcohol,
    ...(mainFocus ? { mainFocus } : {}),
    ...(note ? { note } : {}),
    createdAt,
    updatedAt: now.toISOString(),
  }
}

function botCheckInRecord(data, checkIn) {
  const medicationLabels = { yes: '是', no: '否', reduced: '减量', unknown: '未记录' }
  const alcoholLabels = { none: '无', low: '少', high: '多', unknown: '未记录' }
  const content = [
    '[每日状态快照]',
    checkIn.mood ? `状态：${checkIn.mood}/5` : '',
    checkIn.sleepHours !== undefined ? `睡眠：${checkIn.sleepHours} 小时` : '',
    `药物：${medicationLabels[checkIn.medication] ?? '未记录'}`,
    `酒精：${alcoholLabels[checkIn.alcohol] ?? '未记录'}`,
    checkIn.mainFocus ? `主要在做：${checkIn.mainFocus}` : '',
    checkIn.note ? `一句话：${checkIn.note}` : '',
  ].filter(Boolean).join('\n')
  return {
    id: checkIn.id,
    title: `${checkIn.date} 状态快照`,
    summary: content,
    content,
    source: '手动记录',
    sourceFile: 'hyperion://self-journal',
    conversationId: 'self-journal',
    conversationName: '我',
    conversationKind: 'direct',
    speaker: cleanString(data?.profile?.name, 120) || '我',
    messageType: 'daily-checkin',
    speakerRole: 'self',
    capturedAt: `${checkIn.date}T12:00:00.000`,
    status: 'reviewed',
  }
}

function botPersonSummary(person) {
  return {
    id: cleanString(person?.id, 160),
    name: cleanString(person?.name, 160) || '未命名人物',
    lastObservedAt: typeof person?.lastObservedAt === 'string' ? person.lastObservedAt : '',
    portrait: cleanString(person?.portrait, 480),
    factCount: Array.isArray(person?.facts) ? person.facts.length : 0,
    preferenceCount: Array.isArray(person?.preferences) ? person.preferences.length : 0,
  }
}

async function botOverview() {
  const [snapshot, archive] = await Promise.all([loadSharedState(), loadSharedIntelMeta()])
  const data = snapshot?.data ?? {}
  const quests = Array.isArray(data.quests) ? data.quests : []
  // Lightweight shared state intentionally omits archive metadata. When the
  // old summary is absent, ask the archive's cached conversation index for
  // its count without ever returning message bodies to the Bot.
  let archiveConversationCount = Number(data?.archive?.conversationCount) || 0
  if (!archiveConversationCount && Number(archive?.recordCount) > 0) {
    archiveConversationCount = Number((await loadSharedIntelConversationIndex({ limit: 1 }))?.totalConversations) || 0
  }
  return {
    generatedAt: new Date().toISOString(),
    profileName: cleanString(data?.profile?.name, 120) || '我',
    activeQuestCount: quests.filter((item) => item?.status === 'active' || item?.status === 'available').length,
    completedQuestCount: quests.filter((item) => item?.status === 'done').length,
    peopleCount: Array.isArray(data.people) ? data.people.length : 0,
    journalCheckInCount: Array.isArray(data.dailyCheckins) ? data.dailyCheckins.length : 0,
    archiveRecordCount: Number(archive?.recordCount) || 0,
    archiveConversationCount,
    archiveUpdatedAt: archive?.updatedAt ?? null,
  }
}

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    startAt: { type: ['string', 'null'] },
    dueAt: { type: ['string', 'null'] },
    sourceIds: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: { type: 'string' } },
    place: { type: ['string', 'null'] },
    locationPrecision: { type: 'string', enum: ['exact', 'approximate', 'unknown'] },
    locationRadiusMeters: { type: ['number', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    guidance: { type: 'array', items: { type: 'string' } },
    actionOwner: { type: 'string', enum: ['self', 'other', 'unknown'] },
  },
  required: ['title', 'description', 'startAt', 'dueAt', 'sourceIds', 'people', 'place', 'locationPrecision', 'locationRadiusMeters', 'tags', 'guidance', 'actionOwner'],
}

// The segment pass only needs claim-level evidence. Portrait prose, advice,
// and coverage metadata are generated later by the person merge request. Keep
// this schema deliberately small so every direct-chat segment does not pay
// the fixed cost of a full profile response format.
const compactPersonClaimSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    sourceIds: { type: 'array', items: { type: 'string' } },
    quote: { type: 'string' },
  },
  required: ['text', 'sourceIds', 'quote'],
}

const compactPersonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    facts: { type: 'array', items: compactPersonClaimSchema },
    preferences: { type: 'array', items: compactPersonClaimSchema },
    events: { type: 'array', items: compactPersonClaimSchema },
  },
  required: ['name', 'facts', 'preferences', 'events'],
}

const personMergeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // The merge model selects verified claim IDs. It never gets to invent a
    // replacement fact string that the renderer would have to trust.
    factClaimIds: { type: 'array', items: { type: 'string' } },
    preferenceClaimIds: { type: 'array', items: { type: 'string' } },
    portraitBlocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          claimIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', enum: ['background', 'preference', 'habit', 'interaction', 'change', 'trajectory', 'other'] },
        },
        required: ['text', 'claimIds', 'reason'],
      },
    },
    advice: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          claimIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'claimIds'],
      },
    },
    coverageNote: { type: ['string', 'null'] },
    profileNotesUsed: { type: 'boolean' },
  },
  required: ['factClaimIds', 'preferenceClaimIds', 'portraitBlocks', 'advice', 'coverageNote', 'profileNotesUsed'],
}

const taskGuidanceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    guidance: { type: 'array', items: { type: 'string' } },
  },
  required: ['guidance'],
}

const selfObservationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['event', 'behavior', 'emotional-state', 'cognition', 'relationship', 'decision', 'routine', 'stressor', 'coping', 'change', 'uncertainty'] },
    text: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { sourceId: { type: 'string' }, quote: { type: 'string' } },
        required: ['sourceId', 'quote'],
      },
    },
  },
  required: ['kind', 'text', 'evidence'],
}

const selfObservationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { observations: { type: 'array', items: selfObservationSchema } },
  required: ['observations'],
}

const selfMergePeriodSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          observationIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'observationIds'],
      },
    },
    themes: { type: 'array', items: { type: 'string' } },
    professionalContexts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          term: { type: 'string' },
          explanation: { type: 'string' },
          observationIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['term', 'explanation', 'observationIds'],
      },
    },
  },
  required: ['title', 'paragraphs', 'themes', 'professionalContexts'],
}

const selfMergeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    periods: { type: 'array', items: selfMergePeriodSchema },
    currentSummary: { type: ['string', 'null'] },
    limitations: { type: 'array', items: { type: 'string' } },
  },
  required: ['periods', 'currentSummary', 'limitations'],
}

const responseFormat = {
  type: 'json_schema',
  name: 'task_candidates',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      candidates: { type: 'array', items: candidateSchema },
    },
    required: ['candidates'],
  },
}

// Direct conversations can produce task candidates and claim-level person
// evidence in one model request. The expensive portrait/advice merge happens
// later, after all segments have been verified and combined.
const combinedResponseFormat = {
  type: 'json_schema',
  name: 'task_and_people_candidates',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      candidates: { type: 'array', items: candidateSchema },
      people: { type: 'array', items: compactPersonSchema },
    },
    required: ['candidates', 'people'],
  },
}

const chatResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: responseFormat.name,
    strict: true,
    schema: responseFormat.schema,
  },
}

const combinedChatResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: combinedResponseFormat.name,
    strict: true,
    schema: combinedResponseFormat.schema,
  },
}

const personMergeResponseFormat = {
  type: 'json_schema',
  name: 'person_fact_consolidation',
  strict: true,
  schema: personMergeSchema,
}

const personMergeChatResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'person_fact_consolidation',
    strict: true,
    schema: personMergeSchema,
  },
}

const taskGuidanceResponseFormat = {
  type: 'json_schema',
  name: 'task_guidance',
  strict: true,
  schema: taskGuidanceSchema,
}

const selfObservationResponseFormat = {
  type: 'json_schema',
  name: 'self_observations',
  strict: true,
  schema: selfObservationResponseSchema,
}

const selfObservationChatResponseFormat = {
  type: 'json_schema',
  json_schema: { name: 'self_observations', strict: true, schema: selfObservationResponseSchema },
}

const selfMergeResponseFormat = {
  type: 'json_schema',
  name: 'self_period_consolidation',
  strict: true,
  schema: selfMergeSchema,
}

const selfMergeChatResponseFormat = {
  type: 'json_schema',
  json_schema: { name: 'self_period_consolidation', strict: true, schema: selfMergeSchema },
}

const taskGuidanceChatResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: taskGuidanceResponseFormat.name,
    strict: true,
    schema: taskGuidanceResponseFormat.schema,
  },
}

const peopleResponseFormat = {
  type: 'json_schema',
  name: 'evidence_backed_people',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { people: { type: 'array', items: compactPersonSchema } },
    required: ['people'],
  },
}

const peopleChatResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: peopleResponseFormat.name,
    strict: true,
    schema: peopleResponseFormat.schema,
  },
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

function sendRequestError(response, error, fallback) {
  const status = Number(error?.status)
  const retryAfter = Number(error?.retryAfter)
  const payload = { error: error instanceof Error ? error.message : fallback }
  if (Number.isFinite(retryAfter) && retryAfter > 0) payload.retry_after = Math.min(providerCooldownMaxMs / 1_000, Math.ceil(retryAfter))
  if (error?.providerMetadata) payload.metadata = { provider: error.providerMetadata }
  sendJson(response, status >= 400 && status <= 599 ? status : 400, payload)
}

function requestAbortSignal(request, response) {
  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  return controller.signal
}

async function randomQuote() {
  try {
    const response = await fetch('https://v1.hitokoto.cn/?c=a&encode=json', { signal: AbortSignal.timeout(5000) })
    const payload = await response.json()
    const text = cleanString(payload?.hitokoto, 180)
    if (response.ok && text) return { text, from: cleanString(payload?.from || payload?.from_who || '一言', 80), online: true }
  } catch { /* The local fallback keeps the sidebar usable offline. */ }
  const fallback = fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)]
  return { ...fallback, online: false }
}

function allowedOrigin(origin) {
  if (!origin) return true
  if (origin === 'null') return process.env.HYPERION_ALLOW_FILE_ORIGIN === '1'
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === 'hyperion:' && parsed.hostname === 'app') return process.env.HYPERION_ALLOW_FILE_ORIGIN === '1'
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  } catch { return false }
}

function cancelledRequestError(message = 'AI extraction was cancelled') {
  const error = new Error(message)
  error.name = 'AbortError'
  Object.assign(error, { status: 499, code: 'PROVIDER_CANCELLED' })
  return error
}

function dispatchLocalAiRequest(path, payload, signal) {
  return new Promise((resolve, reject) => {
    const address = server.address()
    const listeningPort = address && typeof address !== 'string' ? address.port : null
    if (!listeningPort) {
      reject(new Error('本机模型代理尚未就绪'))
      return
    }
    const body = JSON.stringify(payload)
    const request = http.request({
      hostname: '127.0.0.1',
      port: listeningPort,
      path,
      method: 'POST',
      signal,
      // Do not reuse one browser-shaped connection here. Each model job needs
      // its own local socket so the provider scheduler can occupy every slot.
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let result = {}
        try { result = JSON.parse(raw) } catch { result = { error: raw.slice(0, 2_000) } }
        const status = Number(response.statusCode) || 500
        if (status >= 200 && status < 300) {
          resolve(result)
          return
        }
        const error = new Error(cleanString(result?.error, 2_000) || `本机模型子请求失败 (${status})`)
        Object.assign(error, { status, retryAfter: Number(result?.retry_after) })
        reject(error)
      })
    })
    request.setTimeout(providerRequestTimeoutMs + 30_000, () => request.destroy(new Error('本机模型子请求超时')))
    request.on('error', reject)
    request.end(body)
  })
}

function cleanupAiSessions(now = Date.now()) {
  for (const [id, session] of aiSessions) {
    if (now - session.lastTouchedAt <= aiSessionTtlMs) continue
    session.cancelled = true
    session.queue.length = 0
    session.inFlight.forEach((job) => job.controller?.abort())
    aiSessions.delete(id)
  }
}

function createAiSession() {
  cleanupAiSessions()
  const session = {
    id: randomUUID(),
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    queue: [],
    inFlight: new Map(),
    results: [],
    jobIds: new Set(),
    cancelled: false,
    dispatching: false,
  }
  aiSessions.set(session.id, session)
  return session
}

function sessionWorkflowPath(workflow) {
  if (workflow === 'people') return '/api/ai/people'
  if (workflow === 'tasks') return '/api/ai/analyze'
  if (workflow === 'self-observe') return '/api/ai/self/observe'
  if (workflow === 'self-merge') return '/api/ai/self/merge'
  return ''
}

function sessionResult(id, ok, result, error) {
  if (ok) return { id, ok: true, result }
  return {
    id,
    ok: false,
    status: Number(error?.status) || 500,
    retryAfter: Number(error?.retryAfter) || undefined,
    error: cleanString(error instanceof Error ? error.message : 'Local model subrequest failed', 2_000),
  }
}

function scheduleAiSessionDispatch(session) {
  if (session.cancelled || session.dispatching || !session.queue.length) return
  session.dispatching = true
  queueMicrotask(() => {
    session.dispatching = false
    while (!session.cancelled && session.queue.length) {
      const job = session.queue.shift()
      job.controller = new AbortController()
      session.inFlight.set(job.id, job)
      void dispatchLocalAiRequest(job.path, job.payload, job.controller.signal)
        .then((result) => sessionResult(job.id, true, result))
        .catch((error) => sessionResult(job.id, false, undefined, error))
        .then((result) => {
          session.inFlight.delete(job.id)
          if (!session.cancelled) {
            session.results.push(result)
            session.lastTouchedAt = Date.now()
          }
          scheduleAiSessionDispatch(session)
        })
    }
  })
}

function enqueueAiSessionJobs(session, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Batch model request cannot be empty')
  if (entries.length > aiSessionMaxEnqueue) throw new Error(`A session enqueue accepts at most ${aiSessionMaxEnqueue} jobs`)
  const jobs = entries.map((entry, index) => {
    const id = Number(entry?.id)
    const path = sessionWorkflowPath(entry?.workflow)
    if (!Number.isSafeInteger(id) || !path || !entry?.payload || typeof entry.payload !== 'object') {
      throw new Error(`Invalid session job at index ${index + 1}`)
    }
    if (session.jobIds.has(id)) throw new Error(`Duplicate session job id: ${id}`)
    return { id, path, payload: entry.payload }
  })
  jobs.forEach((job) => {
    session.jobIds.add(job.id)
    session.queue.push(job)
  })
  session.lastTouchedAt = Date.now()
  scheduleAiSessionDispatch(session)
  return jobs.map((job) => job.id)
}

function readAiSessionResults(session, limit = aiSessionResultPageSize, acknowledgedIds = [], retainUntilAcknowledged = false) {
  session.lastTouchedAt = Date.now()
  const pageSize = Math.max(1, Math.min(aiSessionResultPageSize, Math.round(Number(limit) || aiSessionResultPageSize)))
  if (!retainUntilAcknowledged) {
    return {
      // Releases before ack-v1 expect each read to consume its page. Keep
      // that behavior for a renderer and local proxy updated separately.
      results: session.results.splice(0, pageSize),
      queued: session.queue.length,
      inFlight: session.inFlight.size,
      pending: session.queue.length + session.inFlight.size,
    }
  }
  const acknowledged = new Set(acknowledgedIds.filter((id) => Number.isSafeInteger(id)))
  if (acknowledged.size) session.results = session.results.filter((result) => !acknowledged.has(result.id))
  return {
    // Results remain server-resident until the next successful client poll
    // acknowledges them. A dropped HTTP response can therefore be replayed
    // without dispatching the same model job again.
    results: session.results.slice(0, pageSize),
    queued: session.queue.length,
    inFlight: session.inFlight.size,
    pending: session.queue.length + session.inFlight.size,
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    let failed = false
    const chunks = []
    request.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > maxBodyBytes) {
        failed = true
        chunks.length = 0
        const error = new Error('本机请求正文超过 256MB；请缩小导入范围或分批处理。')
        Object.assign(error, { status: 413 })
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (failed) return
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('请求不是有效 JSON')) }
    })
    request.on('error', reject)
  })
}

function cleanString(value, max = 600) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function validCoordinate(value, min, max) {
  const text = String(value ?? '').trim()
  const number = Number(text)
  return text !== '' && Number.isFinite(number) && number >= min && number <= max
}

function validatePayload(payload) {
  if (!payload || !Array.isArray(payload.records) || payload.records.length === 0) throw new Error('至少需要一条聊天记录')
  const declaredTotal = payload?.conversation?.totalRecords
  const declaredRecordCount = payload?.conversation?.recordCount
  if (declaredTotal !== undefined && (!Number.isInteger(declaredTotal) || declaredTotal < payload.records.length)) {
    throw new Error(`会话总记录数无效：声明 ${declaredTotal} 条，本段实际收到 ${payload.records.length} 条。`)
  }
  if (declaredRecordCount !== undefined && (!Number.isInteger(declaredRecordCount) || declaredRecordCount !== payload.records.length)) {
    throw new Error(`会话分段记录数不完整：声明 ${declaredRecordCount} 条，实际收到 ${payload.records.length} 条。`)
  }
  const segmentIndex = payload?.conversation?.segmentIndex
  const segmentCount = payload?.conversation?.segmentCount
  if ((segmentIndex !== undefined || segmentCount !== undefined)
    && (!Number.isInteger(segmentIndex) || !Number.isInteger(segmentCount) || segmentIndex < 1 || segmentCount < segmentIndex)) {
    throw new Error('会话分段编号无效。')
  }
  const coreRecordIndexes = payload?.conversation?.coreRecordIndexes
  if (coreRecordIndexes !== undefined && (!Array.isArray(coreRecordIndexes)
    || !coreRecordIndexes.length
    || coreRecordIndexes.some((value) => !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > payload.records.length))) {
    throw new Error('会话分段核心记录索引无效。')
  }
  if (!Array.isArray(payload.attachments) || payload.attachments.length > maxAttachments) throw new Error(`最多附带 ${maxAttachments} 个文件或图片`)
  for (const record of payload.records) {
    // Accept legacy envelopes that only persisted a summary; compact-v2 still
    // sends one ordered row for every imported record.
    if (record && !cleanString(record.content, 3000) && cleanString(record.summary, 3000)) record.content = record.summary
    if (!cleanString(record?.id, 160) || !cleanString(record?.content, 3000)) throw new Error('记录缺少 id 或内容')
  }
  for (const attachment of payload.attachments) {
    const data = cleanString(attachment?.data, maxAttachmentBytes * 2)
    if (!data || !cleanString(attachment?.mimeType, 120) || Buffer.byteLength(data, 'utf8') > maxAttachmentBytes * 2) throw new Error('附件缺少内容或超过 8MB')
  }
}

function compactModelRecords(records) {
  // The model wire format deliberately contains only fields that affect
  // chronology, content, evidence references, and speaker direction.
  // formattedTime, type, and senderDisplayName remain accepted from old
  // clients, but are normalized away before the prompt is built.
  return records.map((record, index) => [
    String(index + 1),
    cleanString(record.sentAt, 80) || cleanString(record.formattedTime, 80) || null,
    cleanString(record.content, 3000) || cleanString(record.summary, 3000) || '[non-text message]',
    record.speakerRole === 'self' || record.speakerRole === 'other' ? record.speakerRole : 'unknown',
  ])
}

function payloadCounterpartName(payload) {
  const declared = cleanString(payload?.conversation?.counterpartName, 120)
  if (declared) return declared
  const names = [...new Set((Array.isArray(payload?.records) ? payload.records : [])
    .filter((record) => record?.speakerRole === 'other' && cleanString(record?.senderDisplayName, 120))
    .map((record) => cleanString(record.senderDisplayName, 120)))]
  return names.length === 1 ? names[0] : ''
}

function payloadAnalysisClock(payload) {
  const rawAnalysisAsOf = cleanString(payload?.conversation?.analysisAsOf, 80)
  const parsedAnalysisAsOf = Date.parse(rawAnalysisAsOf)
  const analysisAsOf = Number.isFinite(parsedAnalysisAsOf)
    ? new Date(parsedAnalysisAsOf).toISOString()
    : new Date().toISOString()
  let timeZone = cleanString(payload?.conversation?.timeZone, 80) || 'local'
  if (timeZone !== 'local') {
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format() } catch { timeZone = 'local' }
  }
  const rawOffset = Number(payload?.conversation?.utcOffsetMinutes)
  const utcOffsetMinutes = Number.isFinite(rawOffset) ? Math.max(-840, Math.min(840, Math.round(rawOffset))) : null
  const offsetLabel = utcOffsetMinutes == null
    ? 'offset unknown'
    : `UTC${utcOffsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(utcOffsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(utcOffsetMinutes) % 60).padStart(2, '0')}`
  return { analysisAsOf, timeZone, utcOffsetMinutes, offsetLabel }
}

function formatDateInTimeZone(date, timeZone) {
  if (timeZone === 'local') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
  } catch {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
}

function compactRecordRefRanges(values, fallbackCount) {
  const source = values != null && typeof values[Symbol.iterator] === 'function'
    ? [...values]
    : []
  const indexes = [...new Set(source.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right)
  if (!indexes.length) return `1 through ${fallbackCount}`
  const ranges = []
  let start = indexes[0]
  let end = indexes[0]
  const push = () => ranges.push(start === end ? String(start) : `${start}-${end}`)
  for (const index of indexes.slice(1)) {
    if (index === end + 1) end = index
    else {
      push()
      start = index
      end = index
    }
  }
  push()
  return ranges.join(', ')
}

function directionStats(records) {
  return records.reduce((stats, record) => {
    const role = record?.speakerRole === 'self' || record?.speakerRole === 'other' ? record.speakerRole : 'unknown'
    stats[role] += 1
    return stats
  }, { self: 0, other: 0, unknown: 0 })
}

function restoreRecordReferences(entries, records) {
  const idsByReference = new Map(records.map((record, index) => [String(index + 1), String(record?.id ?? '')]))
  const restoreIds = (sourceIds) => Array.isArray(sourceIds)
    ? sourceIds.map((value) => idsByReference.get(String(value)) || String(value))
    : sourceIds
  const restoreClaims = (claims) => Array.isArray(claims)
    ? claims.map((claim) => claim && typeof claim === 'object'
      ? { ...claim, sourceIds: restoreIds(claim.sourceIds) }
      : claim)
    : claims
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    return {
      ...entry,
      sourceIds: restoreIds(entry.sourceIds),
      facts: restoreClaims(entry.facts),
      preferences: restoreClaims(entry.preferences),
    }
  })
}

function buildPrompt(payload) {
  const mode = cleanString(payload.settings?.mode, 40) || 'balanced'
  const instructions = cleanString(payload.settings?.instructions, 2000) || '优先提取明确、仍需本人处理的现实安排。'
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.task, 6000)
  const peopleWorkflowInstructions = cleanString(payload.settings?.promptInstructions?.people, 6000)
  const recencyPolicy = ['strict', 'balanced', 'broad'].includes(payload.settings?.recencyPolicy) ? payload.settings.recencyPolicy : 'balanced'
  const feedback = Array.isArray(payload.settings?.feedback) ? payload.settings.feedback.slice(-8).map((item) => ({
    title: cleanString(item?.title, 120),
    description: cleanString(item?.description, 500),
    decision: item?.decision === 'accepted' ? 'accepted' : 'dismissed',
    reason: cleanString(item?.reason, 40),
    sourceCapturedAt: cleanString(item?.sourceCapturedAt, 80) || null,
  })) : []
  const now = new Date()
  const conversation = payload.conversation ?? {}
  const { analysisAsOf, timeZone, offsetLabel } = payloadAnalysisClock(payload)
  const analysisTimestamp = Date.parse(analysisAsOf)
  const analysisDateSource = Number.isFinite(analysisTimestamp) ? new Date(analysisTimestamp) : now
  const analysisDate = formatDateInTimeZone(analysisDateSource, timeZone)
  const conversationName = cleanString(payload.conversation?.name, 160)
  const compactRecords = compactModelRecords(payload.records)
  const includePeople = payload.workflows?.people === true && conversation.kind === 'direct'
  const counterpartName = conversation.kind === 'direct' ? payloadCounterpartName(payload) : ''
  const legacyTaskOutputContract = includePeople
    ? 'Return exactly one JSON object with candidates and people arrays. Every candidate must include title, description, startAt, dueAt, sourceIds, people, place, locationPrecision, locationRadiusMeters, tags, guidance, and actionOwner. Every person must include name, facts, preferences, advice, sourceIds, platforms, firstObservedAt, and portrait; each fact or preference is an object with text, sourceIds, and quote. Use null for unavailable dates, place, locationRadiusMeters, firstObservedAt, or portrait; use "unknown" when no location is established; use [] when no candidate or person evidence is justified. Do not estimate duration or travel time. actionOwner must be "self". Cite only RecordRef values present in the input, as strings.'
    : 'Return exactly one JSON object with a candidates array. Every candidate must include title, description, startAt, dueAt, sourceIds, people, place, locationPrecision, locationRadiusMeters, tags, guidance, and actionOwner. Use null for unavailable startAt, dueAt, place, or locationRadiusMeters; use "unknown" when no location is established; use [] for unavailable people, tags, or guidance. Do not estimate duration or travel time. actionOwner must be "self". Cite only RecordRef values present in the input, as strings.'
  const taskOutputContract = includePeople
    ? 'Return exactly one JSON object with candidates and people arrays. Candidates use the full candidate fields above. People are evidence only: each person has name, facts, and preferences; each claim has text, sourceIds, and an exact quote. Do not return portrait, advice, platforms, firstObservedAt, or any other person fields. Use [] when no evidence-backed task or person claim is justified. Cite only RecordRef values present in the input, as strings.'
    : legacyTaskOutputContract
  const segmentIndex = Number(conversation.segmentIndex) || 1
  const segmentCount = Number(conversation.segmentCount) || 1
  const coreRecordIndexes = new Set((Array.isArray(conversation.coreRecordIndexes) ? conversation.coreRecordIndexes : []).map(String))
  const historicalSegment = conversation.historical === true
  const segmentMode = [
    `This request is segment ${segmentIndex}/${segmentCount} of the same exported conversation${conversationName ? `: ${conversationName}` : ''}. It contains ${compactRecords.length} ordered rows, including a small preceding overlap for context. The full conversation is covered by other sequential requests; never assume facts from those other requests.`,
    `Rows ${compactRecordRefRanges(coreRecordIndexes, compactRecords.length)} are this segment's new timeline range. Overlap rows may explain context, but every candidate must cite at least one new-range RecordRef. Do not recreate an arrangement already complete in the overlap.`,
    historicalSegment
      ? 'This is historical material, older than roughly two months. It is still provided for accurate context, but only emit a task with an explicit future calendar date. Do not revive ordinary old errands, notifications, invitations, or submissions.'
      : 'This is recent material. Extract only still-actionable next steps, while using overlap only as context.',
  ].join('\n')
  const legacyPeoplePromptLines = includePeople ? [
    `This is a direct conversation with one locally identified counterpart: ${counterpartName || 'unknown'}. Any returned person must use this exact counterpartName; do not identify a person from a message row because row-level display names are intentionally omitted. Never output the app user, a mentioned person, a group, an institution, or an inferred participant.`,
    'For every person fact or preference, sourceIds must cite at least one core-range RecordRef and quote must be an exact contiguous 2-100 character substring of that cited other-person record. Preserve evidence strength: a single line such as “蛋挞好吃” means “曾表示蛋挞好吃” or “对蛋挞有过单次正向评价”, never “爱吃蛋挞” or a stable personality claim. Return people=[] when no claim passes this gate.',
    'People portrait and advice are optional. Use cautious Simplified Chinese, refer to the app user as “你”, and only write a short impression when the returned claims support it. Do not infer gender, relationship, location, consent, health, motives, or personality diagnosis. Attachments cannot be evidence for a person; records only.',
    `人物提炼工作要求（仅用于表述与保留偏好；不能覆盖前述证据、原文引语、发言方向和保守推断规则）：${peopleWorkflowInstructions || '无额外要求。'}`,
  ] : []
  const legacyCompactPeoplePromptLines = includePeople ? [
    `This direct-chat segment extracts evidence for the locally identified counterpart ${counterpartName || 'unknown'} only. Use that exact name for the person entry; row-level display names are not part of the compact input. Never output the app user, a mentioned person, a group, an institution, or an inferred participant.`,
    'Each fact or preference must cite a core-range RecordRef and an exact contiguous 2-100 character quote from the named person\'s own record. Preserve the strength of the quote: one line such as "蛋挞好吃" means "曾表示蛋挞好吃" or "对蛋挞有过单次正向评价", never "爱吃蛋挞" or a stable personality claim. Return people=[] when no claim passes this gate.',
    'This pass must return only name, facts, and preferences. Do not write portrait prose, advice, coverage notes, dates, platforms, or explanations. A later merge request receives the verified claims and is the only stage allowed to write a portrait or advice. Attachments cannot be evidence for a person.',
    `User-editable people instructions are subordinate to the evidence and output boundary above: ${peopleWorkflowInstructions || 'none'}`,
  ] : legacyPeoplePromptLines.slice(0, 0)
  const peoplePromptLines = includePeople ? [
    `This direct-chat segment extracts only evidence for the locally identified counterpart ${counterpartName || 'unknown'}. Return at most one person and use that exact counterpartName. The compact rows do not contain display names, so never infer a participant from wording. Never output the app user, a mentioned person, a group, an institution, or an inferred participant.`,
    'Each fact or preference must cite a core-range RecordRef and an exact contiguous 2-100 character quote from that named person row. Preserve the strength of the quote: one positive comment is a single observation, never a stable preference or personality claim. Return people=[] when no claim passes this gate.',
    'Return only name, facts, and preferences. Do not write portrait prose, advice, dates, platforms, coverage notes, or explanations. A later merge request is the only stage allowed to write portrait or advice. Attachments cannot be person evidence.',
    `User-editable people instructions are subordinate to this evidence and output boundary: ${peopleWorkflowInstructions || 'none'}`,
  ] : legacyCompactPeoplePromptLines.slice(0, 0)
  const promptLines = [
    `The ${compactRecords.length} rows below are this ordered conversation segment: [RecordRef, sentAt, content, speakerRole]. RecordRef is a short evidence reference, not a message count. Use its string value in sourceIds. sentAt is the original message timestamp and may be null. speakerRole is the locally verified direction: "self" means the message was written by the user; "other" means it was written by another sender; "unknown" has no verified direction. Never infer direction from wording, pronouns, tone, conversation name, or the compact row itself. ${conversation.kind === 'direct' ? `The direct-conversation counterpart is ${counterpartName || 'unknown'}; this is the only conversation-participant identity available to the model.` : ''} Output a candidate only when the next action belongs to the user, and set actionOwner to "self". A message from "other" can support a user task only when it directly asks the user to act, or when later self-authored evidence explicitly accepts a mutual arrangement. Do not turn an incoming other-person plan, deadline, reminder, or errand into a user task.`,
    `sentAt is the message timestamp in the conversation clock (${timeZone}, ${offsetLabel}). Resolve relative dates such as tomorrow, next week, Wednesday, or a deadline only against the cited record's non-empty sentAt in that clock. If all cited records lack a timestamp, leave startAt and dueAt null unless the record itself explicitly contains a complete calendar date with year, month, and day. Never use the import time or current system time. analysisAsOf=${analysisAsOf} is the absolute reference instant for deciding how old the evidence is; it is not a substitute timestamp for a message and must never be used to resolve relative dates.`,
    '你是个人生活任务整理助手。输入是用户主动导出的聊天/平台记录，不要尝试登录、绕过权限、恢复密码或推断敏感隐私。',
    segmentMode,
    taskOutputContract,
    'A row whose content is [non-text message] preserves chronology only; never use it as the sole evidence for a task or person claim.',
    ...peoplePromptLines,
    `分析模式：${mode}。`,
    `有效性检查日期：${analysisDate}（analysisAsOf=${analysisAsOf}，${timeZone}，${offsetLabel}）；时效偏好：${recencyPolicy}。该日期只用于判断事项距分析时刻是否仍有行动价值，绝不能拿来解析“明天、下周”等相对日期。`,
    '只输出用户本人仍可执行的下一步：明确约会、见面、预约、回复、付款、报名、提交、课程、考试、截止、双方待确认的安排，或对方明确请求用户处理的事。必须跳过产品/模型/提示词的讨论、泛泛抱怨、闲聊、愿望、纯建议、已完成、已取消、已过期、他人的待办，以及发言方向未知的事项。',
    '时效规则：快递取件码、外卖、验证码、签到和临时通知属于短时事项，若信息源已过去数日且没有新的未完成证据，必须跳过。没有截止日期的征集、投稿、问卷、报名或材料提交，若通知已过去数周且用户没有明确接受或后续追问，通常视为失效。返校、课程、生日、约见等原文指向未来日期或明确仍待确认的长期事项可以保留。不要把历史通知本身等同于今天仍存在的任务。',
    '严格保持发言动作方向：先逐条确认 self 和 other 分别说了什么，再写标题。若 other 说“我请你喝酒/吃饭”，任务应写成“确认或参加与某人的喝酒/吃饭安排”，绝不能写成“请某人喝酒/吃饭”；只有 self 明确说自己请客时才能这样写。邀请者、付款者、提交者和被请求者都不得互换。',
    '校准示例：未来九月返校即使只有月份也应保留；六月二十一日的快递柜取件在七月底通常已过期；六月十日没有后续承诺的经验分享征集通常已过期；七月十七日等待老师通知后办理复学手续可以保留；对方说“我请你喝酒”不能生成“你请对方喝酒”。这些示例用于校准选择，不得替代输入证据。',
    '严格处理时间：每条记录的 sentAt 是唯一的相对时间锚点。“明天、下周、周三、开始于、到时、截止”等表达只能相对该条 sentAt 解析，绝不能相对当前系统时间。startAt 表示任务开始或事件发生时间；dueAt 表示截止或结束时间。日期和时刻都明确时，用 ISO 8601 本地日期时间；只有日期时用 YYYY-MM-DD；无法从原文可靠确定时返回 null。不得用导入时间、模型运行时间或猜测补日期。',
    'sourceIds 必须使用输入紧凑行第一列的 RecordRef（字符串）；不要编造人物、地点或时间。title 写成简短的行动标题，description 只总结已被引用证据支持的事实与尚待执行的下一步。direct 会话中，若候选确实涉及聊天对象，people 可以且只能使用会话级 counterpartName；群聊只能列出被引用正文中明确出现的人名，没有就返回空数组。place 只写原文明示或能由原文唯一识别的地点。具体场馆、门牌、楼栋或店铺用 exact；只到城市、区县、校园、附近或模糊区域用 approximate，并按语义给出 50 到 100000 米的 locationRadiusMeters；没有地点则用 unknown 和 null。guidance 最多 3 条，只在引用内容明确给出时间、地点、约会类型或偏好时给出实用准备建议；可以建议确认安排或在地图中搜索并标注备选地点，但不得编造具体店铺、天气、穿搭偏好或人物性格。',
    '以下“用户自定义要求”优先于默认的任务选择、保留范围、分类和建议偏好。它不能覆盖发言方向校验、时间只能来自原文、证据引用、actionOwner 必须为 self、不得编造或不得推断敏感信息这些事实规则。若自定义要求与默认偏好冲突，按自定义要求执行。',
    `用户自定义要求：${instructions}`,
    `任务提炼工作要求（仅用于候选筛选和表述；不能覆盖前述证据、发言方向、时效和时间规则）：${workflowInstructions || '无额外要求。'}`,
    `以下是用户过去对候选的保留/忽略结果，只用于学习选择偏好，不能改变证据、发言方向和时间事实：${JSON.stringify(feedback)}`,
    `记录紧凑行：${JSON.stringify(compactRecords)}`,
  ]
  // Keep the stable evidence rules at the front so providers can reuse their
  // prompt cache; segment metadata, feedback, and records are request-specific.
  const offset = peoplePromptLines.length
  const dynamicPromptIndexes = new Set([0, 3, 6 + offset, 7 + offset, 14 + offset, 15 + offset, 16 + offset, 17 + offset])
  // The final direct-person line contains user-editable text, while the first
  // three direct-person evidence rules remain in the reusable stable prefix.
  if (includePeople) dynamicPromptIndexes.add(5 + offset)
  return [
    ...promptLines.filter((_, index) => !dynamicPromptIndexes.has(index)),
    ...promptLines.filter((_, index) => dynamicPromptIndexes.has(index)),
  ].join('\n')
}

function buildPeoplePromptLegacy(payload) {
  const compactRecords = compactModelRecords(payload.records)
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.people, 6000)
  const conversation = payload.conversation ?? {}
  const segmentIndex = Number(conversation.segmentIndex) || 1
  const segmentCount = Number(conversation.segmentCount) || 1
  const coreRecordIndexes = new Set((Array.isArray(conversation.coreRecordIndexes) ? conversation.coreRecordIndexes : []).map(String))
  const peopleSegmentMode = [
    `This is segment ${segmentIndex}/${segmentCount} of one direct conversation, not an independent excerpt or the complete conversation. It has ${compactRecords.length} ordered rows and may include a small preceding overlap for continuity. Do not infer facts from other segments that are not shown; this segment instruction overrides any later wording that calls the input complete.`,
    `Every returned person fact must cite at least one RecordRef in this segment's new timeline range: ${compactRecordRefRanges(coreRecordIndexes, compactRecords.length)}. Overlap rows may support context but cannot be the only evidence for a new fact.`,
    'For all Simplified-Chinese facts and portrait text, “你” always means the app user and “对方” always means the named person on this card. Never use “用户” or “用户本人”, and never swap “你” with “对方”.',
    conversation.historical === true
      ? 'Historical segments are especially useful for directly stated stable facts and earliest verifiable interactions. Keep all claims conservative and grounded in cited rows.'
      : 'Recent segments may add directly stated facts or a cautious dialogue impression only when multiple cited rows support it.',
  ].join('\n')
  const personOutputContract = 'Return exactly one JSON object with a people array. Every person must include name, facts, preferences, events, advice, sourceIds, platforms, firstObservedAt, and portrait. Each facts/preference/event item must be an object with text, sourceIds, and quote. quote must be an exact contiguous original phrase from one cited row. Use [] when no facts, preferences, or meaningful events are justified; use an empty advice array and null portrait during this segment evidence pass.'
  const promptLines = [
    peopleSegmentMode,
    personOutputContract,
    `This input is one direct conversation with ${compactRecords.length} ordered compact rows: [RecordRef, sentAt, content, speakerRole]. The locally identified counterpart is ${cleanString(conversation.counterpartName, 120) || 'unknown'}; use that exact name for the person entry. Use RecordRef strings in sourceIds. A person claim can cite only a row whose speakerRole is "other". Never output the user or an inferred participant. firstObservedAt must be the earliest sentAt among cited sourceIds, or null if no cited timestamp can be read. It means "earliest verifiable interaction", never when two people met. Extract every distinct directly stated fact supported by cited records, up to 12 concise facts. In Chinese facts and portrait, refer to the app user as “你” and refer to the profile subject by the exact counterpart name; never use the ambiguous labels “对方”, “用户” or “用户本人”. portrait is optional and must be a short Simplified-Chinese dialogue impression, explicitly cautious. Only provide portrait when several cited records show a repeated communication pattern; otherwise return null so the interface can ask for more information sources. It is not a fact and must not diagnose personality or relationship.`,
    '你是个人生活人物的严格事实核验助手。输入是用户主动导出的聊天或平台记录。只处理输入文字本身，不要尝试登录、绕过权限、恢复密码或推断隐私。',
    '任务：只输出该私聊中由对方发言记录明确标识的对方；为其写出原文直接陈述、可被核验的事实。没有足够事实时可以返回空数组，客户端会保留一张只说明“存在可核实私聊互动”的保守人物卡。',
    '绝对规则：不要从昵称、语气、共同出现、头像、称呼或关系词推断身份、关系、偏好、性格、情绪、住址或任何未明说的信息。不要将被提及的人自动认定为发送者、提供者或同一人。不要把用户本人、群名、机构、课程、地点、作品角色或抽象对象当成人物。',
    'sourceIds 必须精确使用输入紧凑行第一列的 RecordRef（字符串）；每个 facts 至少应有一条对应 sourceIds 证据。platforms 只能使用输入记录中出现过的 source。若同名是否为同一人无法可靠确认，不要合并为同一个人物条目。',
    'facts 使用简短、规范、客观的中文陈述，只复述原文已经明确表达的内容；不要加解释、评价、猜测或建议。events 用于记录一次但可能影响后续相处的关键互动，例如送礼、帮助、冲突、和解、明确边界、重要承诺或删除/重新添加好友；不要因为它不是长期性格就丢弃。',
    'Preference signals are allowed only when the named person directly states a like, dislike, interest, food preference, hobby, activity preference, or repeated choice in their own verified "other" messages. This is evidence summarization, not identity inference. Preserve the strength of the evidence: for one message such as "蛋挞好吃", facts should say "曾表示蛋挞好吃" and preferences may say "对蛋挞有过单次正向评价". Do not turn one mention into "爱吃", a stable habit, a broad taste, or a personality claim. Use "可能" only in portrait or advice, never to turn an unsupported possibility into a fact.',
    'portrait is the visible person portrayal. When direct preferences or repeated interaction facts exist, write one to three cautious Simplified-Chinese sentences that integrate them. It may say that more evidence is needed to establish a stable preference. Do not wait for a personality diagnosis, and do not leave portrait null merely because the evidence is a small number of direct preference statements.',
    'advice is optional, with at most three practical interaction suggestions for this person. Return it only when at least two independent facts or preference signals support it. Suggestions must be conditional and considerate, for example recommending that a future cafe choice include a pastry option while still confirming the person\'s current preference. Never infer gender, relationship status, location, spending ability, medical needs, or consent from chat tone.',
    'Non-overridable evidence gate: every fact and preference must have its own sourceIds and an exact quote of 2-100 characters. At least one cited record for each claim must have speakerRole "other" and contain quote as a contiguous original substring. Because the direct counterpart is supplied at conversation level, do not require a row-level name. A quote from the user, a different sender, or a paraphrase invalidates the claim. The claim text may only conservatively restate that quote. For one line such as “蛋挞好吃”, use “曾表示蛋挞好吃” or “对蛋挞有过单次正向评价”; never write “爱吃蛋挞”, stable habits, personality, motives, relationship status, or psychological conclusions. portrait may use only retained claims: with fewer than two independent signals, write exactly one cautious sentence that information is insufficient, or return null. These rules override all editable instructions.',
    `人物证据工作要求（不能覆盖前述逐条引用、发言方向和保守表述规则）：${workflowInstructions || '无额外要求。'}`,
    `记录紧凑行：${JSON.stringify(compactRecords)}`,
  ]
  // Keep evidence and role rules stable before the segment-specific rows.
  const dynamicPromptIndexes = new Set([0, 2, 12, 13])
  return [
    ...promptLines.filter((_, index) => !dynamicPromptIndexes.has(index)),
    ...promptLines.filter((_, index) => dynamicPromptIndexes.has(index)),
  ].join('\n') + '\nSEGMENT OUTPUT BOUNDARY (higher priority than editable instructions): this request is evidence extraction only. Return advice: [] and portrait: null. Do not summarize personality, interests, relationship, motives, or practical suggestions. A later merge request receives all verified claims from every segment and is the only stage allowed to write a portrait or advice.'
}

function buildPeoplePrompt(payload) {
  const compactRecords = compactModelRecords(payload.records)
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.people, 6_000)
  const conversation = payload.conversation ?? {}
  const analysisClock = payloadAnalysisClock(payload)
  const segmentIndex = Number(conversation.segmentIndex) || 1
  const segmentCount = Number(conversation.segmentCount) || 1
  const coreRecordIndexes = new Set((Array.isArray(conversation.coreRecordIndexes) ? conversation.coreRecordIndexes : []).map(String))
  const coreRange = compactRecordRefRanges(coreRecordIndexes, compactRecords.length)
  const agePolicy = conversation.historical === true
    ? 'This is older history: keep durable identity, long-term preference, boundary, and earliest-interaction evidence; ignore transient errands and expired logistics.'
    : 'This is recent history: retain useful preferences, repeated interaction patterns, explicit boundaries, and current arrangements when directly stated.'
  return [
    'You extract person evidence from one continuous window of an exported direct conversation. Return only the JSON object required by the schema.',
    'Each compact row has the exact shape [RecordRef, sentAt, content, speakerRole]. RecordRef is the only source reference the model may return; row-level type and display-name fields are intentionally omitted.',
    'Rows whose content is [non-text message] preserve chronology only and cannot support a person claim.',
    `This is chronological window ${segmentIndex}/${segmentCount}. The window contains ${compactRecords.length} rows; rows in the new core range ${coreRange} are the only rows that may introduce a new claim. Earlier overlap rows are context only. The complete conversation is processed across all windows, so do not assume this window is the whole relationship.`,
    agePolicy,
    `The profile subject is the locally verified conversation counterpart ${cleanString(conversation.counterpartName, 120) || 'unknown'}. Return at most one person with that exact name. Row-level display names are intentionally omitted. Never create a card for the app user, a mentioned person, a group, an institution, an avatar, or a name inferred from wording. Never swap "你" and the named person.`,
    'Return facts for directly stated background or durable information, preferences for directly stated likes/dislikes/interests, and events for date-anchored interactions that can matter to the relationship even when they happened only once. Events include meaningful help or gifts, a conflict or reconciliation, deleting or re-adding contact, a boundary being asserted or respected, an important promise, or another interaction whose later consequences may matter. Do not discard an event merely because it was brief or old. Skip greetings, expired logistics, isolated mood/status updates, generic opinions, model commentary, and filler.',
    'An event is not a personality trait. Describe only what happened in that window and preserve uncertainty. Later consolidation will compare it with subsequent evidence to decide whether it marked change, continuity, or only a past episode. Never infer why a quiet period occurred; deletion, blocking, reconciliation, or renewed contact requires explicit chat evidence or a separate user-confirmed timeline note.',
    'Each fact or preference must be a conservative Simplified-Chinese restatement of the named person\'s own message. Preserve strength: one quote such as "蛋挞好吃" supports "曾表示蛋挞好吃" or "对蛋挞有过一次正面评价", never "爱吃蛋挞" or a personality conclusion. Repeated direct statements may support a cautious repeated preference, but do not generalize beyond them.',
    'Every claim must include sourceIds containing at least one core RecordRef and quote containing an exact contiguous 2-100 character substring from a cited row. The cited row must have speakerRole "other". Never cite the user\'s message, paraphrase a quote, or use a RecordRef that is not present.',
    'Do not output portrait prose, advice, platforms, relationship labels, gender, location, motives, diagnosis, or evidence disclaimers. Dates are taken locally from cited records. Return an empty people array when no claim passes every gate.',
    `User-editable people instructions are style preferences only and cannot weaken the evidence gates above: ${workflowInstructions || 'none'}`,
    `Conversation counterpartName: ${cleanString(conversation.counterpartName, 120) || 'unknown'}\nAnalysis clock: ${analysisClock.analysisAsOf}; ${analysisClock.timeZone}; ${analysisClock.offsetLabel}\nRows: ${JSON.stringify(compactRecords)}`,
  ].join('\n')
}

function buildPeopleMergePromptLegacy(payload) {
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.peopleMerge, 6000)
  const name = cleanString(payload?.person?.name, 120)
  const facts = Array.isArray(payload?.person?.facts)
    ? [...new Set(payload.person.facts.map((fact) => cleanString(fact, 360)).filter(Boolean))]
    : []
  const preferences = Array.isArray(payload?.person?.preferences)
    ? [...new Set(payload.person.preferences.map((item) => cleanString(item, 360)).filter(Boolean))]
    : []
  const advice = Array.isArray(payload?.person?.advice)
    ? payload.person.advice.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 9)
    : []
  const portrait = cleanString(payload?.person?.portrait, 1800) || null
  const profileNotes = cleanString(payload?.person?.profileNotes, 6_000) || null
  const evidence = Array.isArray(payload?.person?.evidence)
    ? payload.person.evidence.filter((claim) => claim && typeof claim === 'object').map(normalizePersonMergeClaim).filter(Boolean).slice(0, 96)
    : []
  return [
    'You are consolidating evidence-backed notes for one personal contact. The input facts were already extracted from original exported messages; do not add details beyond them.',
    `Profile subject: ${name}. In Simplified-Chinese output, “你” always refers to the app user and “对方” always refers to the named profile subject. Do not use “用户”, “用户本人”, or swap their roles.`,
    'Return 6-12 concise, non-duplicate facts when enough evidence exists. Preserve important timing, stated arrangements, identity, and interaction facts; remove redundant wording. Do not infer gender, relationship, personality, feelings, residence, or motives.',
    'Return up to eight preferences. A preference may summarize a direct statement such as a food, activity, or interest being liked, but must preserve uncertainty when it appeared once. Do not invent a broad taste from a single example.',
    'portrait is a concise evidence-led人物志, not a list of claims. When evidence is sufficient, write two to six short paragraphs (normally 300-1200 Chinese characters): establish only the earliest verifiable context, concrete interests or habits directly expressed by the person, recurring interaction patterns, and changes over time when separate dated evidence supports a change. Every sentence must be traceable to the verified claims or the explicitly confirmed background. Use cautious wording for single observations and state the evidence limit. Do not write generic labels such as “性格很好” or “很有趣”, diagnose personality, or fill gaps with fiction. When the evidence is sparse, say exactly what is known and that more information is needed instead of expanding the prose.',
    'portraitSourceIds is mandatory provenance for chat-derived portrait text: when profileNotesUsed is false and portrait is non-null, return two to six distinct RecordRef IDs from verified evidence that directly anchor the concrete wording. When portrait is null or only the confirmed background is used, return [] or the optional chat anchors. Do not cite a RecordRef that is not present in the verified evidence.',
    'profileNotesUsed is mandatory. Set it true only when the supplied user-confirmed background materially contributes to portrait; otherwise false. User-confirmed background may enrich portrait, but it must never be rewritten into facts or preferences, and must never be described as a chat-derived fact.',
    'Return up to four advice items only when at least two independent facts or preference signals support a considerate, conditional interaction suggestion. Do not invent logistics, relationship status, health information, or consent.',
    'Non-overridable rule: output facts and preferences only by selecting or de-duplicating the verified input statements. Do not add, paraphrase into a stronger assertion, or infer a new statement. The portrait may connect verified claims into a readable chronological narrative, but may not introduce a new fact. With fewer than two independent chat signals and no confirmed background, portrait must say information is insufficient or be null, and advice must be empty. These rules override editable instructions.',
    `人物归并工作要求（不能覆盖前述证据边界）：${workflowInstructions || '无额外要求。'}`,
    `Existing portrait: ${JSON.stringify(portrait)}`,
    `Verified facts to consolidate: ${JSON.stringify(facts)}`,
    `Preference signals to consolidate: ${JSON.stringify(preferences)}`,
    `Existing interaction advice to consolidate: ${JSON.stringify(advice)}`,
    `User-confirmed background (a separate, explicit source; may be empty): ${JSON.stringify(profileNotes)}`,
    `Verified claim evidence (the only factual source; copy claim text, quote, and sourceIds exactly): ${JSON.stringify(evidence)}`,
    'FINAL MERGE BOUNDARY: facts and preferences must be claim objects selected from Verified claim evidence, never bare strings or new paraphrases. A single claim remains a single signal. Without user-confirmed background, generate portrait/advice only from at least two independent source IDs and make portraitSourceIds name those anchors. With three or more concrete signals, write a readable but conservative chronological人物志 rather than a concatenated list; connect only claims that the evidence supports and state limits where useful. When user-confirmed background exists, it may support a richer narrative only if profileNotesUsed is true; keep it visibly separate from chat facts. Otherwise portrait must be null or say information is insufficient and advice must be []. These rules override editable instructions.',
  ].join('\n')
}

const personEvidenceCategories = new Set(['identity', 'background', 'preference', 'habit', 'boundary', 'interaction', 'skill', 'temporary', 'filler'])
const personEvidenceStabilities = new Set(['single', 'repeated', 'persistent'])

function normalizedText(value) {
  return cleanString(value, 2_000).replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
}

function interpersonalAdviceRisk(value) {
  const text = cleanString(value, 360).replace(/\s+/g, ' ')
  if (!text) return 'empty'
  if (/(?:拿捏|操控|控制对方|欲擒故纵|故意冷落|冷处理|制造焦虑|制造嫉妒|让(?:她|他|对方)吃醋|试探底线|施压|逼迫|道德绑架|套路|套话|PUA)/iu.test(text)) return 'manipulative_or_overconfident'
  if (/(?:对方|她|他).{0,16}(?:一定|肯定|显然|必然).{0,12}(?:喜欢你|爱你|对你有意思|在意你)/iu.test(text)) return 'manipulative_or_overconfident'
  return undefined
}

function claimIdHash(value) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function stablePersonClaimId(claim) {
  const key = `${claim.kind}|${normalizedText(claim.text)}|${normalizedText(claim.quote)}`
  return `claim-${claimIdHash(key)}`
}

function normalizePersonMergeClaim(claim) {
  const text = cleanString(claim?.text, 360)
  const quote = cleanString(claim?.quote, 120)
  const sourceIds = Array.isArray(claim?.sourceIds)
    ? [...new Set(claim.sourceIds.map(String).filter(Boolean))].slice(0, 12)
    : []
  if (!text || !quote || !sourceIds.length) return null
  const category = personEvidenceCategories.has(claim?.category) ? claim.category : 'background'
  const stability = personEvidenceStabilities.has(claim?.stability)
    ? claim.stability
    : claim?.evidenceStrength === 'repeated' ? 'repeated' : 'single'
  const kind = claim?.kind === 'preference' ? 'preference' : claim?.kind === 'event' ? 'event' : 'fact'
  const id = cleanString(claim?.id, 100) || stablePersonClaimId({ kind, text, quote, sourceIds })
  return {
    id,
    kind,
    text,
    quote,
    sourceIds,
    category,
    stability,
    evidenceStrength: stability === 'single' ? 'single' : 'repeated',
    importanceScore: Number.isFinite(Number(claim?.importanceScore)) ? Math.max(0, Math.min(10, Number(claim.importanceScore))) : null,
    portraitEligible: claim?.portraitEligible !== false && category !== 'temporary' && category !== 'filler',
    firstObservedAt: cleanString(claim?.firstObservedAt, 80) || null,
    lastObservedAt: cleanString(claim?.lastObservedAt, 80) || null,
  }
}

const personPortraitPipelineVersion = 5
const personPortraitRecentWindowDays = 30
const dayMs = 24 * 60 * 60 * 1000

function validIsoTimestamp(value, fallback = null) {
  const timestamp = new Date(cleanString(value, 80)).getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

function personClaimTemporalScope(claim, analysisAsOf) {
  const asOf = new Date(analysisAsOf).getTime()
  const observed = new Date(claim?.lastObservedAt || claim?.firstObservedAt || '').getTime()
  if (!Number.isFinite(asOf) || !Number.isFinite(observed)) return 'undated'
  return observed >= asOf - personPortraitRecentWindowDays * dayMs ? 'recent' : 'historical'
}

function personMergeTemporalSummary(evidence, analysisAsOf, latestInteractionAt) {
  const eligible = evidence.filter((claim) => claim.portraitEligible !== false && claim.category !== 'temporary' && claim.category !== 'filler')
  const recent = eligible.filter((claim) => personClaimTemporalScope(claim, analysisAsOf) === 'recent')
  const historical = eligible.filter((claim) => personClaimTemporalScope(claim, analysisAsOf) === 'historical')
  const undated = eligible.filter((claim) => personClaimTemporalScope(claim, analysisAsOf) === 'undated')
  return {
    analysisAsOf,
    recentWindowDays: personPortraitRecentWindowDays,
    recentCutoffAt: new Date(new Date(analysisAsOf).getTime() - personPortraitRecentWindowDays * dayMs).toISOString(),
    latestInteractionAt: validIsoTimestamp(latestInteractionAt),
    recentClaimCount: recent.length,
    recentSourceCount: new Set(recent.flatMap((claim) => claim.sourceIds)).size,
    historicalClaimCount: historical.length,
    historicalSourceCount: new Set(historical.flatMap((claim) => claim.sourceIds)).size,
    undatedClaimCount: undated.length,
  }
}

function personBlockTemporalMetadata(claims, analysisAsOf) {
  const scopes = new Set(claims.map((claim) => personClaimTemporalScope(claim, analysisAsOf)))
  const timestamps = claims
    .flatMap((claim) => [claim.firstObservedAt, claim.lastObservedAt])
    .map((value) => new Date(value || '').getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  const temporalScope = scopes.has('recent') && scopes.has('historical')
    ? 'change'
    : scopes.has('recent')
      ? 'recent'
      : scopes.has('historical')
        ? 'historical'
        : 'undated'
  return {
    temporalScope,
    observedFrom: timestamps[0] !== undefined ? new Date(timestamps[0]).toISOString() : null,
    observedTo: timestamps.at(-1) !== undefined ? new Date(timestamps.at(-1)).toISOString() : null,
  }
}

function buildPeopleMergePrompt(payload) {
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.peopleMerge, 6000)
  const name = cleanString(payload?.person?.name, 120)
  const facts = Array.isArray(payload?.person?.facts)
    ? [...new Set(payload.person.facts.map((fact) => cleanString(fact, 360)).filter(Boolean))]
    : []
  const preferences = Array.isArray(payload?.person?.preferences)
    ? [...new Set(payload.person.preferences.map((item) => cleanString(item, 360)).filter(Boolean))]
    : []
  const advice = Array.isArray(payload?.person?.advice)
    ? payload.person.advice.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 9)
    : []
  const profileNotes = cleanString(payload?.person?.profileNotes, 6_000) || null
  const evidence = Array.isArray(payload?.person?.evidence)
    ? payload.person.evidence.map(normalizePersonMergeClaim).filter(Boolean).slice(0, 96)
    : []
  const analysisAsOf = validIsoTimestamp(payload?.analysisAsOf, new Date().toISOString())
  const temporalSummary = personMergeTemporalSummary(evidence, analysisAsOf, payload?.latestInteractionAt)
  const temporalEvidence = evidence.map((claim) => ({
    ...claim,
    temporalScope: personClaimTemporalScope(claim, analysisAsOf),
  }))
  const repair = payload?.repair && typeof payload.repair === 'object'
    ? {
      issues: Array.isArray(payload.repair.issues) ? payload.repair.issues.map((item) => cleanString(item, 260)).filter(Boolean).slice(0, 8) : [],
      previousBlocks: Array.isArray(payload.repair.previousBlocks) ? payload.repair.previousBlocks.map((item) => ({
        text: cleanString(item?.text, 500),
        claimIds: Array.isArray(item?.claimIds) ? item.claimIds.map(String).slice(0, 12) : [],
      })).filter((item) => item.text).slice(0, 8) : [],
    }
    : null
  return [
    'You are consolidating one personal contact from a verified claim registry. Write all prose in concise, natural Simplified Chinese.',
    `The profile subject is ${name}. "you" means the app user; "the other person" means the named subject. Never swap speaker roles.`,
    'The registry claims were already checked against exporter-provided messages. The registry is the only factual source. Never invent a name, date, place, relationship, motive, diagnosis, personality label, or event.',
    'Select factClaimIds and preferenceClaimIds from the supplied claim IDs only. Do not write replacement fact strings. Do not select filler or temporary claims as portrait evidence; those claims may remain visible in the evidence archive for other workflows.',
    'A single preference is allowed only with wording that preserves its strength, such as "曾表示对蛋挞有过正向评价". Never turn one mention into "爱吃蛋挞" or a stable habit. Repeated claims can support a cautious habit statement only when the registry marks them repeated or persistent.',
    'Return portraitBlocks as three to six provenance-backed paragraphs that read as one continuous, detailed Chinese人物刻画 when joined. Do not write a claim list, timeline, date heading, evidence report, or disconnected labels. Organize by the person: background, expressed interests, interaction patterns, meaningful episodes, and supported changes or continuity. Use natural transitions such as “早些时候”“后来”“目前” only when the cited claims support them; avoid exact calendar dates in the portrait text. Every concrete sentence must be supported by its cited claims. Use the special claim ID user-profile-notes only when explicitly confirmed background or a dated timeline annotation materially contributes; never copy that source into facts or preferences.',
    `Time is a hard evidence boundary. analysisAsOf=${analysisAsOf}; the locally fixed current window is the last ${personPortraitRecentWindowDays} days, beginning ${temporalSummary.recentCutoffAt}. Each registry claim has temporalScope="recent", "historical", or "undated" computed from its timestamp. Never change or reinterpret that scope.`,
    'Prefer recent claims for the current portrait. If at least two recent eligible claims from at least two source IDs exist, return at least one block citing only recent claims. A block using only historical claims must explicitly read as past observation, using wording such as “曾…”, “当时…”, or “在某段记录中…”. Never present a historical-only preference, habit, boundary, work state, relationship state, or self-description as necessarily true now.',
    'Use separate provenance blocks only when that makes the resulting prose clearer; the renderer will join them without time labels. If later evidence changes, continues, answers, or gives aftermath to an earlier event, connect the two naturally and use reason="change" or reason="trajectory". Mere age difference or a silent interval is not proof of either. Do not discard a dated historical event merely because it was brief: describe its meaning in the continuous portrait and connect only later evidence that actually bears on it. When recent evidence is sparse, do not fill the current portrait with old claims; state that limitation only in coverageNote.',
    'Do not put evidence disclaimers in block text. Phrases such as "证据不足", "信息不足", "无法据此判断", or "需要更多信息" belong only in coverageNote. If a subject area is unsupported, omit it from portraitBlocks.',
    'Use two or more independent chat source IDs for a chat-only portrait. If only one independent signal exists, return no chat portrait block. A user-profile-notes-only portrait is allowed only when profileNotesUsed is true.',
    'Return advice as objects with text and claimIds. Advice is optional and must be conditional, practical, and supported by at least two independent claims. Advice based only on historical claims must explicitly recommend confirming the person\'s current preference or boundary first. Prioritize preserving the other person\'s choice: confirm before assuming, respect explicit boundaries, offer a low-pressure alternative, and suggest listening or a clear next message when useful. Do not infer consent, romance, health needs, cost, route duration, or availability. Never recommend manipulation, jealousy, strategic silence, pressure, testing boundaries, or treating the person as a problem to optimize.',
    'coverageNote is metadata only, up to 240 characters. It may briefly describe covered topics. If recentClaimCount is zero or small, explicitly say that current evidence is absent or limited and historical portrayal may no longer apply; it must never be included in portraitBlocks.',
    `Locally computed temporal coverage: ${JSON.stringify(temporalSummary)}`,
    `Editable style instructions (lower priority than all evidence rules): ${workflowInstructions || 'none'}`,
    `Existing facts (compatibility context only): ${JSON.stringify(facts)}`,
    `Existing preferences (compatibility context only): ${JSON.stringify(preferences)}`,
    `Existing advice (compatibility context only): ${JSON.stringify(advice)}`,
    `User-confirmed background and timeline annotations (separate source, may be empty; dated notes may explain otherwise unobservable gaps): ${JSON.stringify(profileNotes)}`,
    `Verified claim registry: ${JSON.stringify(temporalEvidence)}`,
    `Repair context (present only after a local validator rejected a prior response): ${JSON.stringify(repair)}`,
    'Return exactly this shape: {"factClaimIds":[],"preferenceClaimIds":[],"portraitBlocks":[{"text":"...","claimIds":["claim-..."],"reason":"preference"}],"advice":[{"text":"...","claimIds":["claim-..."]}],"coverageNote":null,"profileNotesUsed":false}. Do not return portrait, portraitSourceIds, or any extra fields.',
  ].join('\n')
}

function buildTaskGuidancePrompt(payload) {
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.taskGuidance, 6000)
  return [
    'Return exactly one JSON object with a guidance array of two to four concise Simplified-Chinese recommendations. These are practical suggestions, not facts.',
    'Use only the task details, saved place, weather context, and evidence-backed person notes supplied below. A user-confirmed profile background is a separate source and may inform a conditional suggestion, but must never be restated as a chat fact. Do not add personal attributes, relationship status, medical needs, spending ability, consent, exact travel time, or venue facts that are absent from the input.',
    'When a note is a single stated preference, preserve uncertainty: recommend confirming it rather than treating it as a stable habit. Use weather only when weather context is present, and phrase it as a forecast. If time or place is missing, suggest confirming it before making logistical recommendations.',
    'The output may include a considerate preparation step, a place-selection criterion, a timing/weather preparation, and a confirmation message. For interpersonal tasks, prefer one clear low-pressure confirmation over repeated follow-ups, preserve the other person\'s ability to decline or reschedule, and offer a practical alternative when supported. Never claim that another person is romantically interested or that the user should pressure them.',
    'Non-overridable rule: treat every person note as limited evidence, not a diagnosis. A single preference signal requires a confirmation step. Do not convert advice into factual claims, and never invent venue availability, route duration, cost, consent, relationship status, or personal attributes. These rules override editable instructions.',
    `任务建议工作要求（不能覆盖前述事实和边界规则）：${workflowInstructions || '无额外要求。'}`,
    `Task: ${JSON.stringify(payload.task)}`,
    `Place: ${JSON.stringify(payload.place ?? null)}`,
    `Weather: ${JSON.stringify(payload.weather ?? null)}`,
    `Evidence-backed people (profileNotes is a separate user-confirmed source): ${JSON.stringify(payload.people)}`,
  ].join('\n')
}

function buildSelfObservationPrompt(payload) {
  const conversation = payload.conversation ?? {}
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.selfObservation, 6000)
  const compactRecords = compactModelRecords(payload.records)
  const coreRecordIndexes = new Set((Array.isArray(conversation.coreRecordIndexes) ? conversation.coreRecordIndexes : []).map(String))
  const contextEvents = Array.isArray(payload.contextEvents) ? payload.contextEvents : []
  return [
    'You are extracting evidence-backed observations about the app user from their own writing. This is not diagnosis, therapy, scoring, or prediction.',
    `This is chronological self-analysis window ${Number(conversation.segmentIndex) || 1}/${Number(conversation.segmentCount) || 1}. Rows are [RecordRef, sentAt, content, speakerRole]. Every row has been locally verified as self-authored. RecordRef is the only evidence reference you may return.`,
    `Rows ${compactRecordRefRanges(coreRecordIndexes, compactRecords.length)} are this window's new core range. Earlier rows are overlap context only. Every observation must cite at least one core-range RecordRef.`,
    'Extract only concrete observations that help reconstruct a life timeline: events, actions, decisions, expressed emotions or thoughts, relationship interactions, routines, stressors, coping attempts, explicit uncertainty, and clearly evidenced changes. A proposed plan, joke, isolated phrase, or one emotional moment is not a stable trait. Preserve time and uncertainty in the wording.',
    'Each observation needs a concise Simplified-Chinese text and one or more evidence items. Each evidence quote must be an exact contiguous substring (2-180 characters) of the cited row. Cite every essential claim. If an observation cannot be expressed without adding an interpretation, omit it.',
    'Never diagnose or label the user with a disorder, personality type, attachment style, trauma, addiction, or other clinical conclusion. Do not infer motives, hidden feelings, risk, gender, relationship status, causes of a gap in contact, or events not stated in the records. Terms such as stress, fatigue, avoidance, rumination, coping, or emotional fluctuation are allowed only as ordinary descriptive observations when the user explicitly describes the relevant experience; no medical claim follows from them.',
    'Authorized context events are contemporaneous background from a device or imported file, not user-authored statements and not evidence. Never cite them as RecordRef, turn them into a reported feeling, infer a cause, diagnosis, medication decision, or hidden motive from them, or claim that they explain a decision. They can only help you keep the chronology straight. Exact locations are intentionally absent.',
    `User-editable self-observation instructions are subordinate to these evidence rules: ${workflowInstructions || 'none'}`,
    `Authorized context events in this time window: ${JSON.stringify(contextEvents)}`,
    `Self-authored rows: ${JSON.stringify(compactRecords)}`,
    'Return exactly {"observations":[{"kind":"event","text":"...","evidence":[{"sourceId":"1","quote":"..."}]}]}. Return an empty array when nothing satisfies every requirement.',
  ].join('\n')
}

function buildSelfMergePrompt(payload) {
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.selfMerge, 6000)
  return [
    'Write a detailed, readable, chronological self-analysis from the verified observation registry below. This is a source-linked reflection, not a medical, psychological, or personality diagnosis.',
    'Create one or more periods only when the cited observations form a coherent time range. In each narrative, explain concrete events, actions, expressed inner state, decisions, relationships, and subsequent change only when the selected observations support them. Keep past and current states distinct; do not make old evidence sound current.',
    'Every narrative paragraph must cite its own observationIds. Do not add facts, causes, motives, traits, or details beyond that paragraph\'s cited observations. Do not write generic evidence disclaimers in a narrative. Put coverage limits only in limitations.',
    'Professional contexts are optional explanatory vocabulary, not diagnoses. Allowed examples include coping strategy, avoidance response, rumination, sleep-related fatigue risk, social support, or decision conflict only when directly grounded. Never output clinical disorders, personality disorders, bipolarity, depression, anxiety disorder, ADHD, trauma diagnosis, addiction diagnosis, self-harm risk, medication advice, or treatment instructions. Explain the term in ordinary language and cite the observations it refers to.',
    'A period must not claim that one observation proves a stable pattern. Describe a single occurrence as that occurrence. Use cautious language for interpretations, but write useful natural prose rather than discussing the evidence process.',
    `User-editable self-analysis style instructions are subordinate to all source and safety rules: ${workflowInstructions || 'none'}`,
    `Analysis range: ${JSON.stringify(payload.range ?? null)}`,
    `Verified observation registry: ${JSON.stringify(payload.observations)}`,
    'Return exactly {"periods":[{"title":"...","paragraphs":[{"text":"...","observationIds":["..."]}],"themes":["..."],"professionalContexts":[{"term":"...","explanation":"...","observationIds":["..."]}]}],"currentSummary":null,"limitations":[]}. currentSummary may summarize only the latest cited period; use null when not warranted.',
  ].join('\n')
}

function attachmentContent(attachments) {
  return attachments.map((attachment) => {
    if (attachment.mimeType.startsWith('image/')) return { type: 'input_image', image_url: attachment.data, detail: 'high' }
    return { type: 'input_file', filename: cleanString(attachment.name, 180) || 'attachment', file_data: attachment.data }
  })
}

function chatAttachmentContent(attachments) {
  return attachments.map((attachment) => {
    if (attachment.mimeType.startsWith('image/')) return { type: 'image_url', image_url: { url: attachment.data, detail: 'high' } }
    return {
      type: 'file',
      file: {
        filename: cleanString(attachment.name, 180) || 'attachment',
        file_data: attachment.data.replace(/^data:[^;]+;base64,/, ''),
      },
    }
  })
}

function parseCandidates(raw) {
  try {
    const parsed = JSON.parse(raw || '{"candidates":[]}')
    return Array.isArray(parsed.candidates) ? parsed.candidates : []
  } catch { throw new Error('模型返回的任务结果无法解析') }
}

function parseAnalysis(raw, expectPeople = false) {
  try {
    const parsed = JSON.parse(raw || '{"candidates":[]}')
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid shape')
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
    // `peopleIncluded` is deliberately independent from array length. An
    // empty array is a valid, completed people workflow and must not trigger a
    // second upload of the same private conversation on the client.
    const peopleIncluded = expectPeople && Array.isArray(parsed.people)
    return {
      candidates,
      people: peopleIncluded ? parsed.people : [],
      peopleIncluded,
    }
  } catch { throw new Error('模型返回的联合提炼结果无法解析') }
}

function parsePeople(raw) {
  try {
    const parsed = JSON.parse(raw || '{"people":[]}')
    return Array.isArray(parsed.people) ? parsed.people : []
  } catch { throw new Error('模型返回的人物结果无法解析') }
}

function parsePersonMerge(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid shape')
    const structured = Array.isArray(parsed.factClaimIds)
      && Array.isArray(parsed.preferenceClaimIds)
      && Array.isArray(parsed.portraitBlocks)
      && Array.isArray(parsed.advice)
    const legacy = Array.isArray(parsed.facts) && Array.isArray(parsed.preferences)
    if (!structured && !legacy) throw new Error('invalid shape')
    return parsed
  } catch { throw new Error('人物信息归并结果无法解析') }
}

function parseSelfObservations(raw) {
  try {
    const parsed = JSON.parse(raw || '{"observations":[]}')
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.observations)) throw new Error('invalid shape')
    return parsed.observations
  } catch { throw new Error('Self-observation result could not be parsed') }
}

function parseSelfMerge(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.periods) || !Array.isArray(parsed.limitations)) throw new Error('invalid shape')
    return parsed
  } catch { throw new Error('Self-analysis consolidation result could not be parsed') }
}

function restoreVerifiedActionOwner(candidates, records) {
  const rolesById = new Map(records.map((record) => [String(record?.id ?? ''), record?.speakerRole]))
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || candidate.actionOwner !== undefined) return candidate
    const sourceIds = Array.isArray(candidate.sourceIds) ? candidate.sourceIds.map(String) : []
    // Some relays fall back to json_object and omit schema-only fields. Filling
    // this field is safe only when the candidate directly cites an exporter-
    // verified message written by the user.
    if (sourceIds.some((id) => rolesById.get(id) === 'self')) return { ...candidate, actionOwner: 'self' }
    return candidate
  })
}

function providerEndpoint(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/+$/, '')}/`)
}

function tokenCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null
}

function normalizeProviderUsage(response) {
  const usage = response?.usage
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = tokenCount(usage.input_tokens ?? usage.prompt_tokens)
  const outputTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens)
  const reportedTotal = tokenCount(usage.total_tokens)
  const cachedInputTokens = tokenCount(
    usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.prompt_cache_hit_tokens,
  )
  const cacheWriteInputTokens = tokenCount(
    usage.input_tokens_details?.cache_creation_tokens
      ?? usage.prompt_tokens_details?.cache_creation_tokens
      ?? usage.cache_creation_input_tokens,
  )
  const reasoningTokens = tokenCount(
    usage.output_tokens_details?.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens,
  )
  if ([inputTokens, outputTokens, reportedTotal, cachedInputTokens, cacheWriteInputTokens, reasoningTokens].every((value) => value === null)) return null
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: reportedTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    cachedInputTokens: cachedInputTokens ?? 0,
    cacheWriteInputTokens: cacheWriteInputTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
  }
}

function providerRuntime(channel) {
  const id = typeof channel === 'string' ? channel : channel?.id
  let runtime = providerRuntimeById.get(id)
  if (!runtime) {
    runtime = {
      activeRequests: 0,
      cooldownUntil: 0,
      lastSelectedSequence: 0,
      lastSelectedAt: 0,
      lastCompletedAt: 0,
      lastErrorAt: 0,
      lastErrorStatus: null,
      lastErrorCode: null,
      authenticationFailedAt: 0,
      consecutiveFailures: 0,
      effectiveMaxConcurrency: null,
      successfulRequests: 0,
      failedRequests: 0,
    }
    providerRuntimeById.set(id, runtime)
  }
  return runtime
}

function configuredProviderConcurrency(channel) {
  return Math.max(1, Math.round(Number(channel?.maxConcurrency) || 1))
}

function transientProviderCooldownMs(error, consecutiveFailures) {
  const failures = Math.max(1, Math.round(Number(consecutiveFailures) || 1))
  const exponential = providerCooldownBaseMs * (2 ** Math.min(3, failures - 1))
  const upstreamHint = Number(error?.retryAfter)
  const upstreamMs = Number.isFinite(upstreamHint) && upstreamHint > 0 ? upstreamHint * 1_000 : 0
  return Math.min(providerCooldownMaxMs, Math.max(exponential, upstreamMs))
}

function providerOriginKey(channel) {
  try {
    const url = new URL(channel?.baseURL)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.origin}${pathname}`.toLowerCase()
  } catch {
    return cleanString(channel?.baseURL, 1000).replace(/\/+$/, '').toLowerCase() || `channel:${channel?.id ?? 'unknown'}`
  }
}

function providerOriginRuntime(channel) {
  const key = providerOriginKey(channel)
  let runtime = providerOriginRuntimeByKey.get(key)
  if (!runtime) {
    runtime = {
      key,
      activeRequests: 0,
      cooldownUntil: 0,
      configuredMaxConcurrency: null,
      effectiveMaxConcurrency: null,
      consecutiveFailures: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastErrorAt: 0,
      lastErrorStatus: null,
    }
    providerOriginRuntimeByKey.set(key, runtime)
  }
  return runtime
}

function configuredProviderOriginConcurrency(channels, channel) {
  const key = providerOriginKey(channel)
  const configuredTotal = channels
    .filter((candidate) => providerOriginKey(candidate) === key)
    .reduce((total, candidate) => total + configuredProviderConcurrency(candidate), 0)
  return Math.max(1, Math.min(sharedOriginConcurrencyDefault, configuredTotal || 1))
}

function effectiveProviderOriginConcurrency(channels, channel, runtime = providerOriginRuntime(channel)) {
  const configured = Math.max(
    1,
    Math.min(
      sharedOriginConcurrencyDefault,
      Math.round(Number(runtime.configuredMaxConcurrency) || configuredProviderOriginConcurrency(channels, channel)),
    ),
  )
  const limited = Math.round(Number(runtime.effectiveMaxConcurrency) || 0)
  return limited > 0 ? Math.max(1, Math.min(configured, limited)) : configured
}

function effectiveProviderConcurrency(channel, runtime = providerRuntime(channel)) {
  const configured = configuredProviderConcurrency(channel)
  const limited = Math.round(Number(runtime.effectiveMaxConcurrency) || 0)
  return limited > 0 ? Math.max(1, Math.min(configured, limited)) : configured
}

function configuredProviderChannels(pool) {
  return pool.channels.filter((channel) => channel.enabled !== false && channel.apiKey && !channel.configurationError)
}

function dispatchableProviderChannels(pool) {
  return configuredProviderChannels(pool).filter((channel) => !providerRuntime(channel).authenticationFailedAt)
}

function providerRuntimeMetadata(channel) {
  const runtime = providerRuntime(channel)
  const originRuntime = providerOriginRuntime(channel)
  const now = Date.now()
  const maxConcurrency = configuredProviderConcurrency(channel)
  const effectiveMaxConcurrency = effectiveProviderConcurrency(channel, runtime)
  const cooldownUntil = Math.max(runtime.cooldownUntil, originRuntime.cooldownUntil)
  const cooldownRemainingMs = Math.max(0, cooldownUntil - now)
  const configured = Boolean(channel.apiKey) && !channel.configurationError
  let status = 'ready'
  if (channel.enabled === false) status = 'disabled'
  else if (channel.configurationError) status = 'invalid'
  else if (!channel.apiKey) status = 'unconfigured'
  else if (runtime.authenticationFailedAt) status = 'authentication-failed'
  else if (cooldownRemainingMs > 0) status = 'cooling-down'
  else if (runtime.activeRequests >= effectiveMaxConcurrency) status = 'at-capacity'
  return {
    status,
    healthy: configured && channel.enabled !== false && !runtime.authenticationFailedAt,
    activeRequests: runtime.activeRequests,
    configuredMaxConcurrency: maxConcurrency,
    effectiveMaxConcurrency,
    availableSlots: status === 'ready' ? Math.max(0, effectiveMaxConcurrency - runtime.activeRequests) : 0,
    cooldownUntil: cooldownRemainingMs > 0 ? new Date(cooldownUntil).toISOString() : null,
    cooldownRemainingMs,
    successfulRequests: runtime.successfulRequests,
    failedRequests: runtime.failedRequests,
    consecutiveFailures: runtime.consecutiveFailures,
    lastSelectedAt: runtime.lastSelectedAt ? new Date(runtime.lastSelectedAt).toISOString() : null,
    lastCompletedAt: runtime.lastCompletedAt ? new Date(runtime.lastCompletedAt).toISOString() : null,
    lastErrorAt: runtime.lastErrorAt ? new Date(runtime.lastErrorAt).toISOString() : null,
    lastErrorStatus: runtime.lastErrorStatus,
    lastErrorCode: runtime.lastErrorCode,
    authenticationFailedAt: runtime.authenticationFailedAt ? new Date(runtime.authenticationFailedAt).toISOString() : null,
  }
}

function rejectProviderQueue(error) {
  while (providerAcquisitionQueue.length) rejectProviderAcquisition(providerAcquisitionQueue.shift(), error)
}

function detachProviderAcquisition(request) {
  request?.signal?.removeEventListener('abort', request.onAbort)
}

function rejectProviderAcquisition(request, error) {
  if (!request) return
  detachProviderAcquisition(request)
  request.reject(error)
}

function resolveProviderAcquisition(request, lease) {
  detachProviderAcquisition(request)
  request.resolve(lease)
}

function noProviderChannelError() {
  const error = new Error('No enabled AI provider channel with a valid API key is configured')
  Object.assign(error, { status: 503, retryAfter: 1, code: 'NO_PROVIDER_CHANNEL' })
  return error
}

function allProviderAuthenticationFailedError() {
  const error = new Error('All enabled AI provider channels were rejected by their upstream service credentials')
  Object.assign(error, { status: 401, code: 'ALL_PROVIDER_AUTH_FAILED' })
  return error
}

function scheduleProviderDispatch(delay = 0) {
  const delayMs = Math.max(0, Math.round(Number(delay) || 0))
  if (delayMs > 0) {
    const dispatchAt = Date.now() + delayMs
    if (providerDispatchTimer && providerDispatchTimerAt <= dispatchAt) return
    if (providerDispatchTimer) clearTimeout(providerDispatchTimer)
    providerDispatchTimerAt = dispatchAt
    providerDispatchTimer = setTimeout(() => {
      providerDispatchTimer = null
      providerDispatchTimerAt = 0
      scheduleProviderDispatch()
    }, delayMs)
    providerDispatchTimer.unref?.()
    return
  }
  if (providerDispatchTimer) {
    clearTimeout(providerDispatchTimer)
    providerDispatchTimer = null
    providerDispatchTimerAt = 0
  }
  if (providerDispatchScheduled) return
  providerDispatchScheduled = true
  queueMicrotask(() => {
    providerDispatchScheduled = false
    void dispatchProviderQueue().catch((error) => {
      rejectProviderQueue(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

async function dispatchProviderQueue() {
  if (providerDispatchInProgress) {
    providerDispatchRequested = true
    return
  }
  providerDispatchInProgress = true
  try {
    do {
      providerDispatchRequested = false
      if (!providerAcquisitionQueue.length) break
      const pool = await loadProviderConfigs()
      const configuredChannels = configuredProviderChannels(pool)
      // Validate every saved credential once before a large queue fans out
      // across all configured slots. A bad key therefore costs one lightweight
      // /models request instead of one failed request per in-flight segment.
      await preflightProviderAuthentication(configuredChannels)
      const channels = dispatchableProviderChannels(pool)
      if (!channels.length) {
        rejectProviderQueue(configuredChannels.length ? allProviderAuthenticationFailedError() : noProviderChannelError())
        break
      }

        while (providerAcquisitionQueue.length) {
          const now = Date.now()
          const available = channels.filter((channel) => {
            const runtime = providerRuntime(channel)
            const originRuntime = providerOriginRuntime(channel)
            originRuntime.configuredMaxConcurrency = configuredProviderOriginConcurrency(channels, channel)
            return runtime.activeRequests < effectiveProviderConcurrency(channel, runtime)
              && originRuntime.activeRequests < effectiveProviderOriginConcurrency(channels, channel, originRuntime)
              && runtime.cooldownUntil <= now
              && originRuntime.cooldownUntil <= now
          })
          if (!available.length) {
            // If capacity is blocked by a short transient cooldown, wake the
            // dispatcher when the earliest cooldown expires. When all slots
            // are simply busy, a release will schedule the next dispatch.
            const nextCooldownAt = channels.reduce((earliest, channel) => {
              const runtime = providerRuntime(channel)
              const originRuntime = providerOriginRuntime(channel)
              const candidate = Math.min(
                runtime.cooldownUntil > now ? runtime.cooldownUntil : Number.POSITIVE_INFINITY,
                originRuntime.cooldownUntil > now ? originRuntime.cooldownUntil : Number.POSITIVE_INFINITY,
              )
              return Math.min(earliest, candidate)
            }, Number.POSITIVE_INFINITY)
            if (Number.isFinite(nextCooldownAt)) scheduleProviderDispatch(Math.min(providerCooldownMaxMs, Math.max(1, nextCooldownAt - now)))
            break
          }

        available.sort((left, right) => {
          const leftRuntime = providerRuntime(left)
          const rightRuntime = providerRuntime(right)
          const loadDifference = (leftRuntime.activeRequests / effectiveProviderConcurrency(left, leftRuntime)) - (rightRuntime.activeRequests / effectiveProviderConcurrency(right, rightRuntime))
          if (loadDifference !== 0) return loadDifference
          if (leftRuntime.lastSelectedSequence !== rightRuntime.lastSelectedSequence) return leftRuntime.lastSelectedSequence - rightRuntime.lastSelectedSequence
          if (left.id === pool.primaryProviderId) return -1
          if (right.id === pool.primaryProviderId) return 1
          return left.id.localeCompare(right.id)
        })
        const provider = available[0]
        const runtime = providerRuntime(provider)
        const originRuntime = providerOriginRuntime(provider)
        originRuntime.configuredMaxConcurrency = configuredProviderOriginConcurrency(channels, provider)
        const request = providerAcquisitionQueue.shift()
        if (request.signal?.aborted) {
          rejectProviderAcquisition(request, cancelledRequestError())
          continue
        }
        runtime.activeRequests += 1
        originRuntime.activeRequests += 1
        runtime.lastSelectedSequence = ++providerSelectionSequence
        runtime.lastSelectedAt = now
        resolveProviderAcquisition(request, { provider, queueWaitMs: Math.max(0, now - request.enqueuedAt) })
      }
    } while (providerDispatchRequested && providerAcquisitionQueue.length)
  } finally {
    providerDispatchInProgress = false
    if (providerDispatchRequested && providerAcquisitionQueue.length) scheduleProviderDispatch()
  }
}

function acquireProviderChannel(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledRequestError())
      return
    }
    const request = { resolve, reject, enqueuedAt: Date.now(), signal, onAbort: undefined }
    request.onAbort = () => {
      const index = providerAcquisitionQueue.indexOf(request)
      if (index >= 0) providerAcquisitionQueue.splice(index, 1)
      rejectProviderAcquisition(request, cancelledRequestError())
    }
    signal?.addEventListener('abort', request.onAbort, { once: true })
    providerAcquisitionQueue.push(request)
    scheduleProviderDispatch()
  })
}

function transientProviderFailure(error) {
  if ([429, 502, 503, 504, 524].includes(Number(error?.status))) return true
  if (['PROVIDER_TIMEOUT', 'PROVIDER_NETWORK_ERROR'].includes(error?.code)) return true
  const attempts = error?.providerMetadata?.attempts
  const lastAttempt = Array.isArray(attempts) ? attempts.at(-1) : null
  return ['gateway', 'network', 'timeout'].includes(lastAttempt?.errorType)
}

function providerAuthenticationFailure(error) {
  const status = Number(error?.status)
  if (status === 401) return true
  if (status !== 403) return false
  const message = `${error?.message ?? ''} ${error?.code ?? ''}`
  return /invalid\s+(?:api\s*)?(?:key|token)|unauthori[sz]ed|authentication|credential/i.test(message)
}

function providerCredentialSignature(provider) {
  return createHash('sha256')
    .update(`${cleanString(provider?.baseURL, 1000)}\u0000${cleanString(provider?.apiKey, 1000)}`)
    .digest('hex')
}

function markProviderAuthenticationFailed(provider, error, source = 'request') {
  const runtime = providerRuntime(provider)
  const firstAuthenticationFailure = !runtime.authenticationFailedAt
  runtime.authenticationFailedAt = runtime.authenticationFailedAt || Date.now()
  runtime.cooldownUntil = 0
  runtime.effectiveMaxConcurrency = null
  if (firstAuthenticationFailure) {
    logAiDebug('provider_channel_authentication_failed', {
      providerChannelId: cleanString(provider?.id, 80) || null,
      providerChannelName: cleanString(provider?.name, 80) || null,
      source,
      status: Number(error?.status) || 401,
      error: cleanString(error instanceof Error ? error.message : 'Provider authentication failed', 500),
      message: 'The channel was removed from runtime dispatch until its configuration is saved again.',
    })
  }
}

async function preflightProviderAuthentication(channels) {
  await Promise.all(channels.map(async (provider) => {
    const signature = providerCredentialSignature(provider)
    const current = providerCredentialProbeById.get(provider.id)
    if (current?.signature === signature) return current.promise

    const probe = { signature, promise: null }
    probe.promise = (async () => {
      try {
        const endpoint = new URL('models', `${provider.baseURL.replace(/\/+$/, '')}/`)
        const response = await fetch(endpoint, {
          headers: {
            authorization: `Bearer ${provider.apiKey}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        })
        await response.body?.cancel().catch(() => undefined)
        if (response.status !== 401 || providerCredentialProbeById.get(provider.id) !== probe) return
        const failure = new Error('The upstream model service rejected this saved API credential during preflight validation')
        Object.assign(failure, { status: 401, code: 'PROVIDER_AUTHENTICATION_FAILED' })
        const runtime = providerRuntime(provider)
        runtime.failedRequests += 1
        runtime.consecutiveFailures += 1
        runtime.lastErrorAt = Date.now()
        runtime.lastErrorStatus = 401
        runtime.lastErrorCode = failure.code
        markProviderAuthenticationFailed(provider, failure, 'credential-preflight')
      } catch {
        // Model listing is not universally supported by compatible relays.
        // Only an explicit 401 is authoritative; normal inference remains the
        // fallback authentication check for every other response or failure.
      }
    })()
    providerCredentialProbeById.set(provider.id, probe)
    return probe.promise
  }))
}

function releaseProviderChannel(provider, error) {
  const runtime = providerRuntime(provider)
  const originRuntime = providerOriginRuntime(provider)
  const now = Date.now()
  runtime.activeRequests = Math.max(0, runtime.activeRequests - 1)
  originRuntime.activeRequests = Math.max(0, originRuntime.activeRequests - 1)
  runtime.lastCompletedAt = now
  if (!error) {
    runtime.successfulRequests += 1
    runtime.consecutiveFailures = 0
    runtime.cooldownUntil = 0
    const configured = configuredProviderConcurrency(provider)
    const effective = effectiveProviderConcurrency(provider, runtime)
    runtime.effectiveMaxConcurrency = effective < configured ? effective + 1 : null
    originRuntime.successfulRequests += 1
    originRuntime.consecutiveFailures = 0
    originRuntime.cooldownUntil = 0
    const originConfigured = Math.max(1, Math.round(Number(originRuntime.configuredMaxConcurrency) || sharedOriginConcurrencyDefault))
    const originEffective = effectiveProviderOriginConcurrency([provider], provider, originRuntime)
    originRuntime.effectiveMaxConcurrency = originEffective < originConfigured ? originEffective + 1 : null
  } else {
    runtime.failedRequests += 1
    runtime.lastErrorAt = now
    runtime.lastErrorStatus = Number(error?.status) || null
    runtime.lastErrorCode = cleanString(error?.code, 80) || null
    if (providerAuthenticationFailure(error)) {
      runtime.consecutiveFailures += 1
      markProviderAuthenticationFailed(provider, error)
    } else if (transientProviderFailure(error)) {
      runtime.consecutiveFailures += 1
      const channelCooldownMs = transientProviderCooldownMs(error, runtime.consecutiveFailures)
      runtime.cooldownUntil = Math.max(runtime.cooldownUntil, now + channelCooldownMs)
      // Preserve configured capacity after a transient failure. The short
      // cooldown prevents a synchronized retry storm without permanently
      // reducing the user's saved channel slots.
      runtime.effectiveMaxConcurrency = null
      originRuntime.failedRequests += 1
      originRuntime.lastErrorAt = now
      originRuntime.lastErrorStatus = Number(error?.status) || null
      originRuntime.consecutiveFailures += 1
      originRuntime.effectiveMaxConcurrency = null
      const originCooldownMs = transientProviderCooldownMs(error, originRuntime.consecutiveFailures)
      originRuntime.cooldownUntil = Math.max(originRuntime.cooldownUntil, now + originCooldownMs)
    } else {
      runtime.consecutiveFailures = 0
      runtime.cooldownUntil = 0
      originRuntime.consecutiveFailures = 0
      originRuntime.cooldownUntil = 0
    }
  }
  scheduleProviderDispatch()
}

async function withProviderChannel(work, signal) {
  while (true) {
    const lease = await acquireProviderChannel(signal)
    try {
      const result = await work(lease.provider, lease)
      releaseProviderChannel(lease.provider)
      return result
    } catch (error) {
      releaseProviderChannel(lease.provider, error)
      if (providerAuthenticationFailure(error) && !signal?.aborted) continue
      throw error
    }
  }
}

function createProviderTrace(provider, queueWaitMs = 0) {
  return {
    channelId: cleanString(provider?.id, 80) || null,
    channelName: cleanString(provider?.name, 80) || null,
    queueWaitMs: Math.max(0, Math.round(Number(queueWaitMs) || 0)),
    attempts: [],
    fallbacks: [],
  }
}

function markProviderFallback(trace, from, to, reason) {
  trace?.fallbacks.push({ from, to, reason, afterAttempt: trace.attempts.length })
}

function providerTraceMetadata(trace) {
  const attempts = Array.isArray(trace?.attempts) ? trace.attempts : []
  const usageEntries = attempts.map((attempt) => attempt.usage).filter(Boolean)
  const usage = usageEntries.length ? usageEntries.reduce((total, entry) => ({
    inputTokens: total.inputTokens + entry.inputTokens,
    outputTokens: total.outputTokens + entry.outputTokens,
    totalTokens: total.totalTokens + entry.totalTokens,
    cachedInputTokens: total.cachedInputTokens + entry.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + entry.cacheWriteInputTokens,
    reasoningTokens: total.reasoningTokens + entry.reasoningTokens,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 }) : null
  const retryAfter = attempts.reduce((maximum, attempt) => Math.max(maximum, Number(attempt.retryAfter) || 0), 0)
  return {
    channelId: trace?.channelId ?? null,
    channelName: trace?.channelName ?? null,
    queueWaitMs: trace?.queueWaitMs ?? 0,
    attemptCount: attempts.length,
    additionalAttemptCount: Math.max(0, attempts.length - 1),
    timeoutMs: providerRequestTimeoutMs,
    fallbackCount: trace?.fallbacks?.length ?? 0,
    fallbacks: trace?.fallbacks ?? [],
    attempts,
    ...(usage ? { usage } : {}),
    ...(retryAfter > 0 ? { retryAfter } : {}),
  }
}

function attachProviderMetadata(error, trace) {
  const failure = error instanceof Error ? error : new Error(String(error))
  failure.providerMetadata = providerTraceMetadata(trace)
  return failure
}

function retryAfterSeconds(value) {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(300, Math.ceil(seconds))
  const date = Date.parse(typeof value === 'string' ? value : '')
  if (!Number.isFinite(date)) return undefined
  return Math.min(300, Math.max(1, Math.ceil((date - Date.now()) / 1000)))
}

async function providerRequest(provider, path, payload, trace, signal) {
  const startedAt = Date.now()
  const requestBody = JSON.stringify(payload)
  const attempt = {
    attempt: (trace?.attempts.length ?? 0) + 1,
    endpoint: path,
    timeoutMs: providerRequestTimeoutMs,
    requestBytes: Buffer.byteLength(requestBody, 'utf8'),
  }
  trace?.attempts.push(attempt)
  let response
  let raw
  try {
    const upstreamSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(providerRequestTimeoutMs)])
      : AbortSignal.timeout(providerRequestTimeoutMs)
    response = await fetch(providerEndpoint(provider.baseURL, path), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: requestBody,
      signal: upstreamSignal,
    })
    raw = await response.text()
    attempt.responseBytes = Buffer.byteLength(raw, 'utf8')
  } catch (error) {
    const cancelled = Boolean(signal?.aborted)
    const timedOut = !cancelled && (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
    Object.assign(attempt, {
      outcome: 'failed',
      status: cancelled ? 499 : timedOut ? 504 : 502,
      errorType: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network',
      durationMs: Date.now() - startedAt,
      ...(timedOut ? { retryAfter: 1 } : {}),
    })
    const failure = cancelled
      ? cancelledRequestError()
      : new Error(timedOut
        ? `模型服务请求超过 ${Math.round(providerRequestTimeoutMs / 1000)} 秒，已终止本次请求`
        : `无法连接模型服务：${cleanString(error instanceof Error ? error.message : String(error), 400)}`)
    Object.assign(failure, {
      status: cancelled ? 499 : timedOut ? 504 : 502,
      retryAfter: timedOut ? 1 : undefined,
      code: cancelled ? 'PROVIDER_CANCELLED' : timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
      providerMetadata: providerTraceMetadata(trace),
    })
    throw failure
  }
  if (!response.ok) {
    let message = raw
    let retryAfter = retryAfterSeconds(response.headers.get('retry-after'))
    try {
      const parsed = JSON.parse(raw)
      message = cleanString(parsed?.error?.message || parsed?.message || raw, 1200)
      retryAfter = retryAfterSeconds(parsed?.retry_after ?? parsed?.error?.retry_after) ?? retryAfter
    } catch { /* use the raw response */ }
    Object.assign(attempt, {
      outcome: 'failed',
      status: response.status,
      errorType: [502, 503, 504, 524].includes(response.status) ? 'gateway' : 'http',
      durationMs: Date.now() - startedAt,
      ...(retryAfter ? { retryAfter } : {}),
    })
    const failure = new Error(message || `模型请求失败 (${response.status})`)
    Object.assign(failure, { status: response.status, retryAfter, providerMetadata: providerTraceMetadata(trace) })
    throw failure
  }
  try {
    const parsed = JSON.parse(raw)
    const usage = normalizeProviderUsage(parsed)
    Object.assign(attempt, {
      outcome: 'succeeded',
      status: response.status,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
    })
    return parsed
  } catch {
    Object.assign(attempt, { outcome: 'failed', status: response.status, errorType: 'invalid-json', durationMs: Date.now() - startedAt })
    const failure = new Error('模型服务返回的不是有效 JSON')
    failure.providerMetadata = providerTraceMetadata(trace)
    throw failure
  }
}

function responseOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text
  const output = Array.isArray(response?.output) ? response.output : []
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const part of content) {
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.output_text === 'string') return part.output_text
    }
  }
  return ''
}

async function analyzeWithResponses(provider, model, payload, trace, signal) {
  const includePeople = payload.workflows?.people === true && payload.conversation?.kind === 'direct'
  const content = [{ type: 'input_text', text: buildPrompt(payload) }, ...attachmentContent(payload.attachments)]
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content }],
    text: { format: includePeople ? combinedResponseFormat : responseFormat },
    // Task candidates are deliberately concise. A smaller output budget keeps
    // a full long-conversation request from reserving an unnecessarily large
    // generation on compatibility relays.
    max_output_tokens: includePeople ? 3_200 : 3_000,
  }, trace, signal)
  return parseAnalysis(responseOutputText(response), includePeople)
}

async function analyzeWithChat(provider, model, payload, trace, signal) {
  const includePeople = payload.workflows?.people === true && payload.conversation?.kind === 'direct'
  const content = [{ type: 'text', text: `${buildPrompt(payload)}\n只返回符合指定 JSON Schema 的 JSON 对象，不要添加 Markdown。` }, ...chatAttachmentContent(payload.attachments)]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: includePeople ? combinedChatResponseFormat : chatResponseFormat,
      max_tokens: includePeople ? 3_200 : 3_000,
    }, trace, signal)
    return parseAnalysis(response?.choices?.[0]?.message?.content || '', includePeople)
  } catch (error) {
    if (!canFallbackToJsonObject(error)) throw error
    markProviderFallback(trace, 'chat-completions/json-schema', 'chat-completions/json-object', 'structured-output-unsupported')
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: includePeople ? 3_200 : 3_000,
    }, trace, signal)
    return parseAnalysis(response?.choices?.[0]?.message?.content || '', includePeople)
  }
}

async function analyzePeopleWithResponses(provider, model, payload, trace, signal) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildPeoplePrompt(payload) }] }],
    text: { format: peopleResponseFormat },
    // Segment work emits only a bounded set of cited claims. Reserving a large
    // portrait-sized output here costs latency without improving evidence.
    max_output_tokens: 2_400,
  }, trace, signal)
  return parsePeople(responseOutputText(response))
}

async function analyzePeopleWithChat(provider, model, payload, trace, signal) {
  const content = [{ type: 'text', text: `${buildPeoplePrompt(payload)}\n只返回符合指定 JSON Schema 的 JSON 对象，不要添加 Markdown。` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: peopleChatResponseFormat,
      max_tokens: 2_400,
    }, trace, signal)
    return parsePeople(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (!canFallbackToJsonObject(error)) throw error
    markProviderFallback(trace, 'chat-completions/json-schema', 'chat-completions/json-object', 'structured-output-unsupported')
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 2_400,
    }, trace, signal)
    return parsePeople(response?.choices?.[0]?.message?.content || '')
  }
}

async function mergePeopleWithResponses(provider, model, payload, trace, signal) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildPeopleMergePrompt(payload) }] }],
    text: { format: personMergeResponseFormat },
    // The one full-evidence pass is where a careful portrait is produced.
    // Give it enough room to select claims and still reason conservatively.
    max_output_tokens: 2_600,
  }, trace, signal)
  return parsePersonMerge(responseOutputText(response))
}

async function mergePeopleWithChat(provider, model, payload, trace, signal) {
  const content = [{ type: 'text', text: `${buildPeopleMergePrompt(payload)}\nReturn only the requested JSON object, without Markdown.` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: personMergeChatResponseFormat,
      max_tokens: 2_600,
    }, trace, signal)
    return parsePersonMerge(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (!canFallbackToJsonObject(error)) throw error
    markProviderFallback(trace, 'chat-completions/json-schema', 'chat-completions/json-object', 'structured-output-unsupported')
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 2_600,
    }, trace, signal)
    return parsePersonMerge(response?.choices?.[0]?.message?.content || '')
  }
}

async function observeSelfWithResponses(provider, model, payload, trace, signal) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildSelfObservationPrompt(payload) }] }],
    text: { format: selfObservationResponseFormat },
    max_output_tokens: 2_400,
  }, trace, signal)
  return parseSelfObservations(responseOutputText(response))
}

async function observeSelfWithChat(provider, model, payload, trace, signal) {
  const content = [{ type: 'text', text: `${buildSelfObservationPrompt(payload)}\nReturn only the requested JSON object, without Markdown.` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model, messages: [{ role: 'user', content }], response_format: selfObservationChatResponseFormat, max_tokens: 2_400,
    }, trace, signal)
    return parseSelfObservations(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (!canFallbackToJsonObject(error)) throw error
    markProviderFallback(trace, 'chat-completions/json-schema', 'chat-completions/json-object', 'structured-output-unsupported')
    const response = await providerRequest(provider, 'chat/completions', {
      model, messages: [{ role: 'user', content }], response_format: { type: 'json_object' }, max_tokens: 2_400,
    }, trace, signal)
    return parseSelfObservations(response?.choices?.[0]?.message?.content || '')
  }
}

async function mergeSelfWithResponses(provider, model, payload, trace, signal) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildSelfMergePrompt(payload) }] }],
    text: { format: selfMergeResponseFormat },
    max_output_tokens: 3_200,
  }, trace, signal)
  return parseSelfMerge(responseOutputText(response))
}

async function mergeSelfWithChat(provider, model, payload, trace, signal) {
  const content = [{ type: 'text', text: `${buildSelfMergePrompt(payload)}\nReturn only the requested JSON object, without Markdown.` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model, messages: [{ role: 'user', content }], response_format: selfMergeChatResponseFormat, max_tokens: 3_200,
    }, trace, signal)
    return parseSelfMerge(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (!canFallbackToJsonObject(error)) throw error
    markProviderFallback(trace, 'chat-completions/json-schema', 'chat-completions/json-object', 'structured-output-unsupported')
    const response = await providerRequest(provider, 'chat/completions', {
      model, messages: [{ role: 'user', content }], response_format: { type: 'json_object' }, max_tokens: 3_200,
    }, trace, signal)
    return parseSelfMerge(response?.choices?.[0]?.message?.content || '')
  }
}

function parseTaskGuidance(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    return Array.isArray(parsed?.guidance) ? parsed.guidance : []
  } catch { throw new Error('Task guidance result could not be parsed') }
}

async function taskGuidanceWithResponses(provider, model, payload, trace, signal) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildTaskGuidancePrompt(payload) }] }],
    text: { format: taskGuidanceResponseFormat },
    max_output_tokens: 1_200,
  }, trace, signal)
  return parseTaskGuidance(responseOutputText(response))
}

async function taskGuidanceWithChat(provider, model, payload, trace, signal) {
  const content = [{ type: 'text', text: `${buildTaskGuidancePrompt(payload)}\nReturn only the requested JSON object, without Markdown.` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: taskGuidanceChatResponseFormat,
      max_tokens: 1_200,
    }, trace, signal)
    return parseTaskGuidance(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (!canFallbackToJsonObject(error)) throw error
    markProviderFallback(trace, 'chat-completions/json-schema', 'chat-completions/json-object', 'structured-output-unsupported')
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 1_200,
    }, trace, signal)
    return parseTaskGuidance(response?.choices?.[0]?.message?.content || '')
  }
}

function canFallbackToChat(error) {
  // Auto mode may recover when a relay does not implement the Responses API.
  // Gateway failures must be retried as the same request by the caller; sending
  // the same large prompt to Chat Completions would double latency and tokens.
  const status = Number(error?.status)
  const message = error instanceof Error ? error.message : ''
  // NewAPI-style relays sometimes return HTTP 500 while decoding a Responses
  // tool/output item. This is a protocol incompatibility, not a transient
  // model failure, so `auto` must switch protocols immediately.
  if (status === 500 && /cannot unmarshal object into Go struct field .*?(?:tools|ResponsesOutputContent|content)/i.test(message)) return true
  if ([404, 405, 415, 501].includes(status)) return true
  const explicitlyUnsupported = /(?:responses|endpoint|route|url|text[._ ]?format|json[._ ]?schema|structured output)/i.test(message)
    && /(?:not found|unsupported|not implemented|unknown|invalid|does not support)/i.test(message)
  if ([400, 422].includes(status)) return explicitlyUnsupported
  return !Number.isFinite(status) && explicitlyUnsupported
}

function canFallbackToJsonObject(error) {
  const status = Number(error?.status)
  const message = error instanceof Error ? error.message : ''
  if (status === 500 && /cannot unmarshal object into Go struct field .*?(?:tools|ResponsesOutputContent|content)/i.test(message)) return true
  if (![400, 422].includes(status)) return false
  return /(?:response[._ ]?format|json[._ ]?schema|structured output|schema)/i.test(message)
    && /(?:unsupported|not implemented|unknown|invalid|does not support)/i.test(message)
}

function preferredAutoMode(provider) {
  return provider.apiMode === 'auto' ? providerApiModeById.get(provider.id) ?? 'responses' : provider.apiMode
}

function rememberAutoMode(provider, mode) {
  if (provider.apiMode === 'auto') providerApiModeById.set(provider.id, mode)
}

async function analyze(payload, signal) {
  validatePayload(payload)
  return withProviderChannel(async (provider, lease) => {
    const trace = createProviderTrace(provider, lease.queueWaitMs)
    let analysis
    let apiModeUsed = provider.apiMode
    try {
      const preferredMode = preferredAutoMode(provider)
      if (preferredMode === 'responses') {
        try {
          analysis = await analyzeWithResponses(provider, provider.model, payload, trace, signal)
          rememberAutoMode(provider, 'responses')
          apiModeUsed = 'responses'
        } catch (error) {
          if (provider.apiMode !== 'auto' || !canFallbackToChat(error)) throw error
          markProviderFallback(trace, 'responses', 'chat-completions', 'responses-protocol-incompatible')
          rememberAutoMode(provider, 'chat-completions')
          analysis = await analyzeWithChat(provider, provider.model, payload, trace, signal)
          apiModeUsed = 'chat-completions'
        }
      } else if (preferredMode === 'chat-completions') {
        analysis = await analyzeWithChat(provider, provider.model, payload, trace, signal)
        rememberAutoMode(provider, 'chat-completions')
        apiModeUsed = 'chat-completions'
      } else {
        throw new Error(`Unsupported provider API mode: ${preferredMode}`)
      }
    } catch (error) {
      throw attachProviderMetadata(error, trace)
    }
    const candidates = restoreVerifiedActionOwner(
      restoreRecordReferences(analysis.candidates, payload.records),
      payload.records,
    )
    // The client still verifies exact quotations, sender direction, names, and
    // core-range evidence before it saves any person claim. Restoring the
    // compact RecordRefs here merely lets it run those checks against the
    // original local archive without a second provider request.
    const people = restoreRecordReferences(analysis.people, payload.records)
    return {
      model: provider.model,
      apiModeUsed,
      candidates,
      people,
      peopleIncluded: analysis.peopleIncluded,
      receivedRecordCount: payload.records.length,
      metadata: { provider: providerTraceMetadata(trace) },
    }
  }, signal)
}

async function analyzePeopleRecords(payload, signal) {
  validatePayload(payload)
  return withProviderChannel(async (provider, lease) => {
    const trace = createProviderTrace(provider, lease.queueWaitMs)
    let people
    let apiModeUsed = provider.apiMode
    try {
      const preferredMode = preferredAutoMode(provider)
      if (preferredMode === 'responses') {
        try {
          people = await analyzePeopleWithResponses(provider, provider.model, payload, trace, signal)
          rememberAutoMode(provider, 'responses')
          apiModeUsed = 'responses'
        } catch (error) {
          if (provider.apiMode !== 'auto' || !canFallbackToChat(error)) throw error
          markProviderFallback(trace, 'responses', 'chat-completions', 'responses-protocol-incompatible')
          rememberAutoMode(provider, 'chat-completions')
          people = await analyzePeopleWithChat(provider, provider.model, payload, trace, signal)
          apiModeUsed = 'chat-completions'
        }
      } else if (preferredMode === 'chat-completions') {
        people = await analyzePeopleWithChat(provider, provider.model, payload, trace, signal)
        rememberAutoMode(provider, 'chat-completions')
        apiModeUsed = 'chat-completions'
      } else {
        throw new Error(`Unsupported provider API mode: ${preferredMode}`)
      }
    } catch (error) {
      throw attachProviderMetadata(error, trace)
    }
    return {
      model: provider.model,
      apiModeUsed,
      people: restoreRecordReferences(people, payload.records),
      receivedRecordCount: payload.records.length,
      metadata: { provider: providerTraceMetadata(trace) },
    }
  }, signal)
}

function restoreSelfObservationReferences(observations, records) {
  const idsByReference = new Map(records.map((record, index) => [String(index + 1), String(record?.id ?? '')]))
  return (Array.isArray(observations) ? observations : []).map((observation) => ({
    ...observation,
    evidence: Array.isArray(observation?.evidence)
      ? observation.evidence.map((item) => ({ ...item, sourceId: idsByReference.get(String(item?.sourceId)) || String(item?.sourceId ?? '') }))
      : [],
  }))
}

function validateSelfObservationPayload(payload) {
  validatePayload(payload)
  if (payload.analysisTarget !== 'self') throw new Error('Self-analysis target must be explicit')
  if (!payload.records.every((record) => record?.speakerRole === 'self')) {
    throw new Error('Self analysis accepts only locally verified self-authored records')
  }
  const allowedKinds = new Set(['calendar', 'location', 'movement', 'screen-time', 'activity', 'health', 'payment', 'device', 'custom'])
  const allowedSources = new Set(['selene'])
  const contextEvents = Array.isArray(payload.contextEvents)
    ? payload.contextEvents.filter((item) => item && typeof item === 'object' && allowedSources.has(item.source)).map((item) => {
      const values = item.values && typeof item.values === 'object' && !Array.isArray(item.values)
        ? Object.fromEntries(Object.entries(item.values).flatMap(([key, value]) => {
          if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || /(?:^|[_.-])(?:lat(?:itude)?|lng|lon(?:gitude)?|coord(?:inate)?s?|address|geohash)(?:$|[_.-])/i.test(key)) return []
          if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return [[key, value]]
          const text = cleanString(value, 800)
          return text ? [[key, text]] : []
        }).slice(0, 48))
        : undefined
      const startAt = validIsoTimestamp(item.startAt)
      const endAt = validIsoTimestamp(item.endAt)
      return {
        id: cleanString(item.id, 160),
        kind: allowedKinds.has(item.kind) ? item.kind : 'custom',
        source: 'selene',
        startAt,
        ...(endAt && (!startAt || Date.parse(endAt) >= Date.parse(startAt)) ? { endAt } : {}),
        title: cleanString(item.kind === 'location' ? 'Location capture' : item.title, 240),
        ...(item.kind === 'location' ? {} : (cleanString(item.summary, 2400) ? { summary: cleanString(item.summary, 2400) } : {})),
        ...(values && Object.keys(values).length ? { values } : {}),
        privacy: 'coarse',
      }
    }).filter((item) => item.id && item.startAt && item.title).slice(0, 180)
    : []
  return { ...payload, contextEvents }
}

function validateSelfMergePayload(payload) {
  const allowedKinds = new Set(['event', 'behavior', 'emotional-state', 'cognition', 'relationship', 'decision', 'routine', 'stressor', 'coping', 'change', 'uncertainty'])
  const observations = Array.isArray(payload?.observations)
    ? payload.observations.filter((item) => item && typeof item === 'object').map((item) => ({
      id: cleanString(item.id, 160),
      kind: allowedKinds.has(item.kind) ? item.kind : 'uncertainty',
      text: cleanString(item.text, 600),
      sourceIds: Array.isArray(item.sourceIds) ? [...new Set(item.sourceIds.map(String).filter(Boolean))].slice(0, 16) : [],
      observedFrom: validIsoTimestamp(item.observedFrom),
      observedTo: validIsoTimestamp(item.observedTo),
    })).filter((item) => item.id && item.text && item.sourceIds.length && item.observedFrom && item.observedTo).slice(0, 180)
    : []
  if (!observations.length) throw new Error('Self-analysis consolidation requires verified observations')
  const range = payload?.range && typeof payload.range === 'object'
    ? { startAt: validIsoTimestamp(payload.range.startAt), endAt: validIsoTimestamp(payload.range.endAt) }
    : null
  return {
    observations,
    range,
    settings: { promptInstructions: { selfMerge: cleanString(payload?.settings?.promptInstructions?.selfMerge, 6000) } },
  }
}

async function analyzeSelfObservations(payload, signal) {
  const normalized = validateSelfObservationPayload(payload)
  return withProviderChannel(async (provider, lease) => {
    const trace = createProviderTrace(provider, lease.queueWaitMs)
    let observations
    let apiModeUsed = provider.apiMode
    try {
      const preferredMode = preferredAutoMode(provider)
      if (preferredMode === 'responses') {
        try {
          observations = await observeSelfWithResponses(provider, provider.model, normalized, trace, signal)
          rememberAutoMode(provider, 'responses')
          apiModeUsed = 'responses'
        } catch (error) {
          if (provider.apiMode !== 'auto' || !canFallbackToChat(error)) throw error
          markProviderFallback(trace, 'responses', 'chat-completions', 'responses-protocol-incompatible')
          rememberAutoMode(provider, 'chat-completions')
          observations = await observeSelfWithChat(provider, provider.model, normalized, trace, signal)
          apiModeUsed = 'chat-completions'
        }
      } else if (preferredMode === 'chat-completions') {
        observations = await observeSelfWithChat(provider, provider.model, normalized, trace, signal)
        rememberAutoMode(provider, 'chat-completions')
        apiModeUsed = 'chat-completions'
      } else throw new Error(`Unsupported provider API mode: ${preferredMode}`)
    } catch (error) { throw attachProviderMetadata(error, trace) }
    return {
      model: provider.model,
      apiModeUsed,
      observations: restoreSelfObservationReferences(observations, normalized.records),
      receivedRecordCount: normalized.records.length,
      metadata: { provider: providerTraceMetadata(trace) },
    }
  }, signal)
}

async function analyzeSelfMerge(payload, signal) {
  const normalized = validateSelfMergePayload(payload)
  return withProviderChannel(async (provider, lease) => {
    const trace = createProviderTrace(provider, lease.queueWaitMs)
    let result
    let apiModeUsed = provider.apiMode
    try {
      const preferredMode = preferredAutoMode(provider)
      if (preferredMode === 'responses') {
        try {
          result = await mergeSelfWithResponses(provider, provider.model, normalized, trace, signal)
          rememberAutoMode(provider, 'responses')
          apiModeUsed = 'responses'
        } catch (error) {
          if (provider.apiMode !== 'auto' || !canFallbackToChat(error)) throw error
          markProviderFallback(trace, 'responses', 'chat-completions', 'responses-protocol-incompatible')
          rememberAutoMode(provider, 'chat-completions')
          result = await mergeSelfWithChat(provider, provider.model, normalized, trace, signal)
          apiModeUsed = 'chat-completions'
        }
      } else if (preferredMode === 'chat-completions') {
        result = await mergeSelfWithChat(provider, provider.model, normalized, trace, signal)
        rememberAutoMode(provider, 'chat-completions')
        apiModeUsed = 'chat-completions'
      } else throw new Error(`Unsupported provider API mode: ${preferredMode}`)
    } catch (error) { throw attachProviderMetadata(error, trace) }
    return { model: provider.model, apiModeUsed, ...result, metadata: { provider: providerTraceMetadata(trace) } }
  }, signal)
}

function validatePeopleMergePayload(payload) {
  const name = cleanString(payload?.person?.name, 120)
  const evidence = Array.isArray(payload?.person?.evidence)
    ? payload.person.evidence.filter((claim) => claim && typeof claim === 'object').map((claim) => ({
      // Preserve the client-generated stable evidence id. The merge response
      // only selects these ids; dropping it here makes every returned claim
      // impossible to resolve after validation.
      id: cleanString(claim.id, 160) || stablePersonClaimId({
        kind: claim.kind === 'preference' ? 'preference' : claim.kind === 'event' ? 'event' : 'fact',
        text: cleanString(claim.text, 360),
        quote: cleanString(claim.quote, 120),
        sourceIds: Array.isArray(claim.sourceIds) ? claim.sourceIds : [],
      }),
      kind: claim.kind === 'preference' ? 'preference' : claim.kind === 'event' ? 'event' : 'fact',
      text: cleanString(claim.text, 360),
      quote: cleanString(claim.quote, 120),
      sourceIds: Array.isArray(claim.sourceIds) ? [...new Set(claim.sourceIds.map(String).filter(Boolean))].slice(0, 12) : [],
      evidenceStrength: claim.evidenceStrength === 'repeated' ? 'repeated' : 'single',
      category: personEvidenceCategories.has(claim.category) ? claim.category : 'background',
      stability: personEvidenceStabilities.has(claim.stability)
        ? claim.stability
        : claim.evidenceStrength === 'repeated' ? 'repeated' : 'single',
      importanceScore: Number.isFinite(Number(claim.importanceScore))
        ? Math.max(0, Math.min(10, Number(claim.importanceScore)))
        : null,
      portraitEligible: claim.portraitEligible !== false
        && claim.category !== 'temporary'
        && claim.category !== 'filler',
      firstObservedAt: cleanString(claim.firstObservedAt, 80) || null,
      lastObservedAt: cleanString(claim.lastObservedAt, 80) || null,
    })).filter((claim) => claim.text && claim.quote && claim.sourceIds.length).slice(0, 96)
    : []
  const facts = Array.isArray(payload?.person?.facts)
    ? [...new Set(payload.person.facts.map((fact) => cleanString(fact, 360)).filter(Boolean))]
    : []
  const preferences = Array.isArray(payload?.person?.preferences)
    ? [...new Set(payload.person.preferences.map((item) => cleanString(item, 360)).filter(Boolean))]
    : []
  const advice = Array.isArray(payload?.person?.advice)
    ? payload.person.advice.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 9)
    : []
  const profileNotes = cleanString(payload?.person?.profileNotes, 6_000) || null
  const analysisAsOf = validIsoTimestamp(payload?.analysisAsOf, new Date().toISOString())
  const latestInteractionAt = validIsoTimestamp(payload?.latestInteractionAt)
  if (!name || (!evidence.length && facts.length < 2 && !profileNotes)) throw new Error('人物归并至少需要名称和一条已核验引文证据，或用户确认的人物底稿。')
  return {
    person: {
      name,
      evidence,
      facts,
      preferences,
      advice,
      portrait: cleanString(payload?.person?.portrait, 1800) || null,
      profileNotes,
    },
    repair: payload?.repair && typeof payload.repair === 'object'
      ? {
        issues: Array.isArray(payload.repair.issues) ? payload.repair.issues.map((item) => cleanString(item, 260)).filter(Boolean).slice(0, 8) : [],
        previousBlocks: Array.isArray(payload.repair.previousBlocks) ? payload.repair.previousBlocks.map((item) => ({
          text: cleanString(item?.text, 500),
          claimIds: Array.isArray(item?.claimIds) ? item.claimIds.map(String).slice(0, 12) : [],
        })).filter((item) => item.text).slice(0, 8) : [],
      }
      : null,
    settings: {
      promptInstructions: {
        peopleMerge: cleanString(payload?.settings?.promptInstructions?.peopleMerge, 6000),
      },
    },
    analysisAsOf,
    latestInteractionAt,
  }
}

async function analyzePeopleMerge(payload, signal) {
  const normalized = validatePeopleMergePayload(payload)
  return withProviderChannel(async (provider, lease) => {
    const trace = createProviderTrace(provider, lease.queueWaitMs)
    let result
    let apiModeUsed = provider.apiMode
    try {
      const preferredMode = preferredAutoMode(provider)
      if (preferredMode === 'responses') {
        try {
          result = await mergePeopleWithResponses(provider, provider.model, normalized, trace, signal)
          rememberAutoMode(provider, 'responses')
          apiModeUsed = 'responses'
        } catch (error) {
          if (provider.apiMode !== 'auto' || !canFallbackToChat(error)) throw error
          markProviderFallback(trace, 'responses', 'chat-completions', 'responses-protocol-incompatible')
          rememberAutoMode(provider, 'chat-completions')
          result = await mergePeopleWithChat(provider, provider.model, normalized, trace, signal)
          apiModeUsed = 'chat-completions'
        }
      } else if (preferredMode === 'chat-completions') {
        result = await mergePeopleWithChat(provider, provider.model, normalized, trace, signal)
        rememberAutoMode(provider, 'chat-completions')
        apiModeUsed = 'chat-completions'
      } else {
        throw new Error(`Unsupported provider API mode: ${preferredMode}`)
      }
    } catch (error) {
      throw attachProviderMetadata(error, trace)
    }
    const registry = new Map(normalized.person.evidence.map((claim) => [claim.id, claim]))
    const resolveClaimId = (value, kind) => {
      const candidate = typeof value === 'string' ? value : value && typeof value === 'object' ? value.id : null
      if (candidate && registry.get(String(candidate))?.kind === kind) return String(candidate)
      if (!value || typeof value !== 'object') return null
      const text = normalizedText(value.text)
      const quote = normalizedText(value.quote)
      const match = [...registry.values()].find((claim) => claim.kind === kind && (
        (text && normalizedText(claim.text) === text) || (quote && normalizedText(claim.quote) === quote)
      ))
      return match?.id ?? null
    }
    const normalizeClaimIds = (values, kind, limit) => {
      const source = Array.isArray(values) ? values : []
      return [...new Set(source.map((value) => resolveClaimId(value, kind)).filter((id) => {
        const claim = id ? registry.get(id) : null
        return Boolean(claim)
          && claim.portraitEligible !== false
          && claim.category !== 'temporary'
          && claim.category !== 'filler'
      }))].slice(0, limit)
    }
    const factClaimIds = normalizeClaimIds(result.factClaimIds ?? result.facts, 'fact', 12)
    const preferenceClaimIds = normalizeClaimIds(result.preferenceClaimIds ?? result.preferences, 'preference', 8)
    const manualClaimId = 'user-profile-notes'
    const normalizeBlock = (value) => {
      if (!value || typeof value !== 'object') return null
      const text = cleanString(value.text, 1800)
      const claimIds = [...new Set(Array.isArray(value.claimIds) ? value.claimIds.map(String).filter((id) => {
        if (id === manualClaimId && normalized.person.profileNotes) return true
        const claim = registry.get(id)
        return Boolean(claim)
          && claim.portraitEligible !== false
          && claim.category !== 'temporary'
          && claim.category !== 'filler'
      }) : [])].slice(0, 12)
      const reason = ['background', 'preference', 'habit', 'interaction', 'change', 'trajectory', 'other'].includes(value.reason) ? value.reason : 'other'
      if (!text || !claimIds.length) return null
      const claims = claimIds.map((id) => registry.get(id)).filter(Boolean)
      const sourceIds = [...new Set(claims.flatMap((claim) => claim.sourceIds))].slice(0, 12)
      return { text, claimIds, sourceIds, reason, ...personBlockTemporalMetadata(claims, normalized.analysisAsOf) }
    }
    const portraitBlocks = Array.isArray(result.portraitBlocks)
      ? result.portraitBlocks.map(normalizeBlock).filter(Boolean).slice(0, 8)
      : []
    const normalizeAdvice = (value) => {
      if (!value || typeof value !== 'object') return null
      const text = cleanString(value.text, 360)
      const claimIds = [...new Set(Array.isArray(value.claimIds) ? value.claimIds.map(String).filter((id) => {
        const claim = registry.get(id)
        return Boolean(claim)
          && claim.portraitEligible !== false
          && claim.category !== 'temporary'
          && claim.category !== 'filler'
      }) : [])].slice(0, 8)
      const claims = claimIds.map((id) => registry.get(id)).filter(Boolean)
      const independentSourceCount = new Set(claims.flatMap((claim) => claim.sourceIds)).size
      return text && claimIds.length && independentSourceCount >= 2 && !interpersonalAdviceRisk(text) ? { text, claimIds } : null
    }
    const advice = Array.isArray(result.advice) ? result.advice.map(normalizeAdvice).filter(Boolean).slice(0, 4) : []
    const facts = factClaimIds.map((id) => registry.get(id)).filter(Boolean).map((claim) => ({ text: claim.text, quote: claim.quote, sourceIds: claim.sourceIds }))
    const preferences = preferenceClaimIds.map((id) => registry.get(id)).filter(Boolean).map((claim) => ({ text: claim.text, quote: claim.quote, sourceIds: claim.sourceIds }))
    const portraitSourceIds = [...new Set(portraitBlocks.flatMap((block) => block.sourceIds))].slice(0, 12)
    const portrait = portraitBlocks.map((block) => block.text).join('\n\n') || null
    return {
      model: provider.model,
      apiModeUsed,
      facts,
      preferences,
      factClaimIds,
      preferenceClaimIds,
      advice,
      portrait,
      portraitBlocks,
      portraitSourceIds,
      coverageNote: cleanString(result.coverageNote, 240) || null,
      profileNotesUsed: result.profileNotesUsed === true && portraitBlocks.some((block) => block.claimIds.includes(manualClaimId)),
      portraitSchemaVersion: personPortraitPipelineVersion,
      metadata: { provider: providerTraceMetadata(trace), portraitSchemaVersion: personPortraitPipelineVersion },
    }
  }, signal)
}

function validateTaskGuidancePayload(payload) {
  const task = {
    title: cleanString(payload?.quest?.title, 160),
    description: cleanString(payload?.quest?.description, 900),
    startAt: cleanString(payload?.quest?.startAt, 64) || null,
    dueAt: cleanString(payload?.quest?.dueAt, 64) || null,
  }
  if (!task.title) throw new Error('A task title is required for guidance')
  const placeName = cleanString(payload?.place?.name, 160)
  const lat = Number(payload?.place?.lat)
  const lng = Number(payload?.place?.lng)
  const place = placeName ? {
    name: placeName,
    note: cleanString(payload?.place?.note, 400) || null,
    precision: cleanString(payload?.place?.precision, 32) || null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  } : null
  const people = Array.isArray(payload?.people) ? payload.people.map((person) => ({
    name: cleanString(person?.name, 120),
    facts: Array.isArray(person?.facts) ? person.facts.map((fact) => cleanString(fact, 360)).filter(Boolean).slice(0, 12) : [],
    preferences: Array.isArray(person?.preferences) ? person.preferences.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 8) : [],
    advice: Array.isArray(person?.advice) ? person.advice.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 4) : [],
    portrait: cleanString(person?.portrait, 1800) || null,
    profileNotes: cleanString(person?.profileNotes, 6000) || null,
    profileNotesUsed: person?.profileNotesUsed === true,
  })).filter((person) => person.name).slice(0, 6) : []
  const temperatureMin = Number(payload?.weather?.temperatureMin)
  const temperatureMax = Number(payload?.weather?.temperatureMax)
  const precipitationProbability = Number(payload?.weather?.precipitationProbability)
  const weatherDate = cleanString(payload?.weather?.date, 32)
  const weather = weatherDate ? {
    date: weatherDate,
    condition: cleanString(payload?.weather?.condition, 80) || 'unknown',
    temperatureMin: Number.isFinite(temperatureMin) ? temperatureMin : null,
    temperatureMax: Number.isFinite(temperatureMax) ? temperatureMax : null,
    precipitationProbability: Number.isFinite(precipitationProbability) ? precipitationProbability : null,
  } : null
  return {
    task,
    place,
    people,
    weather,
    settings: {
      promptInstructions: {
        taskGuidance: cleanString(payload?.settings?.promptInstructions?.taskGuidance, 6000),
      },
    },
  }
}

async function analyzeTaskGuidance(payload, signal) {
  const normalized = validateTaskGuidancePayload(payload)
  return withProviderChannel(async (provider, lease) => {
    const trace = createProviderTrace(provider, lease.queueWaitMs)
    let guidance
    let apiModeUsed = provider.apiMode
    try {
      const preferredMode = preferredAutoMode(provider)
      if (preferredMode === 'responses') {
        try {
          guidance = await taskGuidanceWithResponses(provider, provider.model, normalized, trace, signal)
          rememberAutoMode(provider, 'responses')
          apiModeUsed = 'responses'
        } catch (error) {
          if (provider.apiMode !== 'auto' || !canFallbackToChat(error)) throw error
          markProviderFallback(trace, 'responses', 'chat-completions', 'responses-protocol-incompatible')
          rememberAutoMode(provider, 'chat-completions')
          guidance = await taskGuidanceWithChat(provider, provider.model, normalized, trace, signal)
          apiModeUsed = 'chat-completions'
        }
      } else if (preferredMode === 'chat-completions') {
        guidance = await taskGuidanceWithChat(provider, provider.model, normalized, trace, signal)
        rememberAutoMode(provider, 'chat-completions')
        apiModeUsed = 'chat-completions'
      } else {
        throw new Error(`Unsupported provider API mode: ${preferredMode}`)
      }
    } catch (error) {
      throw attachProviderMetadata(error, trace)
    }
    return {
      model: provider.model,
      apiModeUsed,
      guidance: Array.isArray(guidance) ? [...new Set(guidance.map((item) => cleanString(item, 360)).filter(Boolean))].slice(0, 4) : [],
      metadata: { provider: providerTraceMetadata(trace) },
    }
  }, signal)
}

async function probeModels(payload) {
  if (payload?._type && payload._type !== 'newapi_channel_conn') throw new Error('不支持的连接配置类型')
  const current = await loadProviderConfig()
  const apiKey = cleanString(payload?.key, 1000) || current.apiKey
  if (!apiKey) throw new Error('请填写 API Key')
  const baseUrl = normalizeBaseUrl(cleanString(payload?.url, 1000) || current.baseURL)
  const models = await discoverModels({ apiKey, baseURL: baseUrl })
  return { baseUrl, models }
}

function providerPoolStatus(pool) {
  const editable = editableProviderPoolConfig(pool)
  const credentialUseCount = new Map()
  pool.channels.forEach((channel) => {
    if (!channel.apiKey) return
    const signature = providerCredentialSignature(channel)
    credentialUseCount.set(signature, (credentialUseCount.get(signature) ?? 0) + 1)
  })
  const channels = pool.channels.map((channel, index) => ({
    ...editable.channels[index],
    sharedCredentialCount: channel.apiKey ? credentialUseCount.get(providerCredentialSignature(channel)) ?? 1 : 0,
    runtime: providerRuntimeMetadata(channel),
  }))
  const configured = configuredProviderChannels(pool)
  const dispatchable = dispatchableProviderChannels(pool)
  const activeRequests = configured.reduce((total, channel) => total + providerRuntime(channel).activeRequests, 0)
  const originGroups = new Map()
  dispatchable.forEach((channel) => {
    const key = providerOriginKey(channel)
    const group = originGroups.get(key)
    if (group) group.push(channel)
    else originGroups.set(key, [channel])
  })
  const sharedOrigins = [...originGroups.entries()].map(([key, group]) => {
    const runtime = providerOriginRuntime(group[0])
    const now = Date.now()
    const configuredMaxConcurrency = configuredProviderOriginConcurrency(group, group[0])
    runtime.configuredMaxConcurrency = configuredMaxConcurrency
    const effectiveMaxConcurrency = effectiveProviderOriginConcurrency(group, group[0], runtime)
    const cooldownRemainingMs = Math.max(0, runtime.cooldownUntil - now)
    return {
      key,
      channelIds: group.map((channel) => channel.id),
      activeRequests: runtime.activeRequests,
      configuredMaxConcurrency,
      effectiveMaxConcurrency,
      availableCapacity: cooldownRemainingMs > 0 ? 0 : Math.max(0, effectiveMaxConcurrency - runtime.activeRequests),
      cooldownUntil: cooldownRemainingMs > 0 ? new Date(runtime.cooldownUntil).toISOString() : null,
      cooldownRemainingMs,
      successfulRequests: runtime.successfulRequests,
      failedRequests: runtime.failedRequests,
    }
  })
  const availableCapacity = sharedOrigins.reduce((total, origin) => total + origin.availableCapacity, 0)
  const effectiveMaxConcurrency = sharedOrigins.reduce((total, origin) => total + origin.effectiveMaxConcurrency, 0)
  return {
    ...editable,
    // `configured` is consumed by the task controls. It must describe the
    // pool, not only the selected primary channel: a healthy secondary
    // channel is enough to accept and dispatch analysis work.
    configured: dispatchable.length > 0,
    channels,
    scheduler: {
      queueDepth: providerAcquisitionQueue.length,
      activeRequests,
      availableCapacity,
      totalMaxConcurrency: dispatchable.reduce((total, channel) => total + channel.maxConcurrency, 0),
      effectiveMaxConcurrency,
      sharedOriginCount: sharedOrigins.length,
      sharedOrigins,
      coolingDownChannelCount: channels.filter((channel) => providerRuntime(channel).cooldownUntil > Date.now() || providerOriginRuntime(channel).cooldownUntil > Date.now()).length,
      authenticationFailedChannelCount: configured.length - dispatchable.length,
    },
  }
}

async function loadProviderPoolStatus() {
  const pool = await loadProviderConfigs()
  // Status reads stay fast. The first read starts a cached background probe;
  // a later poll exposes any explicit 401 before the user starts extraction.
  void preflightProviderAuthentication(configuredProviderChannels(pool))
    .then(() => scheduleProviderDispatch())
    .catch(() => undefined)
  return providerPoolStatus(pool)
}

function providerMutationStatus(result, channelId, warning) {
  const pool = result?.pool ?? result
  const status = providerPoolStatus(pool)
  const channel = channelId
    ? status.channels.find((item) => item.id === channelId)
    : result?.channel
      ? status.channels.find((item) => item.id === result.channel.id)
      : undefined
  return {
    ...status,
    ...(channel ? { channel } : {}),
    ...(warning ? { warning } : {}),
  }
}

async function editableSettings() {
  const [{ settings, initialized }, pool] = await Promise.all([loadSettings(), loadProviderConfigs()])
  const primary = pool.channels.find((channel) => channel.id === pool.primaryProviderId) ?? pool.channels[0]
  const poolStatus = providerPoolStatus(pool)
  return {
    initialized: initialized && settings.appSettingsInitialized,
    profile: settings.profile,
    appearance: settings.appearance,
    aiSettings: settings.aiSettings,
    provider: editableProviderConfig(primary),
    providers: poolStatus.channels,
    primaryProviderId: pool.primaryProviderId,
    providerScheduler: poolStatus.scheduler,
  }
}

function sendBackground(response, mimeType, content) {
  response.writeHead(200, {
    'content-type': mimeType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(content)
}

const imageMimeTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const maxAvatarBytes = 5 * 1024 * 1024
const maxTileBytes = 3 * 1024 * 1024

function sendImage(response, mimeType, content, maxAge) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(200, {
    'content-type': mimeType,
    'cache-control': `public, max-age=${maxAge}, immutable`,
    'x-content-type-options': 'nosniff',
  })
  response.end(content)
}

function isAllowedAvatarHost(hostname) {
  const host = hostname.toLowerCase()
  return host === 'qlogo.cn' || host.endsWith('.qlogo.cn') || host === 'qpic.cn' || host.endsWith('.qpic.cn')
}

function approvedAvatarUrl(value) {
  let parsed
  try { parsed = new URL(cleanString(value, 4096)) } catch { throw new Error('头像地址无效') }
  // Older QQ/WeChat exports commonly keep the original http avatar URL. It is
  // still safe to proxy because both the initial host and every redirect stay
  // inside the strict QQ/WeChat image-host allowlist below.
  if (!['https:', 'http:'].includes(parsed.protocol) || !isAllowedAvatarHost(parsed.hostname)) throw new Error('头像来源不在允许的微信/QQ图床域名内')
  return parsed
}

function avatarCacheExtension(mimeType) {
  return ({ 'image/avif': 'avif', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[mimeType] ?? 'img'
}

async function fetchCachedAvatar(initialUrl) {
  const cacheKey = createHash('sha256').update(initialUrl.href).digest('hex')
  const metadataPath = resolve(avatarCacheDirectoryPath, `${cacheKey}.json`)
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    if (typeof metadata?.mimeType === 'string' && imageMimeTypes.has(metadata.mimeType) && typeof metadata?.file === 'string' && /^[a-f0-9]{64}\.(?:avif|gif|jpg|png|webp|img)$/.test(metadata.file)) {
      const content = await readFile(resolve(avatarCacheDirectoryPath, metadata.file))
      if (content.length > 0 && content.length <= maxAvatarBytes) return { mimeType: metadata.mimeType, content }
    }
  } catch { /* A cache miss simply falls through to the approved source. */ }

  const image = await fetchApprovedImage(initialUrl, { maxBytes: maxAvatarBytes, allowedHost: isAllowedAvatarHost })
  try {
    await mkdir(avatarCacheDirectoryPath, { recursive: true, mode: 0o700 })
    const file = `${cacheKey}.${avatarCacheExtension(image.mimeType)}`
    await writeFile(resolve(avatarCacheDirectoryPath, file), image.content, { mode: 0o600 })
    await writeFile(metadataPath, JSON.stringify({ mimeType: image.mimeType, file, downloadedAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    // The avatar remains usable for this request even when a local cache write
    // is unavailable (for example, an antivirus temporarily locks the file).
    console.warn(`[HYPERION AI] Unable to cache avatar: ${error instanceof Error ? error.message : String(error)}`)
  }
  return image
}

async function fetchApprovedImage(initialUrl, { maxBytes, allowedHost }) {
  let url = initialUrl
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!['https:', 'http:'].includes(url.protocol) || !allowedHost(url.hostname)) throw new Error('图片重定向到了未允许的域名')
    const upstream = await fetch(url, {
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5', 'user-agent': 'HYPERION-personal-atlas/0.1 (local asset proxy)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    })
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get('location')
      if (!location) throw new Error('图片服务返回了无效重定向')
      url = new URL(location, url)
      continue
    }
    if (!upstream.ok) throw new Error(`图片服务请求失败 (${upstream.status})`)
    const mimeType = (upstream.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    if (!imageMimeTypes.has(mimeType)) throw new Error('图片服务未返回受支持的图片格式')
    const declaredSize = Number(upstream.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error('图片文件超过大小限制')
    const content = Buffer.from(await upstream.arrayBuffer())
    if (content.length > maxBytes) throw new Error('图片文件超过大小限制')
    return { mimeType, content }
  }
  throw new Error('图片服务重定向次数过多')
}

const mapTileProviders = {
  'osm-de': {
    name: 'OpenStreetMap DE',
    policyUrl: 'https://www.openstreetmap.de/germanstyle.html',
    host: 'tile.openstreetmap.de',
    url: (z, x, y) => `https://tile.openstreetmap.de/${z}/${x}/${y}.png`,
  },
  'osm-standard': {
    name: 'OpenStreetMap Standard',
    policyUrl: 'https://operations.osmfoundation.org/policies/tiles/',
    host: 'tile.openstreetmap.org',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  },
  'osm-hot': {
    name: 'Humanitarian OpenStreetMap',
    policyUrl: 'https://www.hotosm.org/terms/',
    host: 'a.tile.openstreetmap.fr',
    url: (z, x, y) => `https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`,
  },
}

function mapTileUrls(providerId, z, x, y) {
  const maxCoordinate = (2 ** z) - 1
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x > maxCoordinate || y > maxCoordinate) throw new Error('地图瓦片坐标无效')
  const selected = Object.hasOwn(mapTileProviders, providerId) ? providerId : 'osm-de'
  const ordered = [selected, ...Object.keys(mapTileProviders).filter((id) => id !== selected)]
  return ordered.map((id) => new URL(mapTileProviders[id].url(z, x, y)))
}

async function fetchMapTile(providerId, z, x, y, cacheMaxMb) {
  const selected = Object.hasOwn(mapTileProviders, providerId) ? providerId : 'osm-de'
  const cachePath = resolve(mapTileCacheDirectoryPath, `${selected}-${z}-${x}-${y}.png`)
  try {
    const content = await readFile(cachePath)
    if (content.length > 0 && content.length <= maxTileBytes) return { mimeType: 'image/png', content, cache: 'hit' }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[HYPERION] map tile cache read failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  let failure
  for (const url of mapTileUrls(selected, z, x, y)) {
    try {
      const image = await fetchApprovedImage(url, {
        maxBytes: maxTileBytes,
        allowedHost: (host) => Object.values(mapTileProviders).some((provider) => provider.host === host),
      })
      try {
        await mkdir(mapTileCacheDirectoryPath, { recursive: true, mode: 0o700 })
        await writeFileAtomically(cachePath, image.content, { mode: 0o600 })
        const maxBytes = Math.round(Math.max(32, Math.min(1024, Number(cacheMaxMb) || 128)) * 1024 * 1024)
        const maintenance = mapTileMaintenanceQueue.then(() => pruneLogDirectory(mapTileCacheDirectoryPath, { maxFiles: 100_000, maxBytes, exclude: new Set([cachePath]) }))
        mapTileMaintenanceQueue = maintenance.catch(() => undefined)
      } catch (cacheError) {
        console.warn(`[HYPERION] map tile cache write failed: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`)
      }
      return { ...image, cache: 'miss' }
    } catch (error) {
      failure = error
    }
  }
  throw failure ?? new Error('地图瓦片镜像均不可用')
}

export const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin
  if (!allowedOrigin(origin)) {
    sendJson(response, 403, { error: '只允许本机页面访问模型代理' })
    return
  }
  if (origin) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'origin')
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': origin || 'http://localhost', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' })
    response.end()
    return
  }
  const requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname
  const tileMatch = requestPath.match(/^\/api\/map\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/)
  if (tileMatch && request.method === 'GET') {
    try {
      const [z, x, y] = tileMatch.slice(1).map(Number)
      const parameters = new URL(request.url || '/', 'http://127.0.0.1').searchParams
      const image = await fetchMapTile(parameters.get('provider') || 'osm-de', z, x, y, parameters.get('cacheMaxMb'))
      response.setHeader('x-hyperion-map-cache', image.cache)
      sendImage(response, image.mimeType, image.content, 60 * 60 * 24 * 7)
    } catch (error) {
      sendRequestError(response, error, '地图底图加载失败')
    }
    return
  }
  if (requestPath === '/api/media/avatar' && request.method === 'GET') {
    try {
      const source = new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('src') || ''
      const image = await fetchCachedAvatar(approvedAvatarUrl(source))
      sendImage(response, image.mimeType, image.content, 60 * 60 * 24 * 30)
    } catch (error) {
      sendRequestError(response, error, '头像加载失败')
    }
    return
  }
  if (requestPath === '/api/media/avatar/local' && request.method === 'GET') {
    try {
      const avatarId = new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('id') || ''
      const image = await readMnemoAvatar(avatarCacheDirectoryPath, avatarId)
      sendImage(response, image.mimeType, image.content, 60 * 60 * 24 * 30)
    } catch (error) {
      sendRequestError(response, error, '本地 MNEMO 头像加载失败')
    }
    return
  }
  if (requestPath === '/api/map/config' && request.method === 'GET') {
    try {
      const { settings } = await loadSettings()
      sendJson(response, 200, {
        ...settings.mapSettings,
        tileProviders: Object.entries(mapTileProviders).map(([id, provider]) => ({ id, name: provider.name, policyUrl: provider.policyUrl })),
        searchProviders: [
          { id: 'balanced', name: '自动选择', detail: '并行查询多个公共地理编码服务，采用最先返回的有效结果。', policyUrl: 'https://operations.osmfoundation.org/policies/nominatim/' },
          { id: 'nominatim', name: 'Nominatim', detail: 'OpenStreetMap 官方公共搜索服务，适合低频人工查询。', policyUrl: 'https://operations.osmfoundation.org/policies/nominatim/' },
          { id: 'photon', name: 'Photon', detail: 'Komoot 提供的开源地理编码服务。', policyUrl: 'https://photon.komoot.io/' },
        ],
        attribution: '© OpenStreetMap contributors',
        usageNotice: '仅用于交互式个人地图。禁止批量预取或离线抓取；HYPERION 会使用有界本地缓存并保留地图署名。',
      })
    } catch (error) {
      sendRequestError(response, error, '地图服务设置读取失败')
    }
    return
  }
  if (requestPath === '/api/map/config' && request.method === 'POST') {
    try {
      const mapSettings = await saveMapSettings(await readBody(request))
      sendJson(response, 200, mapSettings)
    } catch (error) {
      sendRequestError(response, error, '地图服务设置保存失败')
    }
    return
  }
  if (requestPath === '/api/map/search' && request.method === 'GET') {
    try {
      const mapRequestUrl = new URL(request.url || '/', 'http://127.0.0.1')
      const query = mapRequestUrl.searchParams.get('q')?.trim() || ''
      const searchProvider = mapRequestUrl.searchParams.get('provider') || 'balanced'
      if (query.length < 2) throw new Error('搜索地点至少需要两个字符')
      const normalizedQuery = query.slice(0, 180)
      const headers = { accept: 'application/json', 'user-agent': 'HYPERION-personal-map/0.1 (local user search)' }
      const requestSignal = requestAbortSignal(request, response)
      const providerController = new AbortController()
      const providerSignal = () => AbortSignal.any([requestSignal, providerController.signal, AbortSignal.timeout(7_000)])
      const keepValid = (items) => items.filter((item) => item.display_name && validCoordinate(item.lat, -90, 90) && validCoordinate(item.lon, -180, 180))
      const providers = [
        async () => {
          const endpoint = new URL('https://nominatim.openstreetmap.org/search')
          endpoint.searchParams.set('format', 'jsonv2')
          endpoint.searchParams.set('limit', '8')
          endpoint.searchParams.set('accept-language', 'zh-CN,zh,en')
          endpoint.searchParams.set('q', normalizedQuery)
          const upstream = await fetch(endpoint, { headers, signal: providerSignal() })
          if (!upstream.ok) return []
          const payload = await upstream.json()
          return Array.isArray(payload) ? keepValid(payload.map((item) => ({
            display_name: cleanString(item?.display_name, 300),
            lat: cleanString(item?.lat, 40),
            lon: cleanString(item?.lon, 40),
            kind: cleanString(item?.type || item?.class, 80),
            bounds: Array.isArray(item?.boundingbox) && item.boundingbox.length === 4
              ? [Number(item.boundingbox[0]), Number(item.boundingbox[2]), Number(item.boundingbox[1]), Number(item.boundingbox[3])]
              : undefined,
          }))) : []
        },
        async () => {
          const endpoint = new URL('https://photon.komoot.io/api/')
          endpoint.searchParams.set('q', normalizedQuery)
          endpoint.searchParams.set('limit', '8')
          const upstream = await fetch(endpoint, { headers, signal: providerSignal() })
          if (!upstream.ok) return []
          const payload = await upstream.json()
          return Array.isArray(payload?.features) ? keepValid(payload.features.map((item) => {
            const properties = item?.properties ?? {}
            const coordinates = item?.geometry?.coordinates
            return {
              display_name: [cleanString(properties.name, 120), cleanString(properties.city || properties.county || properties.state, 120), cleanString(properties.country, 120)].filter(Boolean).join('，'),
              lat: String(coordinates?.[1] ?? ''),
              lon: String(coordinates?.[0] ?? ''),
              kind: cleanString(properties.type || properties.osm_value, 80),
              bounds: Array.isArray(properties.extent) && properties.extent.length === 4
                ? [Number(properties.extent[1]), Number(properties.extent[0]), Number(properties.extent[3]), Number(properties.extent[2])]
                : undefined,
            }
          })) : []
        },
        async () => {
          const endpoint = new URL('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates')
          endpoint.searchParams.set('f', 'json')
          endpoint.searchParams.set('singleLine', normalizedQuery)
          endpoint.searchParams.set('maxLocations', '8')
          endpoint.searchParams.set('outFields', 'Addr_Type,Type,PlaceName')
          const upstream = await fetch(endpoint, { headers, signal: providerSignal() })
          if (!upstream.ok) return []
          const payload = await upstream.json()
          return Array.isArray(payload?.candidates) ? keepValid(payload.candidates.map((item) => ({
            display_name: cleanString(item?.address, 300),
            lat: String(item?.location?.y ?? ''),
            lon: String(item?.location?.x ?? ''),
            kind: cleanString(item?.attributes?.Addr_Type || item?.attributes?.Type, 80),
            bounds: item?.extent ? [Number(item.extent.ymin), Number(item.extent.xmin), Number(item.extent.ymax), Number(item.extent.xmax)] : undefined,
          }))) : []
        },
        async () => {
          const signal = providerSignal()
          const searchEndpoint = new URL('https://www.wikidata.org/w/api.php')
          searchEndpoint.searchParams.set('action', 'wbsearchentities')
          searchEndpoint.searchParams.set('search', normalizedQuery)
          searchEndpoint.searchParams.set('language', 'zh')
          searchEndpoint.searchParams.set('uselang', 'zh')
          searchEndpoint.searchParams.set('format', 'json')
          searchEndpoint.searchParams.set('origin', '*')
          searchEndpoint.searchParams.set('limit', '8')
          const searchResponse = await fetch(searchEndpoint, { headers, signal })
          if (!searchResponse.ok) return []
          const searchPayload = await searchResponse.json()
          const ids = Array.isArray(searchPayload?.search) ? searchPayload.search.map((item) => cleanString(item?.id, 40)).filter(Boolean).slice(0, 8) : []
          if (!ids.length) return []
          const entityEndpoint = new URL('https://www.wikidata.org/w/api.php')
          entityEndpoint.searchParams.set('action', 'wbgetentities')
          entityEndpoint.searchParams.set('ids', ids.join('|'))
          entityEndpoint.searchParams.set('props', 'claims|labels|descriptions')
          entityEndpoint.searchParams.set('languages', 'zh|en')
          entityEndpoint.searchParams.set('format', 'json')
          entityEndpoint.searchParams.set('origin', '*')
          const entityResponse = await fetch(entityEndpoint, { headers, signal })
          if (!entityResponse.ok) return []
          const entityPayload = await entityResponse.json()
          return keepValid(ids.map((id) => {
            const entity = entityPayload?.entities?.[id]
            const coordinate = entity?.claims?.P625?.find((claim) => claim?.mainsnak?.datavalue?.value)?.mainsnak?.datavalue?.value
            const label = entity?.labels?.zh?.value || entity?.labels?.en?.value || id
            const description = entity?.descriptions?.zh?.value || entity?.descriptions?.en?.value || ''
            return { display_name: [cleanString(label, 180), cleanString(description, 180)].filter(Boolean).join(' · '), lat: String(coordinate?.latitude ?? ''), lon: String(coordinate?.longitude ?? '') }
          }))
        },
        async () => {
          const endpoint = new URL('https://geocoding-api.open-meteo.com/v1/search')
          endpoint.searchParams.set('name', normalizedQuery)
          endpoint.searchParams.set('count', '8')
          endpoint.searchParams.set('language', 'zh')
          endpoint.searchParams.set('format', 'json')
          const upstream = await fetch(endpoint, { headers: { accept: 'application/json' }, signal: providerSignal() })
          if (!upstream.ok) return []
          const payload = await upstream.json()
          return Array.isArray(payload?.results) ? keepValid(payload.results.map((item) => ({ display_name: [cleanString(item?.name, 120), cleanString(item?.admin1, 120), cleanString(item?.country, 120)].filter(Boolean).join('，'), lat: String(item?.latitude ?? ''), lon: String(item?.longitude ?? ''), kind: cleanString(item?.feature_code, 80) }))) : []
        },
      ]
      const selectedProviders = searchProvider === 'nominatim' ? providers.slice(0, 1) : searchProvider === 'photon' ? providers.slice(1, 2) : providers
      const attempts = selectedProviders.map((provider) => provider())
      const firstUseful = new Promise((resolveFirst) => {
        attempts.forEach((attempt) => {
          void attempt.then((items) => {
            if (items.length) resolveFirst([{ status: 'fulfilled', value: items }])
          }, () => undefined)
        })
      })
      const settled = await Promise.race([firstUseful, Promise.allSettled(attempts)])
      providerController.abort()
      const merged = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      const seen = new Set()
      const results = merged.filter((item) => {
        const coordinateKey = `${Number(item.lat).toFixed(5)}:${Number(item.lon).toFixed(5)}`
        if (seen.has(coordinateKey)) return false
        seen.add(coordinateKey)
        return true
      }).slice(0, 12)
      if (!results.length && settled.every((result) => result.status === 'rejected')) {
        const failure = new Error('公开地点搜索服务暂时无响应，请稍后重试，或直接在地图上添加标记。')
        Object.assign(failure, { status: 502, retryAfter: 15 })
        throw failure
      }
      sendJson(response, 200, results)
    } catch (error) {
      sendRequestError(response, error, '地图搜索失败')
    }
    return
  }
  const backgroundMatch = requestPath.match(/^\/api\/settings\/background\/([a-zA-Z0-9_-]+\.(jpg|png|webp|gif|avif))$/i)
  if (backgroundMatch && request.method === 'GET') {
    try {
      const path = backgroundAssetPath(backgroundMatch[1])
      if (!path) throw new Error('背景图片不存在')
      const mimeTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }
      sendBackground(response, mimeTypes[backgroundMatch[2].toLowerCase()], await readFile(path))
    } catch {
      sendJson(response, 404, { error: '背景图片不存在' })
    }
    return
  }
  if (requestPath === '/api/settings' && request.method === 'GET') {
    try {
      sendJson(response, 200, await editableSettings())
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '无法读取通用设置' })
    }
    return
  }
  if (requestPath === '/api/settings' && request.method === 'POST') {
    try {
      await saveAppSettings(await readBody(request))
      sendJson(response, 200, await editableSettings())
    } catch (error) {
      sendRequestError(response, error, '无法保存通用设置')
    }
    return
  }
  if (requestPath === '/api/settings/background' && request.method === 'POST') {
    try {
      sendJson(response, 200, await saveBackgroundAsset(await readBody(request)))
    } catch (error) {
      sendRequestError(response, error, '无法保存背景图片')
    }
    return
  }
  if (requestPath === '/api/ai/status' && request.method === 'GET') {
    try {
      sendJson(response, 200, await loadProviderPoolStatus())
    } catch (error) {
      sendRequestError(response, error, 'Unable to read AI provider status')
    }
    return
  }
  // The provider-pool endpoints are intentionally available under both
  // `/channels` (the UI wording) and `/providers` (the API wording).  Every
  // mutation returns the complete pool status so clients can redraw channel
  // capacity and queue state without issuing a second request.
  const providerCollectionPath = requestPath === '/api/ai/channels' || requestPath === '/api/ai/providers'
  const providerItemMatch = requestPath.match(/^\/api\/ai\/(?:channels|providers)\/([^/]+)$/)
  if (providerCollectionPath && request.method === 'GET') {
    try {
      sendJson(response, 200, await loadProviderPoolStatus())
    } catch (error) {
      sendRequestError(response, error, 'Unable to read AI provider channels')
    }
    return
  }
  if (providerCollectionPath && request.method === 'POST') {
    try {
      const result = await createProviderChannel(await readBody(request))
      if (result.channel?.id) providerApiModeById.delete(result.channel.id)
      scheduleProviderDispatch()
      sendJson(response, 201, providerMutationStatus(result, result.channel?.id, result.warning))
    } catch (error) {
      sendRequestError(response, error, '模型通道创建失败')
    }
    return
  }
  if (providerItemMatch && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
    let channelId
    try { channelId = decodeURIComponent(providerItemMatch[1]) } catch { channelId = providerItemMatch[1] }
    try {
      const payload = await readBody(request)
      // POST is kept as a convenient action alias for clients that use it to
      // refresh a channel's model list; PUT/PATCH remain ordinary updates.
      const update = request.method === 'POST' && payload && typeof payload === 'object'
        ? { ...payload, ...(payload.action === 'discover-models' || payload.action === 'refresh-models' ? { refreshModels: true } : {}) }
        : payload
      const result = await updateProviderChannel(channelId, update)
      providerApiModeById.delete(channelId)
      providerRuntimeById.delete(channelId)
      providerCredentialProbeById.delete(channelId)
      scheduleProviderDispatch()
      sendJson(response, 200, providerMutationStatus(result, channelId, result.warning))
    } catch (error) {
      sendRequestError(response, error, '模型通道更新失败')
    }
    return
  }
  if (providerItemMatch && request.method === 'DELETE') {
    let channelId
    try { channelId = decodeURIComponent(providerItemMatch[1]) } catch { channelId = providerItemMatch[1] }
    try {
      const pool = await deleteProviderChannel(channelId)
      providerApiModeById.delete(channelId)
      providerRuntimeById.delete(channelId)
      providerCredentialProbeById.delete(channelId)
      // Origin runtimes are keyed by endpoint rather than channel id. They
      // are intentionally retained while another channel still references
      // the endpoint; stale entries are harmless while an active run drains.
      scheduleProviderDispatch()
      sendJson(response, 200, providerMutationStatus(pool))
    } catch (error) {
      sendRequestError(response, error, '模型通道删除失败')
    }
    return
  }
  if (request.url === '/api/quote' && request.method === 'GET') {
    sendJson(response, 200, await randomQuote())
    return
  }
  if (request.url === '/api/storage/overview' && request.method === 'GET') {
    try {
      sendJson(response, 200, await storageOverview())
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '无法读取本机存储概览' })
    }
    return
  }
  if (requestPath === '/api/bot/summary' && request.method === 'GET') {
    try {
      sendJson(response, 200, await botOverview())
    } catch (error) {
      sendRequestError(response, error, '无法读取 HYPERION 摘要')
    }
    return
  }
  if (requestPath === '/api/bot/ai' && request.method === 'GET') {
    try {
      const pool = await loadProviderPoolStatus()
      sendJson(response, 200, {
        scheduler: {
          queueDepth: Number(pool.scheduler?.queueDepth) || 0,
          activeRequests: Number(pool.scheduler?.activeRequests) || 0,
          effectiveMaxConcurrency: Number(pool.scheduler?.effectiveMaxConcurrency) || 0,
          availableCapacity: Number(pool.scheduler?.availableCapacity) || 0,
        },
        channels: (Array.isArray(pool.channels) ? pool.channels : []).map((channel) => ({
          id: cleanString(channel?.id, 120),
          name: cleanString(channel?.name, 120) || cleanString(channel?.id, 120) || '未命名通道',
          enabled: channel?.enabled === true,
          status: cleanString(channel?.runtime?.status, 40) || 'unknown',
          activeRequests: Number(channel?.runtime?.activeRequests) || 0,
          maxConcurrency: Number(channel?.runtime?.effectiveMaxConcurrency) || Number(channel?.maxConcurrency) || 1,
          cooldownUntil: typeof channel?.runtime?.cooldownUntil === 'string' ? channel.runtime.cooldownUntil : null,
        })),
      })
    } catch (error) {
      sendRequestError(response, error, '无法读取 AI 通道状态')
    }
    return
  }
  if (requestPath === '/api/bot/selene' && request.method === 'GET') {
    try {
      const snapshot = await loadSharedState()
      const events = (Array.isArray(snapshot?.data?.contextEvents) ? snapshot.data.contextEvents : [])
        .filter((item) => item?.source === 'selene')
        .sort((left, right) => String(right?.startAt ?? '').localeCompare(String(left?.startAt ?? '')))
      const platforms = events.reduce((counts, item) => {
        const source = String(item?.sourceFile ?? '')
        const platform = /android/i.test(source) ? 'android' : /windows/i.test(source) ? 'windows' : 'unknown'
        counts[platform] = (counts[platform] ?? 0) + 1
        return counts
      }, {})
      sendJson(response, 200, {
        eventCount: events.length,
        platformMix: platforms,
        latestCapturedAt: events[0]?.capturedAt ?? null,
        // Location coordinates, consent tokens, source file paths, and all
        // unbounded event values deliberately stay out of the Bot surface.
        latestEvents: events.slice(0, 6).map((item) => ({
          kind: cleanString(item?.kind, 40),
          title: cleanString(item?.title, 180),
          startAt: typeof item?.startAt === 'string' ? item.startAt : null,
          privacy: item?.privacy === 'precise' ? 'precise' : 'coarse',
        })),
      })
    } catch (error) {
      sendRequestError(response, error, '无法读取 SELENE 时间线摘要')
    }
    return
  }
  if (requestPath === '/api/selene-sync/status' && request.method === 'GET') {
    const directories = configuredSeleneInboxDirectories()
    const statuses = [...seleneInboxWatchers.values()].map((watcher) => watcher.status())
    sendJson(response, 200, seleneInboxWatchers.size
      ? { enabled: true, directories: statuses, directoryCount: statuses.length, lastError: statuses.find((item) => item.lastError)?.lastError ?? null, lastSuccessAt: statuses.map((item) => item.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null }
      : { enabled: false, directories, reason: directories.length ? 'starting' : 'No SELENE export directory was found' })
    return
  }
  if (requestPath === '/api/mnemo/status' && request.method === 'GET') {
    const directories = configuredMnemoInboxDirectories()
    const watcherStatuses = [...mnemoInboxWatchers.values()].map((watcher) => watcher.status())
    const agent = mnemoAgent.status()
    sendJson(response, 200, {
      enabled: agent.enabled,
      agent,
      directoryCount: watcherStatuses.length,
      directories: watcherStatuses,
      configuredDirectories: directories,
      lastError: agent.lastError ?? watcherStatuses.find((item) => item.lastError)?.lastError ?? null,
      lastSuccessAt: watcherStatuses.map((item) => item.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null,
    })
    return
  }
  if (requestPath === '/api/bot/quests' && request.method === 'GET') {
    try {
      const snapshot = await loadSharedState()
      const quests = (Array.isArray(snapshot?.data?.quests) ? snapshot.data.quests : [])
        .filter((item) => item?.status === 'active' || item?.status === 'available')
        .slice(0, 30)
        .map((item) => ({
          id: cleanString(item?.id, 160),
          title: cleanString(item?.title, 240) || '未命名任务',
          dueAt: typeof item?.dueAt === 'string' ? item.dueAt : null,
          startAt: typeof item?.startAt === 'string' ? item.startAt : null,
          status: item?.status === 'active' ? 'active' : 'available',
        }))
      sendJson(response, 200, { items: quests })
    } catch (error) {
      sendRequestError(response, error, '无法读取任务摘要')
    }
    return
  }
  if (requestPath === '/api/bot/people' && request.method === 'GET') {
    try {
      const query = (new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('q') || '').trim().toLocaleLowerCase('zh-CN')
      const snapshot = await loadSharedState()
      const people = (Array.isArray(snapshot?.data?.people) ? snapshot.data.people : [])
        .map(botPersonSummary)
        .filter((item) => !query || `${item.name}\u0000${item.portrait}`.toLocaleLowerCase('zh-CN').includes(query))
        .sort((left, right) => String(right.lastObservedAt).localeCompare(String(left.lastObservedAt)) || left.name.localeCompare(right.name, 'zh-CN'))
        .slice(0, query ? 20 : 40)
      sendJson(response, 200, { items: people })
    } catch (error) {
      sendRequestError(response, error, '无法读取人物摘要')
    }
    return
  }
  if (requestPath === '/api/bot/journal' && request.method === 'POST') {
    try {
      const payload = await readBody(request)
      const snapshot = await loadSharedState()
      if (!snapshot?.data) {
        const error = new Error('HYPERION 尚未初始化共享数据；请先启动一次桌面版或浏览器版。')
        error.status = 409
        throw error
      }
      const record = botJournalRecord(snapshot.data, payload?.content)
      const archive = await saveSharedIntelDelta({ upserts: [record], deleteIds: [] })
      // Return the persisted shape, not merely a 2xx acknowledgement. Iris
      // treats this as its write receipt and will surface a protocol error if
      // a future server change stops producing a self-journal row.
      sendJson(response, 201, {
        id: record.id,
        capturedAt: record.capturedAt,
        archiveUpdatedAt: archive.updatedAt ?? null,
        record,
      })
    } catch (error) {
      sendRequestError(response, error, '无法保存日记')
    }
    return
  }
  if (requestPath === '/api/bot/check-in' && request.method === 'POST') {
    try {
      const payload = await readBody(request)
      let savedCheckIn
      let archiveRecord
      await mutateSharedState((data) => {
        savedCheckIn = botCheckIn(data, payload)
        archiveRecord = botCheckInRecord(data, savedCheckIn)
        const checkins = Array.isArray(data.dailyCheckins) ? data.dailyCheckins.filter((item) => item?.date !== savedCheckIn.date) : []
        return { ...data, dailyCheckins: [savedCheckIn, ...checkins].sort((left, right) => String(right?.date ?? '').localeCompare(String(left?.date ?? ''))) }
      })
      await saveSharedIntelDelta({ upserts: [archiveRecord], deleteIds: [] })
      sendJson(response, 200, { item: savedCheckIn })
    } catch (error) {
      sendRequestError(response, error, '无法保存每日状态')
    }
    return
  }
  const botCompleteQuestMatch = requestPath.match(/^\/api\/bot\/quests\/([^/]+)\/complete$/)
  if (botCompleteQuestMatch && request.method === 'POST') {
    try {
      let id
      try { id = decodeURIComponent(botCompleteQuestMatch[1]) } catch { id = botCompleteQuestMatch[1] }
      let completed
      await mutateSharedState((data) => {
        const quests = Array.isArray(data.quests) ? data.quests : []
        const target = quests.find((item) => item?.id === id)
        if (!target) {
          const error = new Error('任务不存在或已被删除')
          error.status = 404
          throw error
        }
        completed = target.status === 'done' ? target : { ...target, previousStatus: target.status, status: 'done' }
        return { ...data, quests: quests.map((item) => item?.id === id ? completed : item) }
      })
      sendJson(response, 200, { id: completed.id, title: completed.title, status: completed.status })
    } catch (error) {
      sendRequestError(response, error, '无法完成任务')
    }
    return
  }
  if (request.url === '/api/runtime/recovery' && request.method === 'GET') {
    sendJson(response, 200, recoveryStatus)
    return
  }
  if (request.url === '/api/sync/snapshot' && request.method === 'GET') {
    try {
      const snapshot = await loadSharedState()
      sendJson(response, 200, snapshot ?? { updatedAt: null, data: null })
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '无法读取本机同步数据' })
    }
    return
  }
  if (request.url === '/api/sync/meta' && request.method === 'GET') {
    try {
      const snapshot = await loadSharedState()
      sendJson(response, 200, snapshot ? { updatedAt: snapshot.updatedAt, archiveMessageCount: Number(snapshot.data?.archive?.messageCount) || 0 } : { updatedAt: null, archiveMessageCount: 0 })
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '无法读取本机同步状态' })
    }
    return
  }
  if (requestPath === '/api/sync/intel/meta' && request.method === 'GET') {
    try {
      sendJson(response, 200, await loadSharedIntelMeta())
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '无法读取本机原始聊天归档' })
    }
    return
  }
  if (requestPath === '/api/sync/intel/changes' && request.method === 'GET') {
    try {
      const parameters = new URL(request.url || '/', 'http://127.0.0.1').searchParams
      sendJson(response, 200, await loadSharedIntelChanges({
        since: parameters.get('since') || undefined,
        limit: parameters.get('limit') || undefined,
      }))
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Unable to read local archive changes.' })
    }
    return
  }
  if (requestPath === '/api/sync/intel/conversations' && request.method === 'GET') {
    try {
      const parameters = new URL(request.url || '/', 'http://127.0.0.1').searchParams
      sendJson(response, 200, await loadSharedIntelConversationIndex({
        query: parameters.get('q') || '',
        cursor: parameters.get('cursor') || '',
        limit: parameters.get('limit') || undefined,
      }))
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '无法读取本机归档会话索引' })
    }
    return
  }
  const archiveConversationMatch = requestPath.match(/^\/api\/sync\/intel\/conversations\/([^/]+)$/)
  if (archiveConversationMatch && request.method === 'GET') {
    try {
      const parameters = new URL(request.url || '/', 'http://127.0.0.1').searchParams
      let conversationId
      try { conversationId = decodeURIComponent(archiveConversationMatch[1]) } catch { conversationId = archiveConversationMatch[1] }
      sendJson(response, 200, await loadSharedIntelConversationPage(conversationId, {
        cursor: parameters.get('cursor') || '',
        limit: parameters.get('limit') || undefined,
      }))
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '无法读取本机会话内容' })
    }
    return
  }
  if (requestPath === '/api/sync/intel' && request.method === 'GET') {
    try {
      const archive = await loadSharedIntel()
      sendJson(response, 200, archive)
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '无法读取本机原始聊天归档' })
    }
    return
  }
  if (requestPath === '/api/sync/intel/delta' && request.method === 'POST') {
    try {
      sendJson(response, 200, await saveSharedIntelDelta(await readBody(request)))
    } catch (error) {
      const status = Number(error?.statusCode) === 409 ? 409 : Number(error?.status) === 413 ? 413 : 400
      sendJson(response, status, {
        error: error instanceof Error ? error.message : '无法增量保存本机原始聊天归档',
        ...(status === 409 ? { currentUpdatedAt: error?.currentUpdatedAt ?? null } : {}),
      })
    }
    return
  }
  if (requestPath === '/api/sync/intel' && request.method === 'POST') {
    try {
      sendJson(response, 200, await saveSharedIntel(await readBody(request)))
    } catch (error) {
      const status = Number(error?.statusCode) === 409 ? 409 : Number(error?.status) === 413 ? 413 : 400
      sendJson(response, status, {
        error: error instanceof Error ? error.message : '无法保存本机原始聊天归档',
        ...(status === 409 ? { currentUpdatedAt: error?.currentUpdatedAt ?? null } : {}),
      })
    }
    return
  }
  if (request.url === '/api/sync/snapshot' && request.method === 'POST') {
    try {
      const saved = await saveSharedState(await readBody(request))
      // Saving a task must not make the renderer download a 90k-record chat
      // archive just to learn that its write succeeded.
      sendJson(response, 200, { updatedAt: saved.updatedAt, data: null })
    } catch (error) {
      const status = Number(error?.statusCode) === 409 ? 409 : Number(error?.status) === 413 ? 413 : 400
      sendJson(response, status, {
        error: error instanceof Error ? error.message : '无法保存本机同步数据',
        ...(status === 409 ? { currentUpdatedAt: error?.currentUpdatedAt ?? null } : {}),
      })
    }
    return
  }
  if (requestPath === '/api/ai/config' && request.method === 'POST') {
    try {
      const payload = await readBody(request)
      const saved = await saveProviderConfig(payload)
      if (saved.config?.id) {
        providerApiModeById.delete(saved.config.id)
        providerRuntimeById.delete(saved.config.id)
        providerCredentialProbeById.delete(saved.config.id)
      }
      scheduleProviderDispatch()
      const pool = await loadProviderConfigs()
      sendJson(response, 200, providerMutationStatus(pool, saved.config?.id, saved.warning))
    } catch (error) {
      sendRequestError(response, error, '模型通道配置失败')
    }
    return
  }
  if (requestPath === '/api/ai/models' && request.method === 'POST') {
    try {
      sendJson(response, 200, await probeModels(await readBody(request)))
    } catch (error) {
      sendRequestError(response, error, '模型列表探测失败')
    }
    return
  }
  if (requestPath === '/api/ai/config' && request.method === 'DELETE') {
    try {
      await resetProviderConfig()
      providerApiModeById.clear()
      providerRuntimeById.clear()
      providerOriginRuntimeByKey.clear()
      providerCredentialProbeById.clear()
      scheduleProviderDispatch()
      sendJson(response, 200, await loadProviderPoolStatus())
    } catch (error) {
      sendRequestError(response, error, '无法恢复环境配置')
    }
    return
  }
  if (requestPath === '/api/ai/sessions' && request.method === 'POST') {
    const session = createAiSession()
    sendJson(response, 201, { id: session.id, maxEnqueue: aiSessionMaxEnqueue })
    return
  }
  const aiSessionMatch = requestPath.match(/^\/api\/ai\/sessions\/([0-9a-f-]{20,80})(?:\/(enqueue|results))?$/i)
  if (aiSessionMatch) {
    const [, sessionId, action] = aiSessionMatch
    const session = aiSessions.get(sessionId)
    if (!session || session.cancelled) {
      sendJson(response, 404, { error: 'AI extraction session was not found' })
      return
    }
    if (!action && request.method === 'DELETE') {
      const pending = session.queue.length + session.inFlight.size
      session.cancelled = true
      session.queue.length = 0
      session.inFlight.forEach((job) => job.controller?.abort())
      aiSessions.delete(sessionId)
      sendJson(response, 200, { cancelled: true, pending })
      return
    }
    if (action === 'enqueue' && request.method === 'POST') {
      try {
        const batch = await readBody(request)
        const ids = enqueueAiSessionJobs(session, batch?.requests)
        sendJson(response, 202, {
          acceptedIds: ids,
          queued: session.queue.length,
          inFlight: session.inFlight.size,
          pending: session.queue.length + session.inFlight.size,
        })
      } catch (error) {
        sendRequestError(response, error, 'Unable to enqueue AI extraction jobs')
      }
      return
    }
    if (action === 'results' && request.method === 'GET') {
      const resultUrl = new URL(request.url || '/', 'http://127.0.0.1')
      const acknowledgement = resultUrl.searchParams.get('ack') ?? ''
      const acknowledgedIds = acknowledgement.split(',').map((value) => Number(value)).filter(Number.isSafeInteger)
      const retainUntilAcknowledged = resultUrl.searchParams.get('protocol') === 'ack-v1'
      sendJson(response, 200, readAiSessionResults(session, undefined, acknowledgedIds, retainUntilAcknowledged))
      return
    }
    sendJson(response, 405, { error: 'Unsupported AI extraction session operation' })
    return
  }
  if (requestPath === '/api/ai/batch' && request.method === 'POST') {
    const signal = requestAbortSignal(request, response)
    try {
      const batch = await readBody(request)
      const entries = Array.isArray(batch?.requests) ? batch.requests : []
      if (!entries.length) throw new Error('批量模型请求不能为空')
      if (entries.length > 40) throw new Error('单个批量模型请求最多包含 40 个片段')
      const results = await Promise.all(entries.map(async (entry, index) => {
        const id = Number(entry?.id)
        const safeId = Number.isSafeInteger(id) ? id : index + 1
        const path = entry?.workflow === 'people' ? '/api/ai/people' : entry?.workflow === 'tasks' ? '/api/ai/analyze' : entry?.workflow === 'self-observe' ? '/api/ai/self/observe' : entry?.workflow === 'self-merge' ? '/api/ai/self/merge' : ''
        if (!path || !entry?.payload || typeof entry.payload !== 'object') {
          return { id: safeId, ok: false, status: 400, error: '批量模型子请求无效' }
        }
        try {
          const result = await dispatchLocalAiRequest(path, entry.payload, signal)
          return { id: safeId, ok: true, result }
        } catch (error) {
          return {
            id: safeId,
            ok: false,
            status: Number(error?.status) || 500,
            retryAfter: Number(error?.retryAfter) || undefined,
            error: cleanString(error instanceof Error ? error.message : '本机模型子请求失败', 2_000),
          }
        }
      }))
      sendJson(response, 200, { results })
    } catch (error) {
      sendRequestError(response, error, '批量模型请求失败')
    }
    return
  }
  if (request.url === '/api/ai/analyze' && request.method === 'POST') {
    const signal = requestAbortSignal(request, response)
    let payload
    let taskLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('task-extraction', payload)
      const conversation = payload?.conversation ?? {}
      logAiDebug('request_started', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        message: Array.isArray(payload?.records) ? (() => { const stats = directionStats(payload.records); return `发言方向：你 ${stats.self}，对方 ${stats.other}，未确认 ${stats.unknown}。` })() : undefined,
      })
      const result = await analyze(payload, signal)
      logAiDebug('request_succeeded', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        model: result.model,
        apiMode: result.apiModeUsed,
        candidateCount: Array.isArray(result.candidates) ? result.candidates.length : 0,
        peopleCount: Array.isArray(result.people) ? result.people.length : 0,
        peopleIncluded: result.peopleIncluded === true,
        ...providerDebugFields(result),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      const conversation = payload?.conversation ?? {}
      logAiDebug('request_failed', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        ...providerDebugFields(error),
        error: cleanString(error instanceof Error ? error.message : '模型分析失败', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        metadata: error?.providerMetadata ? { provider: error.providerMetadata } : undefined,
        error: cleanString(error instanceof Error ? error.message : '模型分析失败', 2_000),
      })
      sendRequestError(response, error, '模型分析失败')
    }
    return
  }
  if (request.url === '/api/ai/self/observe' && request.method === 'POST') {
    const signal = requestAbortSignal(request, response)
    let payload
    let taskLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('self-observation', payload)
      const conversation = payload?.conversation ?? {}
      logAiDebug('self_observation_started', {
        conversationId: cleanString(conversation.id, 180) || 'self',
        conversationName: 'self analysis', recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
      })
      const result = await analyzeSelfObservations(payload, signal)
      logAiDebug('self_observation_succeeded', {
        conversationId: cleanString(conversation.id, 180) || 'self',
        conversationName: 'self analysis', recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation), model: result.model,
        candidateCount: Array.isArray(result.observations) ? result.observations.length : 0,
        ...providerDebugFields(result), durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      logAiDebug('self_observation_failed', {
        conversationId: cleanString(payload?.conversation?.id, 180) || 'self', recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        status: Number(error?.status) || null, retryAfter: Number(error?.retryAfter) || null,
        ...providerDebugFields(error), error: cleanString(error instanceof Error ? error.message : 'Self observation failed', 500), durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', { durationMs: Date.now() - startedAt, status: Number(error?.status) || null, error: cleanString(error instanceof Error ? error.message : 'Self observation failed', 2_000) })
      sendRequestError(response, error, 'Self observation failed')
    }
    return
  }
  if (request.url === '/api/ai/self/merge' && request.method === 'POST') {
    const signal = requestAbortSignal(request, response)
    let payload
    let taskLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('self-consolidation', payload)
      const result = await analyzeSelfMerge(payload, signal)
      logAiDebug('self_merge_succeeded', {
        conversationId: 'self', candidateCount: Array.isArray(result.periods) ? result.periods.length : 0,
        model: result.model, ...providerDebugFields(result), durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      logAiDebug('self_merge_failed', {
        conversationId: 'self', status: Number(error?.status) || null, retryAfter: Number(error?.retryAfter) || null,
        ...providerDebugFields(error), error: cleanString(error instanceof Error ? error.message : 'Self analysis consolidation failed', 500), durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', { durationMs: Date.now() - startedAt, status: Number(error?.status) || null, error: cleanString(error instanceof Error ? error.message : 'Self analysis consolidation failed', 2_000) })
      sendRequestError(response, error, 'Self analysis consolidation failed')
    }
    return
  }
  if (request.url === '/api/ai/people' && request.method === 'POST') {
    const signal = requestAbortSignal(request, response)
    let payload
    let taskLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('people-extraction', payload)
      const conversation = payload?.conversation ?? {}
      logAiDebug('people_request_started', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        message: Array.isArray(payload?.records) ? (() => { const stats = directionStats(payload.records); const counterpart = payloadCounterpartName(payload); return `发言方向：你 ${stats.self}，对方 ${stats.other}，未确认 ${stats.unknown}${counterpart ? `；私聊主体：${counterpart}` : ''}。` })() : undefined,
      })
      const result = await analyzePeopleRecords(payload, signal)
      logAiDebug('people_request_succeeded', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        model: result.model,
        apiMode: result.apiModeUsed,
        peopleCount: Array.isArray(result.people) ? result.people.length : 0,
        ...providerDebugFields(result),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      const conversation = payload?.conversation ?? {}
      logAiDebug('people_request_failed', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        ...providerDebugFields(error),
        error: cleanString(error instanceof Error ? error.message : '人物模型分析失败', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        metadata: error?.providerMetadata ? { provider: error.providerMetadata } : undefined,
        error: cleanString(error instanceof Error ? error.message : '人物模型分析失败', 2_000),
      })
      sendRequestError(response, error, '人物模型分析失败')
    }
    return
  }
  if (request.url === '/api/ai/people/merge' && request.method === 'POST') {
    const signal = requestAbortSignal(request, response)
    let payload
    let taskLog
    let promptForLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('people-consolidation', payload)
      promptForLog = buildPeopleMergePrompt(validatePeopleMergePayload(payload))
      const result = await analyzePeopleMerge(payload, signal)
      logAiDebug('people_merge_succeeded', {
        personName: cleanString(payload?.person?.name, 120) || null,
        factCount: Array.isArray(payload?.person?.facts) ? payload.person.facts.length : 0,
        rawClaimCount: Array.isArray(payload?.person?.evidence) ? payload.person.evidence.length : 0,
        resultFactCount: result.facts.length,
        acceptedClaimCount: result.facts.length + result.preferences.length,
        factClaimIds: Array.isArray(result.factClaimIds) ? result.factClaimIds : [],
        preferenceClaimIds: Array.isArray(result.preferenceClaimIds) ? result.preferenceClaimIds : [],
        portraitGenerated: Boolean(result.portrait),
        portraitBlockCount: Array.isArray(result.portraitBlocks) ? result.portraitBlocks.length : 0,
        portraitSchemaVersion: result.portraitSchemaVersion ?? null,
        model: result.model,
        apiMode: result.apiModeUsed,
        ...providerDebugFields(result),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, prompt: promptForLog, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      logAiDebug('people_merge_failed', {
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        ...providerDebugFields(error),
        error: cleanString(error instanceof Error ? error.message : '人物信息归并失败', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        metadata: error?.providerMetadata ? { provider: error.providerMetadata } : undefined,
        error: cleanString(error instanceof Error ? error.message : '人物信息归并失败', 2_000),
      })
      sendRequestError(response, error, '人物信息归并失败')
    }
    return
  }
  if (request.url === '/api/ai/task-guidance' && request.method === 'POST') {
    const signal = requestAbortSignal(request, response)
    let payload
    let taskLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('task-guidance', payload)
      const result = await analyzeTaskGuidance(payload, signal)
      logAiDebug('task_guidance_succeeded', {
        taskTitle: cleanString(payload?.quest?.title, 160) || null,
        peopleCount: Array.isArray(payload?.people) ? payload.people.length : 0,
        guidanceCount: result.guidance.length,
        model: result.model,
        apiMode: result.apiModeUsed,
        ...providerDebugFields(result),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      logAiDebug('task_guidance_failed', {
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        ...providerDebugFields(error),
        error: cleanString(error instanceof Error ? error.message : 'Task guidance failed', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
        retryAfter: Number(error?.retryAfter) || null,
        metadata: error?.providerMetadata ? { provider: error.providerMetadata } : undefined,
        error: cleanString(error instanceof Error ? error.message : 'Task guidance failed', 2_000),
      })
      sendRequestError(response, error, 'Task guidance failed')
    }
    return
  }
  sendJson(response, 404, { error: 'Not found' })
})

export function startAiProxy() {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      const listeningPort = address && typeof address !== 'string' ? address.port : port
      console.log(`AI proxy listening on http://127.0.0.1:${listeningPort}`)
      installRuntimeFailureMonitor()
      void startRecoverySession(serviceSessionPath, crashLogPath, { port: listeningPort })
        .then((status) => { recoveryStatus = status })
        .catch((error) => console.warn(`[HYPERION] recovery marker unavailable: ${error instanceof Error ? error.message : String(error)}`))
      server.once('close', () => {
        for (const watcher of seleneInboxWatchers.values()) watcher.stop()
        seleneInboxWatchers.clear()
        for (const watcher of mnemoInboxWatchers.values()) watcher.stop()
        mnemoInboxWatchers.clear()
        mnemoAgent.stop()
        void finishRecoverySession(serviceSessionPath).catch(() => undefined)
      })
      void withFileLock(`${sharedStatePath}.lock`, () => migrateSharedStateFile(sharedStatePath, migrationDirectoryPath))
        .then((result) => {
          sharedStateMigrationStatus = { state: 'ready', ...result }
          if (result.migrated) console.log(`[HYPERION] shared state schema migrated to v${result.toVersion}; rollback backup: ${result.backupPath}`)
        })
        .catch((error) => {
          sharedStateMigrationStatus = { state: 'failed', migrated: false, error: error instanceof Error ? error.message : String(error) }
          console.warn(`[HYPERION] shared state migration skipped: ${sharedStateMigrationStatus.error}`)
        })
      void migrateLegacySharedIntel()
        .then((migrated) => { archiveMigrationStatus = { state: 'ready', migrated } })
        .catch((error) => {
          archiveMigrationStatus = { state: 'failed', migrated: false, error: error instanceof Error ? error.message : String(error) }
          console.warn(`[HYPERION] archive migration skipped: ${archiveMigrationStatus.error}`)
        })
      void compactExistingTaskLogs()
      void startSeleneInboxSync().catch((error) => console.warn(`[HYPERION] SELENE inbox disabled: ${error instanceof Error ? error.message : String(error)}`))
      void startMnemoIntegration().catch((error) => console.warn(`[HYPERION] MNEMO integration disabled: ${error instanceof Error ? error.message : String(error)}`))
      resolve(server)
    })
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startAiProxy().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

import http from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { discoverModels, editableProviderConfig, loadProviderConfig, normalizeBaseUrl, resetProviderConfig, saveProviderConfig } from './providerConfig.mjs'
import { backgroundAssetPath, loadSettings, saveAppSettings, saveBackgroundAsset } from './settings.mjs'
import { runtimePaths } from './runtimePaths.mjs'

const port = Number(process.env.AI_PORT || 8787)
const maxBodyBytes = 256 * 1024 * 1024
const maxAttachments = 4
const maxAttachmentBytes = 8 * 1024 * 1024
const fallbackQuotes = [
  { text: '向前走，哪怕只是很小的一步。', from: '离线句库' },
  { text: '把今天能做的事，留在今天完成。', from: '离线句库' },
  { text: '真正重要的事，值得慢慢弄清。', from: '离线句库' },
]
const {
  sharedStatePath,
  sharedIntelPath,
  aiDebugLogPath,
  taskLogDirectoryPath,
  avatarCacheDirectoryPath,
  settingsPath,
  backgroundDirectoryPath,
  electronUserDataPath,
  legacyProviderPath,
  desktopPidPath,
} = runtimePaths
let sharedStateWriteQueue = Promise.resolve()

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomically(path, payload) {
  const temporary = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, JSON.stringify(payload), 'utf8')
  await rename(temporary, path)
}

async function storageEntry(id, path, description) {
  try {
    const details = await stat(path)
    if (details.isDirectory()) {
      let entryCount
      try { entryCount = (await readdir(path)).length } catch { /* metadata is optional */ }
      return { id, path, description, exists: true, kind: 'directory', ...(Number.isFinite(entryCount) ? { entryCount } : {}) }
    }
    return { id, path, description, exists: true, kind: 'file', sizeBytes: details.size }
  } catch (error) {
    if (error?.code === 'ENOENT') return { id, path, description, exists: false, kind: 'file' }
    throw error
  }
}

async function storageOverview() {
  const entries = await Promise.all([
    storageEntry('shared-state', sharedStatePath, '任务、人物、地点、候选任务和界面状态的共享快照。'),
    storageEntry('shared-intel', sharedIntelPath, '原始聊天归档。仅在本机保留，模型提炼时按你选择的范围读取。'),
    storageEntry('settings', settingsPath, '通用 INI：名称、外观、模型通道和提炼偏好。包含你保存的明文 API Key。'),
    storageEntry('backgrounds', backgroundDirectoryPath, '已上传的自定义背景图片。'),
    storageEntry('debug-log', aiDebugLogPath, '模型请求调试日志，不含聊天正文、附件或密钥。'),
    storageEntry('task-logs', taskLogDirectoryPath, '按任务与时间戳分文件保存的完整本地模型输入、输出和失败信息，不含 API Key。'),
    storageEntry('avatar-cache', avatarCacheDirectoryPath, '从导出记录的微信/QQ头像地址下载的本地缓存。'),
    storageEntry('electron-user-data', electronUserDataPath, '桌面客户端的 Chromium 会话、缓存和窗口运行数据；退出客户端后仍会保留。'),
    storageEntry('desktop-pid', desktopPidPath, '桌面客户端运行标记；关闭客户端后会自动清除。'),
    storageEntry('legacy-provider', legacyProviderPath, '旧版模型通道配置；若仍存在，仅用于一次性迁移。'),
  ])
  return { workspace: runtimePaths.workspace, entries }
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
  console.info(`[THEIA AI] ${line.trim()}`)
  void mkdir(dirname(aiDebugLogPath), { recursive: true, mode: 0o700 })
    .then(() => appendFile(aiDebugLogPath, line, 'utf8'))
    .catch(() => undefined)
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
    await writeFile(path, `${JSON.stringify({ schema: 'theia-task-log/v1', startedAt, kind, request: taskLogPayload(payload) })}\n`, { encoding: 'utf8', mode: 0o600 })
    return { path, startedAt }
  } catch (error) {
    console.warn(`[THEIA AI] Unable to start task log: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function finishTaskLog(log, event, details) {
  if (!log) return
  try {
    await appendFile(log.path, `${JSON.stringify({ at: new Date().toISOString(), event, ...taskLogPayload(details) })}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.warn(`[THEIA AI] Unable to finish task log: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function segmentDebugFields(conversation) {
  const segmentIndex = Number(conversation?.segmentIndex)
  const segmentCount = Number(conversation?.segmentCount)
  const coreRecordCount = Number(conversation?.coreRecordCount)
  const overlapRecordCount = Number(conversation?.overlapRecordCount)
  return {
    segmentIndex: Number.isInteger(segmentIndex) ? segmentIndex : null,
    segmentCount: Number.isInteger(segmentCount) ? segmentCount : null,
    coreRecordCount: Number.isInteger(coreRecordCount) ? coreRecordCount : null,
    overlapRecordCount: Number.isInteger(overlapRecordCount) ? overlapRecordCount : null,
    historical: conversation?.historical === true,
  }
}

async function loadSharedState() {
  const payload = await readJsonFile(sharedStatePath)
  if (!payload || typeof payload !== 'object' || !payload.data) return null
  // Raw archives are intentionally not part of a dashboard snapshot. Older
  // files may still contain `intel`; keep those bytes untouched on disk while
  // stripping them before they can freeze browser/desktop synchronization.
  const { intel: _legacyIntel, ...data } = payload.data
  return { ...payload, data }
}

async function writeSharedState(payload) {
  if (!payload?.data || typeof payload.data !== 'object') throw new Error('同步数据格式无效')
  // Preserve an inline archive written by an older renderer before stripping
  // it from future snapshots. New renderers never send raw records here.
  const legacy = await readJsonFile(sharedStatePath)
  const preservedIntel = Array.isArray(payload.intel) ? payload.intel
    : Array.isArray(payload.data.intel) ? payload.data.intel
      : Array.isArray(legacy?.intel) ? legacy.intel
        : Array.isArray(legacy?.data?.intel) ? legacy.data.intel
          : undefined
  if (preservedIntel) await writeJsonAtomically(sharedIntelPath, preservedIntel)
  // Do not rewrite the companion archive after migration. It may contain
  // hundreds of thousands of messages and is outside shared UI state.
  const { intel: _ignoredIntel, ...data } = payload.data
  const snapshot = { updatedAt: new Date().toISOString(), data }
  await writeJsonAtomically(sharedStatePath, snapshot)
  return snapshot
}

function saveSharedState(payload) {
  // Desktop and browser may sync at nearly the same time. A single temporary
  // file is safe only when snapshot writes are serialized.
  const write = sharedStateWriteQueue.then(() => writeSharedState(payload))
  sharedStateWriteQueue = write.catch(() => undefined)
  return write
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

const personEvidenceClaimSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    sourceIds: { type: 'array', items: { type: 'string' } },
    quote: { type: 'string' },
  },
  required: ['text', 'sourceIds', 'quote'],
}

const personSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    facts: { type: 'array', items: personEvidenceClaimSchema },
    preferences: { type: 'array', items: personEvidenceClaimSchema },
    advice: { type: 'array', items: { type: 'string' } },
    sourceIds: { type: 'array', items: { type: 'string' } },
    platforms: { type: 'array', items: { type: 'string' } },
    firstObservedAt: { type: ['string', 'null'] },
    portrait: { type: ['string', 'null'] },
  },
  required: ['name', 'facts', 'preferences', 'advice', 'sourceIds', 'platforms', 'firstObservedAt', 'portrait'],
}

const personMergeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    facts: { type: 'array', items: { type: 'string' } },
    preferences: { type: 'array', items: { type: 'string' } },
    advice: { type: 'array', items: { type: 'string' } },
    portrait: { type: ['string', 'null'] },
  },
  required: ['facts', 'preferences', 'advice', 'portrait'],
}

const taskGuidanceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    guidance: { type: 'array', items: { type: 'string' } },
  },
  required: ['guidance'],
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

const chatResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: responseFormat.name,
    strict: true,
    schema: responseFormat.schema,
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
    properties: { people: { type: 'array', items: personSchema } },
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
  if (Number.isFinite(retryAfter) && retryAfter > 0) payload.retry_after = Math.min(300, Math.ceil(retryAfter))
  sendJson(response, status >= 400 && status <= 599 ? status : 400, payload)
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
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  } catch { return false }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        reject(new Error('完整会话请求超过 256MB，无法一次发送给当前模型服务'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
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
    if (!cleanString(record?.id, 160) || !cleanString(record?.content, 3000)) throw new Error('记录缺少 id 或内容')
  }
  for (const attachment of payload.attachments) {
    const data = cleanString(attachment?.data, maxAttachmentBytes * 2)
    if (!data || !cleanString(attachment?.mimeType, 120) || Buffer.byteLength(data, 'utf8') > maxAttachmentBytes * 2) throw new Error('附件缺少内容或超过 8MB')
  }
}

function compactModelRecords(records) {
  // Repeating six property names and long import IDs for every record can add
  // hundreds of thousands of avoidable tokens to a large conversation. The
  // compact rows preserve every model-relevant field in a stable order.
  return records.map((record, index) => [
    String(index + 1),
    record.formattedTime ?? null,
    record.type ?? null,
    record.content,
    record.senderDisplayName ?? null,
    record.speakerRole ?? 'unknown',
  ])
}

function directionStats(records) {
  return records.reduce((stats, record) => {
    const role = record?.speakerRole === 'self' || record?.speakerRole === 'other' ? record.speakerRole : 'unknown'
    stats[role] += 1
    if (cleanString(record?.senderDisplayName, 120)) stats.named += 1
    return stats
  }, { self: 0, other: 0, unknown: 0, named: 0 })
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
  const recencyPolicy = ['strict', 'balanced', 'broad'].includes(payload.settings?.recencyPolicy) ? payload.settings.recencyPolicy : 'balanced'
  const feedback = Array.isArray(payload.settings?.feedback) ? payload.settings.feedback.slice(-30).map((item) => ({
    title: cleanString(item?.title, 120),
    description: cleanString(item?.description, 500),
    decision: item?.decision === 'accepted' ? 'accepted' : 'dismissed',
    reason: cleanString(item?.reason, 40),
    sourceCapturedAt: cleanString(item?.sourceCapturedAt, 80) || null,
  })) : []
  const now = new Date()
  const analysisDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const conversationName = cleanString(payload.conversation?.name, 160)
  const compactRecords = compactModelRecords(payload.records)
  const taskOutputContract = 'Return exactly one JSON object with a candidates array. Every candidate must include title, description, startAt, dueAt, sourceIds, people, place, locationPrecision, locationRadiusMeters, tags, guidance, and actionOwner. Use null for unavailable startAt, dueAt, place, or locationRadiusMeters; use "unknown" when no location is established; use [] for unavailable people, tags, or guidance. Do not estimate duration or travel time. actionOwner must be "self". Cite only RecordRef values present in the input, as strings.'
  const legacyConversationMode = conversationName
    ? [
      `本次输入是同一段完整导出对话：${conversationName}。所有已导入消息均按时间顺序提供，不是抽样上下文。`,
      '以整段对话中已经形成的安排、明确承诺、待确认事项和未完成下一步为单位提炼；同一安排只能输出一次，并引用所有直接证据。重复、寒暄、纯回顾和没有下一步的讨论不生成任务。',
      '记录较旧本身不构成任务。较旧记录只有在原文明确表明仍未完成、仍有效或约定了尚未到来的具体日期时才可保留；不要因为历史聊天重新制造任务。',
    ].join('\n')
    : '输入是用户主动导出的记录。'
  const conversation = payload.conversation ?? {}
  const segmentIndex = Number(conversation.segmentIndex) || 1
  const segmentCount = Number(conversation.segmentCount) || 1
  const coreRecordIndexes = new Set((Array.isArray(conversation.coreRecordIndexes) ? conversation.coreRecordIndexes : []).map(String))
  const historicalSegment = conversation.historical === true
  const segmentMode = [
    `This request is segment ${segmentIndex}/${segmentCount} of the same exported conversation${conversationName ? `: ${conversationName}` : ''}. It contains ${compactRecords.length} ordered rows, including a small preceding overlap for context. The full conversation is covered by other sequential requests; never assume facts from those other requests.`,
    `Rows ${coreRecordIndexes.size ? [...coreRecordIndexes].join(', ') : '1 through ' + compactRecords.length} are this segment's new timeline range. Overlap rows may explain context, but every candidate must cite at least one new-range RecordRef. Do not recreate an arrangement already complete in the overlap.`,
    historicalSegment
      ? 'This is historical material, older than roughly two months. It is still provided for accurate context, but only emit a task with an explicit future calendar date. Do not revive ordinary old errands, notifications, invitations, or submissions.'
      : 'This is recent material. Extract only still-actionable next steps, while using overlap only as context.',
  ].join('\n')
  return [
    `The ${compactRecords.length} rows below are this ordered conversation segment: [RecordRef, formattedTime, type, content, senderDisplayName, speakerRole]. RecordRef is a short evidence reference, not a message count. Use its string value in sourceIds. type is the exporter's raw label: use it only when its text explicitly identifies outgoing/self or incoming/other; never guess the meaning of a numeric or opaque type value. speakerRole is the already-verified direction: "self" means the export explicitly marks the message as written by the user; "other" means it explicitly marks another sender; "unknown" has no verified direction. Never infer direction from senderDisplayName, pronouns, tone, or conversation name. Output a candidate only when the next action belongs to the user, and set actionOwner to "self". A message from "other" can support a user task only when it directly asks the user to act, or when later self-authored evidence explicitly accepts a mutual arrangement. Do not turn an incoming other-person plan, deadline, reminder, or errand into a user task.`,
    'formattedTime is the message timestamp. It can be null. Resolve relative dates such as tomorrow, next week, Wednesday, or a deadline only against the cited record\'s non-empty formattedTime. If all cited records lack a timestamp, leave startAt and dueAt null unless the record itself explicitly contains a complete calendar date with year, month, and day. Never use the import time or current system time.',
    '你是个人生活任务整理助手。输入是用户主动导出的聊天/平台记录，不要尝试登录、绕过权限、恢复密码或推断敏感隐私。',
    segmentMode,
    taskOutputContract,
    `分析模式：${mode}。`,
    `有效性检查日期：${analysisDate}；时效偏好：${recencyPolicy}。该日期只用于判断事项今天是否仍有行动价值，绝不能拿来解析“明天、下周”等相对日期。`,
    '只输出用户本人仍可执行的下一步：明确约会、见面、预约、回复、付款、报名、提交、课程、考试、截止、双方待确认的安排，或对方明确请求用户处理的事。必须跳过产品/模型/提示词的讨论、泛泛抱怨、闲聊、愿望、纯建议、已完成、已取消、已过期、他人的待办，以及发言方向未知的事项。',
    '时效规则：快递取件码、外卖、验证码、签到和临时通知属于短时事项，若信息源已过去数日且没有新的未完成证据，必须跳过。没有截止日期的征集、投稿、问卷、报名或材料提交，若通知已过去数周且用户没有明确接受或后续追问，通常视为失效。返校、课程、生日、约见等原文指向未来日期或明确仍待确认的长期事项可以保留。不要把历史通知本身等同于今天仍存在的任务。',
    '严格保持发言动作方向：先逐条确认 self 和 other 分别说了什么，再写标题。若 other 说“我请你喝酒/吃饭”，任务应写成“确认或参加与某人的喝酒/吃饭安排”，绝不能写成“请某人喝酒/吃饭”；只有 self 明确说自己请客时才能这样写。邀请者、付款者、提交者和被请求者都不得互换。',
    '校准示例：未来九月返校即使只有月份也应保留；六月二十一日的快递柜取件在七月底通常已过期；六月十日没有后续承诺的经验分享征集通常已过期；七月十七日等待老师通知后办理复学手续可以保留；对方说“我请你喝酒”不能生成“你请对方喝酒”。这些示例用于校准选择，不得替代输入证据。',
    '严格处理时间：每条记录的 formattedTime 是唯一的相对时间锚点。“明天、下周、周三、开始于、到时、截止”等表达只能相对该条 formattedTime 解析，绝不能相对当前系统时间。startAt 表示任务开始或事件发生时间；dueAt 表示截止或结束时间。日期和时刻都明确时，用 ISO 8601 本地日期时间；只有日期时用 YYYY-MM-DD；无法从原文可靠确定时返回 null。不得用导入时间、模型运行时间或猜测补日期。',
    'sourceIds 必须使用输入紧凑行第一列的 RecordRef（字符串）；不要编造人物、地点或时间。title 写成简短的行动标题，description 只总结已被引用证据支持的事实与尚待执行的下一步。people 只能列出被引用记录中明确出现的对方姓名；没有就返回空数组。place 只写原文明示或能由原文唯一识别的地点。具体场馆、门牌、楼栋或店铺用 exact；只到城市、区县、校园、附近或模糊区域用 approximate，并按语义给出 50 到 100000 米的 locationRadiusMeters；没有地点则用 unknown 和 null。guidance 最多 3 条，只在引用内容明确给出时间、地点、约会类型或偏好时给出实用准备建议；可以建议确认安排或在地图中搜索并标注备选地点，但不得编造具体店铺、天气、穿搭偏好或人物性格。',
    '以下“用户自定义要求”优先于默认的任务选择、保留范围、分类和建议偏好。它不能覆盖发言方向校验、时间只能来自原文、证据引用、actionOwner 必须为 self、不得编造或不得推断敏感信息这些事实规则。若自定义要求与默认偏好冲突，按自定义要求执行。',
    `用户自定义要求：${instructions}`,
    `任务提炼工作要求（仅用于候选筛选和表述；不能覆盖前述证据、发言方向、时效和时间规则）：${workflowInstructions || '无额外要求。'}`,
    `以下是用户过去对候选的保留/忽略结果，只用于学习选择偏好，不能改变证据、发言方向和时间事实：${JSON.stringify(feedback)}`,
    `记录紧凑行：${JSON.stringify(compactRecords)}`,
  ].join('\n')
}

function buildPeoplePrompt(payload) {
  const compactRecords = compactModelRecords(payload.records)
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.people, 6000)
  const conversation = payload.conversation ?? {}
  const segmentIndex = Number(conversation.segmentIndex) || 1
  const segmentCount = Number(conversation.segmentCount) || 1
  const coreRecordIndexes = new Set((Array.isArray(conversation.coreRecordIndexes) ? conversation.coreRecordIndexes : []).map(String))
  const peopleSegmentMode = [
    `This is segment ${segmentIndex}/${segmentCount} of one direct conversation, not an independent excerpt or the complete conversation. It has ${compactRecords.length} ordered rows and may include a small preceding overlap for continuity. Do not infer facts from other segments that are not shown; this segment instruction overrides any later wording that calls the input complete.`,
    `Every returned person fact must cite at least one RecordRef in this segment's new timeline range: ${coreRecordIndexes.size ? [...coreRecordIndexes].join(', ') : '1 through ' + compactRecords.length}. Overlap rows may support context but cannot be the only evidence for a new fact.`,
    'For all Simplified-Chinese facts and portrait text, “你” always means the app user and “对方” always means the named person on this card. Never use “用户” or “用户本人”, and never swap “你” with “对方”.',
    conversation.historical === true
      ? 'Historical segments are especially useful for directly stated stable facts and earliest verifiable interactions. Keep all claims conservative and grounded in cited rows.'
      : 'Recent segments may add directly stated facts or a cautious dialogue impression only when multiple cited rows support it.',
  ].join('\n')
  const personOutputContract = 'Return exactly one JSON object with a people array. Every person must include name, facts, preferences, advice, sourceIds, platforms, firstObservedAt, and portrait. Each facts/preference item must be an object with text, sourceIds, and quote. quote must be an exact contiguous original phrase from one cited row. Use [] when no facts, preferences, or advice are justified; use null when portrait or firstObservedAt is unavailable.'
  return [
    peopleSegmentMode,
    personOutputContract,
    `This input is exactly one complete direct conversation with ${compactRecords.length} ordered compact rows: [RecordRef, formattedTime, type, content, senderDisplayName, speakerRole]. Use RecordRef strings in sourceIds. A person can only be the explicit senderDisplayName of at least one record whose speakerRole is "other". Never output the user or an inferred participant. firstObservedAt must be the earliest formattedTime among cited sourceIds, or null if no cited timestamp can be read. It means "earliest verifiable interaction", never when two people met. Extract every distinct directly stated fact supported by cited records, up to 12 concise facts. In Chinese facts and portrait, refer to the app user as “你” and refer to the profile subject by their explicit name; never use the ambiguous labels “对方”, “用户” or “用户本人”. portrait is optional and must be a short Simplified-Chinese dialogue impression, explicitly cautious. Only provide portrait when several cited records show a repeated communication pattern; otherwise return null so the interface can ask for more information sources. It is not a fact and must not diagnose personality or relationship.`,
    '你是个人生活人物的严格事实核验助手。输入是用户主动导出的聊天或平台记录。只处理输入文字本身，不要尝试登录、绕过权限、恢复密码或推断隐私。',
    '任务：只输出该私聊中由对方发言记录明确标识的对方；为其写出原文直接陈述、可被核验的事实。没有足够事实时可以返回空数组，客户端会保留一张只说明“存在可核实私聊互动”的保守人物卡。',
    '绝对规则：不要从昵称、语气、共同出现、头像、称呼或关系词推断身份、关系、偏好、性格、情绪、住址或任何未明说的信息。不要将被提及的人自动认定为发送者、提供者或同一人。不要把用户本人、群名、机构、课程、地点、作品角色或抽象对象当成人物。',
    'sourceIds 必须精确使用输入紧凑行第一列的 RecordRef（字符串）；每个 facts 至少应有一条对应 sourceIds 证据。platforms 只能使用输入记录中出现过的 source。若同名是否为同一人无法可靠确认，不要合并为同一个人物条目。',
    'facts 使用简短、规范、客观的中文陈述，只复述原文已经明确表达的内容；不要加解释、评价、猜测或建议。',
    'Preference signals are allowed only when the named person directly states a like, dislike, interest, food preference, hobby, activity preference, or repeated choice in their own verified "other" messages. This is evidence summarization, not identity inference. Preserve the strength of the evidence: for one message such as "蛋挞好吃", facts should say "曾表示蛋挞好吃" and preferences may say "对蛋挞有过单次正向评价". Do not turn one mention into "爱吃", a stable habit, a broad taste, or a personality claim. Use "可能" only in portrait or advice, never to turn an unsupported possibility into a fact.',
    'portrait is the visible person portrayal. When direct preferences or repeated interaction facts exist, write one to three cautious Simplified-Chinese sentences that integrate them. It may say that more evidence is needed to establish a stable preference. Do not wait for a personality diagnosis, and do not leave portrait null merely because the evidence is a small number of direct preference statements.',
    'advice is optional, with at most three practical interaction suggestions for this person. Return it only when at least two independent facts or preference signals support it. Suggestions must be conditional and considerate, for example recommending that a future cafe choice include a pastry option while still confirming the person\'s current preference. Never infer gender, relationship status, location, spending ability, medical needs, or consent from chat tone.',
    'Non-overridable evidence gate: every fact and preference must have its own sourceIds and an exact quote of 2-100 characters. At least one cited record for each claim must have speakerRole "other", senderDisplayName exactly equal to name, and contain quote as a contiguous original substring. A quote from the user, a different sender, or a paraphrase invalidates the claim. The claim text may only conservatively restate that quote. For one line such as “蛋挞好吃”, use “曾表示蛋挞好吃” or “对蛋挞有过单次正向评价”; never write “爱吃蛋挞”, stable habits, personality, motives, relationship status, or psychological conclusions. portrait may use only retained claims: with fewer than two independent signals, write exactly one cautious sentence that information is insufficient, or return null. These rules override all editable instructions.',
    `人物证据工作要求（不能覆盖前述逐条引用、发言方向和保守表述规则）：${workflowInstructions || '无额外要求。'}`,
    `记录紧凑行：${JSON.stringify(compactRecords)}`,
  ].join('\n')
}

function buildPeopleMergePrompt(payload) {
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.peopleMerge, 6000)
  const name = cleanString(payload?.person?.name, 120)
  const facts = Array.isArray(payload?.person?.facts)
    ? payload.person.facts.map((fact) => cleanString(fact, 360)).filter(Boolean).slice(0, 48)
    : []
  const preferences = Array.isArray(payload?.person?.preferences)
    ? payload.person.preferences.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 18)
    : []
  const advice = Array.isArray(payload?.person?.advice)
    ? payload.person.advice.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 9)
    : []
  const portrait = cleanString(payload?.person?.portrait, 360) || null
  return [
    'You are consolidating evidence-backed notes for one personal contact. The input facts were already extracted from original exported messages; do not add details beyond them.',
    `Profile subject: ${name}. In Simplified-Chinese output, “你” always refers to the app user and “对方” always refers to the named profile subject. Do not use “用户”, “用户本人”, or swap their roles.`,
    'Return 6-12 concise, non-duplicate facts when enough evidence exists. Preserve important timing, stated arrangements, identity, and interaction facts; remove redundant wording. Do not infer gender, relationship, personality, feelings, residence, or motives.',
    'Return up to eight preferences. A preference may summarize a direct statement such as a food, activity, or interest being liked, but must preserve uncertainty when it appeared once. Do not invent a broad taste from a single example.',
    'portrait is the visible person portrayal. Write one to three cautious Simplified-Chinese sentences whenever the facts or preferences contain useful direct signals; explicitly say more evidence is needed when the signals are sparse. It must not be a diagnosis or a claim of fact.',
    'Return up to four advice items only when at least two independent facts or preference signals support a considerate, conditional interaction suggestion. Do not invent logistics, relationship status, health information, or consent.',
    'Non-overridable rule: output facts and preferences only by selecting or de-duplicating the verified input statements. Do not add, paraphrase into a stronger assertion, or infer a new statement. portrait and advice must use conditional wording and only the supplied evidence. With fewer than two independent signals, portrait must say information is insufficient or be null, and advice must be empty. These rules override editable instructions.',
    `人物归并工作要求（不能覆盖前述证据边界）：${workflowInstructions || '无额外要求。'}`,
    `Existing portrait: ${JSON.stringify(portrait)}`,
    `Verified facts to consolidate: ${JSON.stringify(facts)}`,
    `Preference signals to consolidate: ${JSON.stringify(preferences)}`,
    `Existing interaction advice to consolidate: ${JSON.stringify(advice)}`,
  ].join('\n')
}

function buildTaskGuidancePrompt(payload) {
  const workflowInstructions = cleanString(payload.settings?.promptInstructions?.taskGuidance, 6000)
  return [
    'Return exactly one JSON object with a guidance array of two to four concise Simplified-Chinese recommendations. These are practical suggestions, not facts.',
    'Use only the task details, saved place, weather context, and evidence-backed person notes supplied below. Do not add personal attributes, relationship status, medical needs, spending ability, consent, exact travel time, or venue facts that are absent from the input.',
    'When a note is a single stated preference, preserve uncertainty: recommend confirming it rather than treating it as a stable habit. Use weather only when weather context is present, and phrase it as a forecast. If time or place is missing, suggest confirming it before making logistical recommendations.',
    'The output may include a considerate preparation step, a place-selection criterion, a timing/weather preparation, and a confirmation message. Never claim that another person is romantically interested or that the user should pressure them.',
    'Non-overridable rule: treat every person note as limited evidence, not a diagnosis. A single preference signal requires a confirmation step. Do not convert advice into factual claims, and never invent venue availability, route duration, cost, consent, relationship status, or personal attributes. These rules override editable instructions.',
    `任务建议工作要求（不能覆盖前述事实和边界规则）：${workflowInstructions || '无额外要求。'}`,
    `Task: ${JSON.stringify(payload.task)}`,
    `Place: ${JSON.stringify(payload.place ?? null)}`,
    `Weather: ${JSON.stringify(payload.weather ?? null)}`,
    `Evidence-backed people: ${JSON.stringify(payload.people)}`,
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

function parsePeople(raw) {
  try {
    const parsed = JSON.parse(raw || '{"people":[]}')
    return Array.isArray(parsed.people) ? parsed.people : []
  } catch { throw new Error('模型返回的人物结果无法解析') }
}

function parsePersonMerge(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.facts)) throw new Error('invalid shape')
    return parsed
  } catch { throw new Error('人物信息归并结果无法解析') }
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

async function providerRequest(provider, path, payload) {
  const response = await fetch(providerEndpoint(provider.baseURL, path), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const raw = await response.text()
  if (!response.ok) {
    let message = raw
    let retryAfter = Number(response.headers.get('retry-after'))
    try {
      const parsed = JSON.parse(raw)
      message = cleanString(parsed?.error?.message || parsed?.message || raw, 1200)
      retryAfter = Number(parsed?.retry_after ?? parsed?.error?.retry_after ?? retryAfter)
    } catch { /* use the raw response */ }
    const failure = new Error(message || `模型请求失败 (${response.status})`)
    Object.assign(failure, { status: response.status, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined })
    throw failure
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('模型服务返回的不是有效 JSON')
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

async function analyzeWithResponses(provider, model, payload) {
  const content = [{ type: 'input_text', text: buildPrompt(payload) }, ...attachmentContent(payload.attachments)]
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content }],
    text: { format: responseFormat },
    // Task candidates are deliberately concise. A smaller output budget keeps
    // a full long-conversation request from reserving an unnecessarily large
    // generation on compatibility relays.
    max_output_tokens: 3000,
  })
  return parseCandidates(responseOutputText(response))
}

async function analyzeWithChat(provider, model, payload) {
  const content = [{ type: 'text', text: `${buildPrompt(payload)}\n只返回符合指定 JSON Schema 的 JSON 对象，不要添加 Markdown。` }, ...chatAttachmentContent(payload.attachments)]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: chatResponseFormat,
      max_tokens: 3000,
    })
    return parseCandidates(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (![400, 422].includes(error?.status)) throw error
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 3000,
    })
    return parseCandidates(response?.choices?.[0]?.message?.content || '')
  }
}

async function analyzePeopleWithResponses(provider, model, payload) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildPeoplePrompt(payload) }] }],
    text: { format: peopleResponseFormat },
    max_output_tokens: 5000,
  })
  return parsePeople(responseOutputText(response))
}

async function analyzePeopleWithChat(provider, model, payload) {
  const content = [{ type: 'text', text: `${buildPeoplePrompt(payload)}\n只返回符合指定 JSON Schema 的 JSON 对象，不要添加 Markdown。` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: peopleChatResponseFormat,
      max_tokens: 5000,
    })
    return parsePeople(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (![400, 422].includes(error?.status)) throw error
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 5000,
    })
    return parsePeople(response?.choices?.[0]?.message?.content || '')
  }
}

async function mergePeopleWithResponses(provider, model, payload) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildPeopleMergePrompt(payload) }] }],
    text: { format: personMergeResponseFormat },
    max_output_tokens: 1_200,
  })
  return parsePersonMerge(responseOutputText(response))
}

async function mergePeopleWithChat(provider, model, payload) {
  const content = [{ type: 'text', text: `${buildPeopleMergePrompt(payload)}\nReturn only the requested JSON object, without Markdown.` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: personMergeChatResponseFormat,
      max_tokens: 1_200,
    })
    return parsePersonMerge(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (![400, 422].includes(error?.status)) throw error
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 1_200,
    })
    return parsePersonMerge(response?.choices?.[0]?.message?.content || '')
  }
}

function parseTaskGuidance(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    return Array.isArray(parsed?.guidance) ? parsed.guidance : []
  } catch { throw new Error('Task guidance result could not be parsed') }
}

async function taskGuidanceWithResponses(provider, model, payload) {
  const response = await providerRequest(provider, 'responses', {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: buildTaskGuidancePrompt(payload) }] }],
    text: { format: taskGuidanceResponseFormat },
    max_output_tokens: 1_200,
  })
  return parseTaskGuidance(responseOutputText(response))
}

async function taskGuidanceWithChat(provider, model, payload) {
  const content = [{ type: 'text', text: `${buildTaskGuidancePrompt(payload)}\nReturn only the requested JSON object, without Markdown.` }]
  try {
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: taskGuidanceChatResponseFormat,
      max_tokens: 1_200,
    })
    return parseTaskGuidance(response?.choices?.[0]?.message?.content || '')
  } catch (error) {
    if (![400, 422].includes(error?.status)) throw error
    const response = await providerRequest(provider, 'chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 1_200,
    })
    return parseTaskGuidance(response?.choices?.[0]?.message?.content || '')
  }
}

function canFallbackToChat(error) {
  // Some OpenAI-compatible relays advertise models successfully but proxy the
  // Responses endpoint through a different upstream. Let auto mode attempt
  // Chat Completions when that upstream returns a transient gateway failure.
  return [400, 404, 405, 422, 501, 502, 503, 504].includes(error?.status) || /responses|endpoint|not found|unsupported/i.test(error instanceof Error ? error.message : '')
}

async function analyze(payload) {
  validatePayload(payload)
  const provider = await loadProviderConfig()
  if (!provider.apiKey) throw new Error('尚未配置模型通道，请在模型工作台中导入中转配置或填写环境变量。')
  let candidates
  let apiModeUsed = provider.apiMode
  if (provider.apiMode === 'responses') {
    candidates = await analyzeWithResponses(provider, provider.model, payload)
  } else if (provider.apiMode === 'chat-completions') {
    candidates = await analyzeWithChat(provider, provider.model, payload)
  } else {
    try {
      candidates = await analyzeWithResponses(provider, provider.model, payload)
      apiModeUsed = 'responses'
    } catch (error) {
      if (!canFallbackToChat(error)) throw error
      candidates = await analyzeWithChat(provider, provider.model, payload)
      apiModeUsed = 'chat-completions'
    }
  }
  candidates = restoreRecordReferences(candidates, payload.records)
  candidates = restoreVerifiedActionOwner(candidates, payload.records)
  return { model: provider.model, apiModeUsed, candidates, receivedRecordCount: payload.records.length }
}

async function analyzePeopleRecords(payload) {
  validatePayload(payload)
  const provider = await loadProviderConfig()
  if (!provider.apiKey) throw new Error('尚未配置模型通道，请先在情报库中保存服务地址、API Key 和模型。')
  let people
  if (provider.apiMode === 'responses') {
    people = await analyzePeopleWithResponses(provider, provider.model, payload)
  } else if (provider.apiMode === 'chat-completions') {
    people = await analyzePeopleWithChat(provider, provider.model, payload)
  } else {
    try {
      people = await analyzePeopleWithResponses(provider, provider.model, payload)
    } catch (error) {
      if (!canFallbackToChat(error)) throw error
      people = await analyzePeopleWithChat(provider, provider.model, payload)
    }
  }
  return { model: provider.model, people: restoreRecordReferences(people, payload.records), receivedRecordCount: payload.records.length }
}

function validatePeopleMergePayload(payload) {
  const name = cleanString(payload?.person?.name, 120)
  const facts = Array.isArray(payload?.person?.facts)
    ? payload.person.facts.map((fact) => cleanString(fact, 360)).filter(Boolean).slice(0, 48)
    : []
  const preferences = Array.isArray(payload?.person?.preferences)
    ? payload.person.preferences.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 18)
    : []
  const advice = Array.isArray(payload?.person?.advice)
    ? payload.person.advice.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 9)
    : []
  if (!name || facts.length < 2) throw new Error('人物归并至少需要名称和两条已核验事实。')
  return {
    person: {
      name,
      facts,
      preferences,
      advice,
      portrait: cleanString(payload?.person?.portrait, 360) || null,
    },
    settings: {
      promptInstructions: {
        peopleMerge: cleanString(payload?.settings?.promptInstructions?.peopleMerge, 6000),
      },
    },
  }
}

async function analyzePeopleMerge(payload) {
  const normalized = validatePeopleMergePayload(payload)
  const provider = await loadProviderConfig()
  if (!provider.apiKey) throw new Error('尚未配置模型通道。')
  let result
  let apiModeUsed = provider.apiMode
  if (provider.apiMode === 'responses') {
    result = await mergePeopleWithResponses(provider, provider.model, normalized)
  } else if (provider.apiMode === 'chat-completions') {
    result = await mergePeopleWithChat(provider, provider.model, normalized)
  } else {
    try {
      result = await mergePeopleWithResponses(provider, provider.model, normalized)
      apiModeUsed = 'responses'
    } catch (error) {
      if (!canFallbackToChat(error)) throw error
      result = await mergePeopleWithChat(provider, provider.model, normalized)
      apiModeUsed = 'chat-completions'
    }
  }
  return {
    model: provider.model,
    apiModeUsed,
    facts: Array.isArray(result.facts) ? result.facts.map((fact) => cleanString(fact, 360)).filter(Boolean).slice(0, 12) : [],
    preferences: Array.isArray(result.preferences) ? result.preferences.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 8) : [],
    advice: Array.isArray(result.advice) ? result.advice.map((item) => cleanString(item, 360)).filter(Boolean).slice(0, 4) : [],
    portrait: cleanString(result.portrait, 360) || null,
  }
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
    portrait: cleanString(person?.portrait, 360) || null,
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

async function analyzeTaskGuidance(payload) {
  const normalized = validateTaskGuidancePayload(payload)
  const provider = await loadProviderConfig()
  if (!provider.apiKey) throw new Error('No AI provider is configured')
  let guidance
  if (provider.apiMode === 'responses') {
    guidance = await taskGuidanceWithResponses(provider, provider.model, normalized)
  } else if (provider.apiMode === 'chat-completions') {
    guidance = await taskGuidanceWithChat(provider, provider.model, normalized)
  } else {
    try {
      guidance = await taskGuidanceWithResponses(provider, provider.model, normalized)
    } catch (error) {
      if (!canFallbackToChat(error)) throw error
      guidance = await taskGuidanceWithChat(provider, provider.model, normalized)
    }
  }
  return {
    model: provider.model,
    guidance: Array.isArray(guidance) ? [...new Set(guidance.map((item) => cleanString(item, 360)).filter(Boolean))].slice(0, 4) : [],
  }
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

async function editableSettings() {
  const { settings, initialized } = await loadSettings()
  return {
    initialized: initialized && settings.appSettingsInitialized,
    profile: settings.profile,
    appearance: settings.appearance,
    aiSettings: settings.aiSettings,
    provider: editableProviderConfig(await loadProviderConfig()),
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
    console.warn(`[THEIA AI] Unable to cache avatar: ${error instanceof Error ? error.message : String(error)}`)
  }
  return image
}

async function fetchApprovedImage(initialUrl, { maxBytes, allowedHost }) {
  let url = initialUrl
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!['https:', 'http:'].includes(url.protocol) || !allowedHost(url.hostname)) throw new Error('图片重定向到了未允许的域名')
    const upstream = await fetch(url, {
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5', 'user-agent': 'THEIA-personal-atlas/0.1 (local asset proxy)' },
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

function mapTileUrls(z, x, y) {
  const maxCoordinate = (2 ** z) - 1
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x > maxCoordinate || y > maxCoordinate) throw new Error('地图瓦片坐标无效')
  // The canonical OSM host times out on some Chinese networks. These are
  // public OSM-compatible mirrors, tried in a verified order without API keys.
  return [
    new URL(`https://tile.openstreetmap.de/${z}/${x}/${y}.png`),
    new URL(`https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`),
  ]
}

async function fetchMapTile(z, x, y) {
  let failure
  for (const url of mapTileUrls(z, x, y)) {
    try {
      return await fetchApprovedImage(url, {
        maxBytes: maxTileBytes,
        allowedHost: (host) => host === 'tile.openstreetmap.de' || host === 'a.tile.openstreetmap.fr',
      })
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
    response.writeHead(204, { 'access-control-allow-origin': origin || 'http://localhost', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' })
    response.end()
    return
  }
  const requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname
  const tileMatch = requestPath.match(/^\/api\/map\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/)
  if (tileMatch && request.method === 'GET') {
    try {
      const [z, x, y] = tileMatch.slice(1).map(Number)
      const image = await fetchMapTile(z, x, y)
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
  if (requestPath === '/api/map/search' && request.method === 'GET') {
    try {
      const query = new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('q')?.trim() || ''
      if (query.length < 2) throw new Error('搜索地点至少需要两个字符')
      const normalizedQuery = query.slice(0, 180)
      const headers = { accept: 'application/json', 'user-agent': 'THEIA-personal-map/0.1 (local user search)' }
      const keepValid = (items) => items.filter((item) => item.display_name && validCoordinate(item.lat, -90, 90) && validCoordinate(item.lon, -180, 180))
      const providers = [
        async () => {
          const endpoint = new URL('https://nominatim.openstreetmap.org/search')
          endpoint.searchParams.set('format', 'jsonv2')
          endpoint.searchParams.set('limit', '8')
          endpoint.searchParams.set('accept-language', 'zh-CN,zh,en')
          endpoint.searchParams.set('q', normalizedQuery)
          const upstream = await fetch(endpoint, { headers, signal: AbortSignal.timeout(7_000) })
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
          const upstream = await fetch(endpoint, { headers, signal: AbortSignal.timeout(7_000) })
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
          const upstream = await fetch(endpoint, { headers, signal: AbortSignal.timeout(7_000) })
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
          const signal = AbortSignal.timeout(7_000)
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
          const upstream = await fetch(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(7_000) })
          if (!upstream.ok) return []
          const payload = await upstream.json()
          return Array.isArray(payload?.results) ? keepValid(payload.results.map((item) => ({ display_name: [cleanString(item?.name, 120), cleanString(item?.admin1, 120), cleanString(item?.country, 120)].filter(Boolean).join('，'), lat: String(item?.latitude ?? ''), lon: String(item?.longitude ?? ''), kind: cleanString(item?.feature_code, 80) }))) : []
        },
      ]
      const settled = await Promise.allSettled(providers.map((provider) => provider()))
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
      sendJson(response, 400, { error: error instanceof Error ? error.message : '无法保存通用设置' })
    }
    return
  }
  if (requestPath === '/api/settings/background' && request.method === 'POST') {
    try {
      sendJson(response, 200, await saveBackgroundAsset(await readBody(request)))
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '无法保存背景图片' })
    }
    return
  }
  if (request.url === '/api/ai/status' && request.method === 'GET') {
    sendJson(response, 200, editableProviderConfig(await loadProviderConfig()))
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
  if (request.url === '/api/sync/snapshot' && request.method === 'POST') {
    try {
      const saved = await saveSharedState(await readBody(request))
      // Saving a task must not make the renderer download a 90k-record chat
      // archive just to learn that its write succeeded.
      sendJson(response, 200, { updatedAt: saved.updatedAt, data: null })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '无法保存本机同步数据' })
    }
    return
  }
  if (request.url === '/api/ai/config' && request.method === 'POST') {
    try {
      const payload = await readBody(request)
      const saved = await saveProviderConfig(payload)
      sendJson(response, 200, { ...editableProviderConfig(saved.config), warning: saved.warning })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '模型通道配置失败' })
    }
    return
  }
  if (request.url === '/api/ai/models' && request.method === 'POST') {
    try {
      sendJson(response, 200, await probeModels(await readBody(request)))
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '模型列表探测失败' })
    }
    return
  }
  if (request.url === '/api/ai/config' && request.method === 'DELETE') {
    try {
      sendJson(response, 200, editableProviderConfig(await resetProviderConfig()))
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '无法恢复环境配置' })
    }
    return
  }
  if (request.url === '/api/ai/analyze' && request.method === 'POST') {
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
      })
      const result = await analyze(payload)
      logAiDebug('request_succeeded', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        model: result.model,
        apiMode: result.apiModeUsed,
        candidateCount: Array.isArray(result.candidates) ? result.candidates.length : 0,
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
        error: cleanString(error instanceof Error ? error.message : '模型分析失败', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
        error: cleanString(error instanceof Error ? error.message : '模型分析失败', 2_000),
      })
      sendRequestError(response, error, '模型分析失败')
    }
    return
  }
  if (request.url === '/api/ai/people' && request.method === 'POST') {
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
        message: Array.isArray(payload?.records) ? `发言方向：你 ${directionStats(payload.records).self}，对方 ${directionStats(payload.records).other}，未确认 ${directionStats(payload.records).unknown}；有名称 ${directionStats(payload.records).named} 条。` : undefined,
      })
      const result = await analyzePeopleRecords(payload)
      logAiDebug('people_request_succeeded', {
        conversationId: cleanString(conversation.id, 180) || null,
        conversationName: cleanString(conversation.name, 180) || null,
        recordCount: Array.isArray(payload?.records) ? payload.records.length : 0,
        ...segmentDebugFields(conversation),
        model: result.model,
        peopleCount: Array.isArray(result.people) ? result.people.length : 0,
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
        error: cleanString(error instanceof Error ? error.message : '人物模型分析失败', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
        error: cleanString(error instanceof Error ? error.message : '人物模型分析失败', 2_000),
      })
      sendRequestError(response, error, '人物模型分析失败')
    }
    return
  }
  if (request.url === '/api/ai/people/merge' && request.method === 'POST') {
    let payload
    let taskLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('people-consolidation', payload)
      const result = await analyzePeopleMerge(payload)
      logAiDebug('people_merge_succeeded', {
        personName: cleanString(payload?.person?.name, 120) || null,
        factCount: Array.isArray(payload?.person?.facts) ? payload.person.facts.length : 0,
        resultFactCount: result.facts.length,
        model: result.model,
        apiMode: result.apiModeUsed,
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      logAiDebug('people_merge_failed', {
        status: Number(error?.status) || null,
        error: cleanString(error instanceof Error ? error.message : '人物信息归并失败', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
        error: cleanString(error instanceof Error ? error.message : '人物信息归并失败', 2_000),
      })
      sendRequestError(response, error, '人物信息归并失败')
    }
    return
  }
  if (request.url === '/api/ai/task-guidance' && request.method === 'POST') {
    let payload
    let taskLog
    const startedAt = Date.now()
    try {
      payload = await readBody(request)
      taskLog = await startTaskLog('task-guidance', payload)
      const result = await analyzeTaskGuidance(payload)
      logAiDebug('task_guidance_succeeded', {
        taskTitle: cleanString(payload?.quest?.title, 160) || null,
        peopleCount: Array.isArray(payload?.people) ? payload.people.length : 0,
        guidanceCount: result.guidance.length,
        model: result.model,
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'succeeded', { durationMs: Date.now() - startedAt, response: result })
      sendJson(response, 200, result)
    } catch (error) {
      logAiDebug('task_guidance_failed', {
        status: Number(error?.status) || null,
        error: cleanString(error instanceof Error ? error.message : 'Task guidance failed', 500),
        durationMs: Date.now() - startedAt,
      })
      await finishTaskLog(taskLog, 'failed', {
        durationMs: Date.now() - startedAt,
        status: Number(error?.status) || null,
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
      console.log(`AI proxy listening on http://127.0.0.1:${port}`)
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

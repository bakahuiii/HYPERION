import type { IntelItem } from '../types'
import { deduplicateIntelAvatars } from './intelPersistence.ts'

interface ParsedLine {
  text: string
  timestamp?: unknown
  speaker?: string
  avatarUrl?: string
  messageType?: string
  speakerRole?: NonNullable<IntelItem['speakerRole']>
}

interface ParseContext {
  timestamp?: unknown
  speaker?: string
  avatarUrl?: string
  messageType?: string
  speakerRole?: NonNullable<IntelItem['speakerRole']>
}

export interface ImportContext {
  path?: string
}

const contentKeys = ['content', 'text', 'message', 'msg', 'body', 'messagecontent', 'msgcontent']
const timeKeys = ['timestamp', 'time', 'datetime', 'date', 'formattedtime', 'createtime', 'sendtime', 'msgtime']
const speakerKeys = ['sender', 'sendername', 'senderdisplayname', 'from', 'nickname', 'author', 'username', 'talker']
const avatarKeys = ['avatar', 'avatarurl', 'headimg', 'headimgurl', 'headurl', 'head', 'headimage', 'headimageurl', 'smallhead', 'smallheadurl', 'bighead', 'bigheadurl', 'face', 'faceurl', 'icon', 'iconurl', 'profileimage', 'profileimageurl', 'portrait']
const nestedSpeakerNameKeys = ['displayname', 'senderdisplayname', 'nickname', 'remark', 'remarkname', 'name', 'username']
const messageTypeKeys = ['type', 'msgtype', 'messagetype']
const selfRoleKeys = ['issend', 'issendmsg', 'issendmessage', 'issendbyme', 'isoutgoing', 'isself', 'isfromme', 'fromme', 'fromself', 'outgoing', 'self']
const directionRoleKeys = ['direction', 'msgdirection', 'messagedirection', 'senderrole']
const selfIdentityKeys = ['selfuin', 'myuin', 'selfid', 'myid', 'myaccountid']
const senderIdentityKeys = ['senderuin', 'senderid', 'fromuin', 'fromid', 'authorid', 'senderaccountid']

function normalizedKey(key: string) {
  return key.toLowerCase().replace(/[_\s-]/g, '')
}

function stableHash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function readableText(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

function readableTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return value.trim()
  return ''
}

function firstField(record: Record<string, unknown>, keys: string[]) {
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(normalizedKey(key))) {
      const text = readableText(value)
      if (text) return text
    }
  }
  return ''
}

function nestedSpeakerName(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 3) return ''
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nestedSpeakerNameKeys.includes(normalizedKey(key))) {
      const name = readableText(nested)
      if (name) return name
    }
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const name = nestedSpeakerName(nested, depth + 1)
    if (name) return name
  }
  return ''
}

function firstSpeaker(record: Record<string, unknown>) {
  const direct = firstField(record, speakerKeys)
  if (direct) return direct
  for (const [key, value] of Object.entries(record)) {
    if (!speakerKeys.includes(normalizedKey(key))) continue
    const nested = nestedSpeakerName(value)
    if (nested) return nested
  }
  return ''
}

function firstTimestampField(record: Record<string, unknown>) {
  for (const [key, value] of Object.entries(record)) {
    if (timeKeys.includes(normalizedKey(key))) {
      const timestamp = readableTimestamp(value)
      if (timestamp !== '') return timestamp
    }
  }
  return undefined
}

function roleFromValue(value: unknown, key: string): NonNullable<IntelItem['speakerRole']> {
  if (selfRoleKeys.includes(key)) {
    if (value === true || value === 1) return 'self'
    if (value === false || value === 0) return 'other'
    const text = String(value).trim().toLowerCase()
    if (['true', '1', 'yes', 'self', 'me', 'out', 'outgoing', 'send', 'sent'].includes(text)) return 'self'
    if (['false', '0', 'no', 'other', 'in', 'incoming', 'receive', 'received'].includes(text)) return 'other'
  }
  if (directionRoleKeys.includes(key)) {
    const text = String(value).trim().toLowerCase()
    if (['self', 'me', 'out', 'outgoing', 'send', 'sent'].includes(text)) return 'self'
    if (['other', 'in', 'incoming', 'receive', 'received'].includes(text)) return 'other'
  }
  if (key === 'type') {
    const text = String(value).trim().toLowerCase()
    if (['self', 'me', 'out', 'outgoing', 'send', 'sent', '发送', '已发送', '发出', '本人'].includes(text)) return 'self'
    if (['other', 'in', 'incoming', 'receive', 'received', '接收', '收到', '对方'].includes(text)) return 'other'
  }
  return 'unknown'
}

function firstMessageType(record: Record<string, unknown>) {
  for (const [key, value] of Object.entries(record)) {
    if (!messageTypeKeys.includes(normalizedKey(key))) continue
    const text = String(value ?? '').trim()
    if (text) return text.slice(0, 80)
  }
  return ''
}

function identityValue(record: Record<string, unknown>, keys: string[]) {
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(normalizedKey(key))) continue
    const identity = String(value ?? '').trim().toLowerCase()
    if (identity) return identity
  }
  return ''
}

function firstSpeakerRole(record: Record<string, unknown>): NonNullable<IntelItem['speakerRole']> {
  for (const [key, value] of Object.entries(record)) {
    const role = roleFromValue(value, normalizedKey(key))
    if (role !== 'unknown') return role
  }
  // Some exporters store the current-account id and sender id instead of a
  // direction flag. Exact equality is exporter-provided evidence of direction.
  const selfIdentity = identityValue(record, selfIdentityKeys)
  const senderIdentity = identityValue(record, senderIdentityKeys)
  if (selfIdentity && senderIdentity) return selfIdentity === senderIdentity ? 'self' : 'other'
  return 'unknown'
}

function safeAvatarUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  const candidate = value.trim().replace(/^\/\//, 'https://')
  return /^(?:https?:\/\/|data:image\/)/i.test(candidate) ? candidate.slice(0, 4000) : ''
}

function avatarUrlFromValue(value: unknown, depth = 0): string {
  const direct = safeAvatarUrl(value)
  if (direct) return direct
  if (!value || typeof value !== 'object' || depth > 3) return ''
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedKey(key)
    if (['url', 'uri', 'src', 'href'].includes(normalized)) {
      const candidate = safeAvatarUrl(nested)
      if (candidate) return candidate
    }
    if (typeof nested === 'object') {
      const candidate = avatarUrlFromValue(nested, depth + 1)
      if (candidate) return candidate
    }
  }
  return ''
}

function firstAvatarUrl(record: Record<string, unknown>) {
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizedKey(key)
    if (avatarKeys.includes(normalized) || speakerKeys.includes(normalized) || ['profile', 'contact', 'userinfo', 'senderinfo'].includes(normalized)) {
      const candidate = avatarUrlFromValue(value)
      if (candidate) return candidate
    }
  }
  return ''
}

function collectSpeakerAvatars(value: unknown, result = new Map<string, string>()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSpeakerAvatars(item, result))
    return result
  }
  if (!value || typeof value !== 'object') return result
  const record = value as Record<string, unknown>
  const speaker = firstSpeaker(record)
  const avatarUrl = firstAvatarUrl(record)
  if (speaker && avatarUrl && !result.has(speaker)) result.set(speaker, avatarUrl)
  Object.values(record).forEach((item) => collectSpeakerAvatars(item, result))
  return result
}

/**
 * Some chat exports keep the counterpart portrait only on the enclosing
 * `session` object rather than on each message. A folder is one conversation,
 * so that avatar is safe to use as the fallback portrait for its records.
 */
function sessionAvatarUrl(value: unknown, depth = 0): string {
  if (!value || depth > 8) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sessionAvatarUrl(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const [key, nested] of Object.entries(record)) {
    if (normalizedKey(key) !== 'session') continue
    const session = nested as Record<string, unknown>
    const avatarUrl = session && typeof session === 'object'
      ? firstAvatarUrl(session) || avatarUrlFromValue(session)
      : avatarUrlFromValue(session)
    if (avatarUrl) return avatarUrl
  }
  for (const nested of Object.values(record)) {
    const found = sessionAvatarUrl(nested, depth + 1)
    if (found) return found
  }
  return ''
}

function localIso(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  const date = new Date(year, month - 1, day, hour, minute, second)
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second
  ) return undefined
  const pad = (value: number) => String(value).padStart(2, '0')
  const datePart = `${year}-${pad(month)}-${pad(day)}`
  return hour || minute || second ? `${datePart}T${pad(hour)}:${pad(minute)}:${pad(second)}` : datePart
}

export function normalizeCapturedAt(value: unknown): string | undefined {
  const raw = readableTimestamp(value)
  if (raw === '') return undefined

  const epoch = typeof raw === 'number'
    ? raw
    : /^\d{10,13}$/.test(raw) ? Number(raw) : undefined
  if (epoch !== undefined && Number.isFinite(epoch)) {
    const milliseconds = epoch < 100_000_000_000 ? epoch * 1000 : epoch
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) {
      const pad = (part: number) => String(part).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }
  }

  const text = String(raw).replace(/\u3000/g, ' ').trim()
  // Keep the optional time group separate from the optional day suffix. The
  // previous expression could consume the separator whitespace as a day and
  // silently truncate `2026-08-04 10:00:00` to a date-only value.
  const matched = text.match(/(\d{4})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})(?:\s*(?:日|号))?(?:[ T]+(\d{1,2})(?:\s*[:时]\s*(\d{1,2}))?(?:\s*[:分]\s*(\d{1,2}))?\s*(?:秒)?\s*)?/)
  if (matched) {
    return localIso(
      Number(matched[1]),
      Number(matched[2]),
      Number(matched[3]),
      matched[4] === undefined ? 0 : Number(matched[4]),
      matched[5] === undefined ? 0 : Number(matched[5]),
      matched[6] === undefined ? 0 : Number(matched[6]),
    )
  }

  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return undefined
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
}

function collectJsonMessages(value: unknown, result: ParsedLine[] = [], context: ParseContext = {}, strict = false): ParsedLine[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonMessages(item, result, context, strict))
    return result
  }
  if (!value || typeof value !== 'object') return result

  const record = value as Record<string, unknown>
  const ownRole = firstSpeakerRole(record)
  const nextContext: ParseContext = {
    timestamp: firstTimestampField(record) ?? context.timestamp,
    speaker: firstSpeaker(record) || context.speaker,
    avatarUrl: firstAvatarUrl(record) || context.avatarUrl,
    messageType: firstMessageType(record) || context.messageType,
    speakerRole: ownRole !== 'unknown' ? ownRole : context.speakerRole,
  }
  const text = firstField(record, contentKeys)
  const hasMessageMetadata = nextContext.timestamp !== undefined
    || Boolean(nextContext.speaker)
    || (nextContext.speakerRole !== undefined && nextContext.speakerRole !== 'unknown')
  if (text.length >= 2 && (!strict || hasMessageMetadata)) {
    result.push({ text, timestamp: nextContext.timestamp, speaker: nextContext.speaker, avatarUrl: nextContext.avatarUrl, messageType: nextContext.messageType, speakerRole: nextContext.speakerRole ?? 'unknown' })
    return result
  }
  Object.values(record).forEach((item) => collectJsonMessages(item, result, nextContext, strict))
  return result
}

function flattenJson(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return []
  if (typeof value !== 'object') return [`${prefix}${String(value)}`]
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenJson(item, `${prefix}[${index}] `))
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => flattenJson(item, `${prefix}${key}: `))
}

function parseTextLine(line: string): ParsedLine | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  const timestampPrefix = /^(?:\[\s*)?(\d{4}\s*(?:年|[-/])\s*\d{1,2}\s*(?:月|[-/])\s*\d{1,2}(?:\s*[日号])?(?:[ T]+\d{1,2}(?:\s*[:时]\s*\d{1,2})?(?:\s*[:分]\s*\d{1,2})?\s*(?:秒)?)?)(?:\s*\])?\s*/
  const timestampMatch = trimmed.match(timestampPrefix)
  if (!timestampMatch) return trimmed.length >= 2 ? { text: trimmed } : undefined

  const timestamp = normalizeCapturedAt(timestampMatch[1])
  const remainder = trimmed.slice(timestampMatch[0].length).replace(/^[-|：:]+\s*/, '').trim()
  if (!remainder) return timestamp ? { text: '', timestamp } : undefined
  const speakerMatch = remainder.match(/^([^：:]{1,48})[：:]\s*(.+)$/)
  return {
    text: speakerMatch ? speakerMatch[2].trim() : remainder,
    timestamp,
    speaker: speakerMatch ? speakerMatch[1].trim() : undefined,
  }
}

function meaningfulLines(text: string): ParsedLine[] {
  const lines: ParsedLine[] = []
  let timestamp: string | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseTextLine(rawLine)
    if (!parsed) continue
    if (!parsed.text) {
      timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : timestamp
      continue
    }
    if (parsed.timestamp) timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined
    if (parsed.text.length >= 2) lines.push({ ...parsed, timestamp: parsed.timestamp ?? timestamp })
  }
  return lines
}

function parseCsvRows(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1 } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(field); field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((cell) => cell.trim())) rows.push(row)
      row = []; field = ''
    } else field += character
  }
  row.push(field)
  if (row.some((cell) => cell.trim())) rows.push(row)
  return rows
}

function parseCsvMessages(text: string): ParsedLine[] {
  const rows = parseCsvRows(text)
  if (rows.length < 2) return meaningfulLines(text)
  const headers = rows[0].map(normalizedKey)
  const contentIndex = headers.findIndex((header) => contentKeys.includes(header))
  const timeIndex = headers.findIndex((header) => timeKeys.includes(header))
  const speakerIndex = headers.findIndex((header) => speakerKeys.includes(header))
  const messageTypeIndex = headers.findIndex((header) => messageTypeKeys.includes(header))
  const roleIndex = headers.findIndex((header) => selfRoleKeys.includes(header) || directionRoleKeys.includes(header))
  if (contentIndex < 0) return meaningfulLines(text)
  return rows.slice(1)
    .map((row) => ({
      text: readableText(row[contentIndex]),
      timestamp: timeIndex >= 0 ? readableTimestamp(row[timeIndex]) : '',
      speaker: speakerIndex >= 0 ? readableText(row[speakerIndex]) : '',
      messageType: messageTypeIndex >= 0 ? String(row[messageTypeIndex] ?? '').trim().slice(0, 80) : '',
      speakerRole: roleIndex >= 0 ? roleFromValue(row[roleIndex], headers[roleIndex]) : 'unknown',
    }))
    .filter((item) => item.text.length >= 2)
}

function inferSource(fileName: string, path = ''): IntelItem['source'] {
  const normalized = `${path}/${fileName}`.toLowerCase()
  if (/(?:chatgpt|openai|deepseek|gemini|claude|ai[-_ ]?chat)/i.test(normalized)) return 'AI 对话导入'
  if (normalized.includes('朋友圈') || normalized.includes('moments') || normalized.includes('friendcircle')) return '朋友圈导出'
  if (normalized.includes('微信') || normalized.includes('wechat') || normalized.includes('weixin')) return '微信导出'
  if (normalized.includes('qq')) return 'QQ 导出'
  if (normalized.includes('校园') || normalized.includes('campus') || normalized.includes('school')) return '校园平台'
  return '本地文件'
}

function conversationContext(file: File, path?: string) {
  const normalizedPath = (path || file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const parts = normalizedPath.split('/').filter(Boolean)
  const folders = parts.slice(0, -1)
  const fileStem = file.name.replace(/\.[^.]+$/, '')
  const groupIndex = folders.findIndex((folder) => /(群聊|群组|群消息|group|groups|chatroom)/i.test(folder))
  const directIndex = folders.findIndex((folder) => /(私聊|单聊|好友|friend|direct|personal)/i.test(folder))
  const categoryIndex = groupIndex >= 0 ? groupIndex : directIndex
  // AI exports use one extra namespace level so the provider name is not
  // mistaken for the actual conversation identity:
  // direct/AI/<provider>/<conversation>/messages.json.
  const aiRootIndex = folders.findIndex((folder) => /^(?:ai|ai[-_ ]?chat|对话ai)$/i.test(folder))
  const hasAiConversationFolder = categoryIndex >= 0
    && aiRootIndex === categoryIndex + 1
    && Boolean(folders[aiRootIndex + 2])
  const fileIsGroup = /^(?:群聊|群组|群消息|group|groups|chatroom)[\s_-]*/i.test(fileStem)
  const fileIsDirect = /^(?:私聊|单聊|好友|friend|direct|personal)[\s_-]*/i.test(fileStem)
  const hasCategoryFolder = categoryIndex >= 0
  // Exports commonly place message files inside a shared data/logs subfolder.
  // The folder immediately below 群聊/私聊 is the actual conversation identity.
  const conversationFolders = hasAiConversationFolder
    ? folders.slice(0, aiRootIndex + 3)
    : hasCategoryFolder && folders[categoryIndex + 1]
    ? folders.slice(0, categoryIndex + 2)
    : folders
  // Some exporters use flat filenames such as “私聊_Alice.json” instead of a
  // 私聊/Alice folder. Treat that filename as the conversation identity rather
  // than merging every flat export into one unknown conversation.
  const fileDefinesConversation = fileIsGroup || fileIsDirect || (hasCategoryFolder && !folders[categoryIndex + 1])
  const conversationPath = fileDefinesConversation
    ? [...folders, fileStem].join('/')
    : conversationFolders.join('/') || fileStem
  const kind: NonNullable<IntelItem['conversationKind']> = groupIndex >= 0
    ? 'group'
    : directIndex >= 0
      ? 'direct'
      : fileIsGroup
        ? 'group'
        : fileIsDirect
          ? 'direct'
          : 'unknown'
  return {
    conversationId: `folder:${conversationPath}`,
    conversationName: fileDefinesConversation ? fileStem : conversationFolders.at(-1) || fileStem,
    conversationKind: kind,
  }
}

export async function parseIntelFileContent(file: File, context: ImportContext = {}): Promise<IntelItem[]> {
  const raw = await file.text()
  let lines: ParsedLine[]

  if (file.name.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(raw) as unknown
    const speakerAvatars = collectSpeakerAvatars(parsed)
    const sessionAvatar = sessionAvatarUrl(parsed)
    const strictDirectoryImport = Boolean(context.path)
    const messages = collectJsonMessages(parsed, [], {}, strictDirectoryImport)
    lines = messages.length
      ? messages.map((message) => ({
        ...message,
        avatarUrl: message.avatarUrl || (message.speaker ? speakerAvatars.get(message.speaker) : undefined) || sessionAvatar || undefined,
      }))
      : strictDirectoryImport ? [] : flattenJson(parsed).filter((line) => line.length >= 8).map((text) => ({ text }))
  } else if (file.name.toLowerCase().endsWith('.csv')) {
    lines = parseCsvMessages(raw)
  } else {
    lines = meaningfulLines(raw)
  }

  const source = inferSource(file.name, context.path)
  const conversation = conversationContext(file, context.path)
  return deduplicateIntelAvatars(lines.map((line, index) => {
    const summary = [line.speaker ? `${line.speaker}:` : '', line.text].filter(Boolean).join(' ').slice(0, 1200)
    const recordKey = [context.path ?? file.name, line.timestamp ?? '', line.speaker ?? '', line.text, index].join('|')
    return {
    id: `import-${stableHash(recordKey)}-${index}`,
    title: summary.length > 22 ? `${summary.slice(0, 22)}...` : summary,
    summary,
    // Keep the exporter-provided message body intact. The task pipeline sends
    // one complete conversation to the model rather than a shortened excerpt.
    content: line.text,
    source,
    sourceFile: context.path || file.name,
    ...conversation,
    speaker: line.speaker || undefined,
    avatarUrl: line.avatarUrl || undefined,
    messageType: line.messageType || undefined,
    speakerRole: line.speakerRole ?? 'unknown',
    // File modification time is not a chat timestamp. Leaving it empty avoids
    // incorrectly resolving relative dates against an import or export time.
    capturedAt: normalizeCapturedAt(line.timestamp) ?? '',
    status: 'new',
  }}))
}

const WORKER_PARSE_THRESHOLD_BYTES = 1024 * 1024

/** Parse large exports off the renderer thread while keeping tests and small files synchronous. */
export async function parseIntelFile(file: File, context: ImportContext = {}): Promise<IntelItem[]> {
  if (typeof Worker === 'undefined' || Number(file.size) < WORKER_PARSE_THRESHOLD_BYTES) return parseIntelFileContent(file, context)
  return new Promise<IntelItem[]>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/intelParser.worker.ts', import.meta.url), { type: 'module', name: 'theia-intel-parser' })
    const finish = () => worker.terminate()
    worker.onmessage = (event: MessageEvent<{ items?: IntelItem[]; error?: string }>) => {
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(event.data.items ?? [])
    }
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || '后台导入解析失败'))
    }
    worker.postMessage({ file, context })
  })
}

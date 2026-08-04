import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const taskLogDirectory = resolve(root, '.theia-task-logs')
const archivePath = resolve(root, '.theia-shared-intel.json')

function conversationKind(value) {
  if (/(?:群聊|群组|群消息|group|groups|chatroom)/i.test(value)) return 'group'
  if (/(?:私聊|单聊|好友|friend|direct|personal)/i.test(value)) return 'direct'
  return 'unknown'
}

function parseTaskRequest(raw) {
  const firstLine = raw.split(/\r?\n/, 1)[0]
  if (!firstLine) return null
  try {
    const entry = JSON.parse(firstLine)
    return entry?.kind === 'task-extraction' && entry.request?.conversation && Array.isArray(entry.request.records)
      ? { startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : new Date().toISOString(), request: entry.request }
      : null
  } catch {
    return null
  }
}

function restoreItem(record, conversation, startedAt) {
  const content = String(record?.content ?? '').trim()
  const speaker = typeof record?.senderDisplayName === 'string' ? record.senderDisplayName.trim() : ''
  const capturedAt = typeof record?.formattedTime === 'string' && record.formattedTime.trim() ? record.formattedTime.trim() : startedAt
  const id = typeof record?.id === 'string' && record.id.trim()
    ? record.id.trim()
    : `${conversation.id}:${capturedAt}:${speaker}:${content}`
  return {
    id,
    title: content.slice(0, 120) || speaker || '聊天记录',
    summary: content || speaker || '无文字内容',
    content,
    source: '本地文件',
    conversationId: String(conversation.id ?? ''),
    conversationName: String(conversation.name ?? conversation.id ?? '导出会话'),
    conversationKind: conversationKind(`${conversation.name ?? ''}/${conversation.id ?? ''}`),
    speaker: speaker || undefined,
    messageType: typeof record?.type === 'string' ? record.type.slice(0, 80) : undefined,
    speakerRole: ['self', 'other', 'unknown'].includes(record?.speakerRole) ? record.speakerRole : 'unknown',
    capturedAt,
    status: 'reviewed',
    aiAnalyzedAt: startedAt,
  }
}

async function existingArchiveCount() {
  try {
    const value = JSON.parse(await readFile(archivePath, 'utf8'))
    return Array.isArray(value) ? value.length : Array.isArray(value?.items) ? value.items.length : 0
  } catch {
    return 0
  }
}

const records = new Map()
const files = await readdir(taskLogDirectory)
let parsedFiles = 0
for (const file of files) {
  if (!file.includes('-task-extraction-') || !file.endsWith('.jsonl')) continue
  const parsed = parseTaskRequest(await readFile(resolve(taskLogDirectory, file), 'utf8'))
  if (!parsed) continue
  parsedFiles += 1
  const { conversation } = parsed.request
  for (const record of parsed.request.records) {
    const item = restoreItem(record, conversation, parsed.startedAt)
    // The same message appears in overlap windows. Keep its newest recovered
    // analysis timestamp while writing one original record back to the archive.
    const previous = records.get(item.id)
    if (!previous || previous.aiAnalyzedAt < item.aiAnalyzedAt) records.set(item.id, item)
  }
}

const items = [...records.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id))
const existingCount = await existingArchiveCount()
if (existingCount > items.length) {
  console.log(`Skipped recovery: existing shared archive has ${existingCount} records; logs contain ${items.length}.`)
  process.exit(0)
}

const temporary = `${archivePath}.tmp`
await writeFile(temporary, JSON.stringify({ updatedAt: new Date().toISOString(), items }), 'utf8')
await rename(temporary, archivePath)
console.log(`Recovered ${items.length} records from ${parsedFiles} task logs into the local shared archive.`)

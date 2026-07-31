import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Check, ChevronDown, ChevronRight, CircleStop, Clock3, FileJson, FileText, FolderOpen, FolderSync, GraduationCap, ImagePlus, LockKeyhole, MessageCircle, MessagesSquare, RefreshCw, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import type { AiFeedbackReason, AiSettings, AiTaskCandidate, ArchiveAnalysisSummary, ArchiveSummary, IntelItem, Person } from '../types'
import { parseIntelFile } from '../lib/importer'
import { sourceProvider } from '../lib/people'
import { chooseExportDirectory, DIRECTORY_IMPORT_SIGNATURE_VERSION, ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle, scanExportDirectory, supportsDirectorySync, type LocalDirectoryHandle } from '../lib/directorySync'
import { analyzeIntel, buildDirectConversationFallbackPeople, fileToAttachment, getAiStatus, type AiAttachment, type AiDebugEntry, type AiProgress, type AiStatus } from '../lib/aiClient'
import { formatQuestTime } from '../lib/questTime'
import { normalizeAiConcurrency } from '../lib/aiConcurrency'

export interface AnalysisWorkState {
  stage: 'tasks' | 'people'
  completed: number
  total: number
  candidates: number
  message: string
}

interface IntelViewProps {
  items: IntelItem[]
  archive: ArchiveSummary
  candidates: AiTaskCandidate[]
  aiSettings: AiSettings
  onImport: (items: IntelItem[]) => { added: number; updated: number; duplicates: number; archiveMessageCount: number; conversationCount: number }
  onAiAnalysis: (candidates: AiTaskCandidate[], analyzedIds: string[], settings: AiSettings, summary: Omit<ArchiveAnalysisSummary, 'analyzedAt'>, peopleIncludedConversationIds: string[]) => void
  onDirectPeopleDetected: (people: Person[]) => void
  onCreateAiQuests: (candidates: AiTaskCandidate[]) => number
  onDismissAiCandidates: (ids: string[], reason?: AiFeedbackReason) => void
  onAnalysisWorkChange: (state: AnalysisWorkState | null) => void
  conversationRequest?: { id: string; sequence: number }
}

type AutomationState = 'idle' | 'restoring' | 'watching' | 'needs-permission' | 'unsupported' | 'error'
type AnalysisScope = 'unprocessed' | 'new' | 'all'
type TimelineFilterMode = 'last-chat' | 'strict-window'

// Reparse previously imported exports once so legacy month-based records gain
// their folder-derived conversation identity.
const IMPORTED_FILES_KEY = 'theia:imported-file-signatures:v8'
const AI_DEBUG_LOG_KEY = 'theia:ai-debug-log:v1'
const MAX_TRACKED_IMPORT_FILES = 20_000
const MAX_DEBUG_LOG_ENTRIES = 800
const CANDIDATE_ROW_HEIGHT = 184
const CANDIDATE_OVERSCAN = 5
const MESSAGE_ROW_HEIGHT = 118
const MESSAGE_OVERSCAN = 5

interface ConversationTimeline {
  id: string
  name: string
  kind: NonNullable<IntelItem['conversationKind']>
  source: IntelItem['source']
  records: IntelItem[]
  firstAt?: string
  lastAt?: string
}

const connectors = [
  { name: '微信', detail: '识别微信导出文本和结构化记录', icon: MessageCircle },
  { name: 'QQ', detail: '识别 QQ 聊天导出记录', icon: FileText },
  { name: '校园平台', detail: '接收课程、缴费和通知导出文件', icon: GraduationCap },
]

function loadImportedSignatures() {
  try { return new Set<string>(JSON.parse(localStorage.getItem(IMPORTED_FILES_KEY) ?? '[]') as string[]) } catch { return new Set<string>() }
}

function loadAiDebugLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_DEBUG_LOG_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is AiDebugEntry => Boolean(entry && typeof entry === 'object' && typeof (entry as AiDebugEntry).at === 'string' && typeof (entry as AiDebugEntry).event === 'string')).slice(0, MAX_DEBUG_LOG_ENTRIES)
  } catch { return [] }
}

function debugEventLabel(event: string) {
  const labels: Record<string, string> = {
    run_started: '开始提炼',
    conversation_request_started: '请求开始',
    conversation_retry_scheduled: '自动重连',
    conversation_request_succeeded: '请求完成',
    conversation_request_failed: '请求失败',
    conversation_skipped_unverified_direction: '跳过会话',
    run_cancelled: '已停止',
    people_run_cancelled: '人物提炼已停止',
    people_run_started: '人物处理开始',
    people_run_no_direct_conversation: '未识别私聊',
    people_segment_started: '人物片段请求',
    people_segment_succeeded: '人物片段完成',
    people_segment_failed: '人物片段失败',
    people_run_completed: '人物处理结束',
    run_completed: '提炼结束',
  }
  return labels[event] ?? event
}

function formatLastRun(value?: string) {
  if (!value) return '尚未运行模型分析'
  return `上次模型分析：${new Date(value).toLocaleString('zh-CN')}`
}

function isDue(lastRunAt: string | undefined, intervalHours: number) {
  return !lastRunAt || Date.now() - new Date(lastRunAt).getTime() >= Math.max(24, intervalHours) * 60 * 60 * 1000
}

function chatTimestamp(value: string) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

function conversationKey(item: IntelItem) {
  if (item.conversationId) return item.conversationId
  const month = item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] ?? 'undated'
  return `legacy:${item.source}:${month}`
}

function fullConversationRecords(items: IntelItem[], selectedItems: IntelItem[]) {
  const selectedConversationIds = new Set(selectedItems.map(conversationKey))
  return items.filter((item) => selectedConversationIds.has(conversationKey(item)))
}

function incrementalConversationRecords(items: IntelItem[], newItems: IntelItem[], contextRecords = 16) {
  const newIds = new Set(newItems.map((item) => item.id))
  const selectedConversations = new Set(newItems.map(conversationKey))
  const includedIds = new Set<string>()
  const grouped = new Map<string, IntelItem[]>()
  for (const item of items) {
    const key = conversationKey(item)
    if (!selectedConversations.has(key)) continue
    const records = grouped.get(key)
    if (records) records.push(item)
    else grouped.set(key, [item])
  }
  for (const records of grouped.values()) {
    records.sort((left, right) => chatTimestamp(left.capturedAt) - chatTimestamp(right.capturedAt))
    records.forEach((item, index) => {
      if (!newIds.has(item.id)) return
      for (let cursor = Math.max(0, index - contextRecords); cursor <= index; cursor += 1) includedIds.add(records[cursor].id)
    })
  }
  return items.filter((item) => includedIds.has(item.id))
}

function buildConversationTimeline(items: IntelItem[]): ConversationTimeline[] {
  const grouped = new Map<string, IntelItem[]>()
  for (const item of items) {
    const key = conversationKey(item)
    const records = grouped.get(key)
    if (records) records.push(item)
    else grouped.set(key, [item])
  }
  return [...grouped.entries()].map(([id, records]) => {
    const ordered = [...records].sort((left, right) => {
      const leftTime = chatTimestamp(left.capturedAt)
      const rightTime = chatTimestamp(right.capturedAt)
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0
      if (Number.isNaN(leftTime)) return 1
      if (Number.isNaN(rightTime)) return -1
      return leftTime - rightTime
    })
    const dated = ordered.filter((item) => Number.isFinite(chatTimestamp(item.capturedAt)))
    const first = ordered[0]
    return {
      id,
      name: first.conversationName || first.source,
      kind: first.conversationKind ?? 'unknown',
      source: first.source,
      records: ordered,
      firstAt: dated[0]?.capturedAt,
      lastAt: dated.at(-1)?.capturedAt,
    }
  }).sort((left, right) => (chatTimestamp(right.lastAt ?? '') || -Infinity) - (chatTimestamp(left.lastAt ?? '') || -Infinity))
}

function withinLastChatRange(conversation: ConversationTimeline, start: string, end: string) {
  if (!start && !end) return true
  const lastAt = chatTimestamp(conversation.lastAt ?? '')
  if (!Number.isFinite(lastAt)) return false
  const startAt = start ? new Date(`${start}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
  const endAt = end ? new Date(`${end}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY
  return lastAt >= startAt && lastAt <= endAt
}

function withinStrictTimeRange(item: IntelItem, start: string, end: string) {
  if (!start && !end) return true
  const capturedAt = chatTimestamp(item.capturedAt)
  if (!Number.isFinite(capturedAt)) return false
  const startAt = start ? new Date(`${start}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
  const endAt = end ? new Date(`${end}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY
  return capturedAt >= startAt && capturedAt <= endAt
}

function formatChatTime(value?: string) {
  if (!value) return '未记录时间'
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '未记录时间'
}

function timelineBucket(conversation: ConversationTimeline) {
  return conversation.lastAt?.slice(0, 7) || '未记录时间'
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function IntelView({ items, archive, candidates, aiSettings, onImport, onAiAnalysis, onDirectPeopleDetected, onCreateAiQuests: createAiQuests, onDismissAiCandidates, onAnalysisWorkChange, conversationRequest }: IntelViewProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const attachmentRef = useRef<HTMLInputElement>(null)
  const handleRef = useRef<LocalDirectoryHandle | null>(null)
  const busyRef = useRef(false)
  const aiBusyRef = useRef(false)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const importedRef = useRef(loadImportedSignatures())
  const onImportRef = useRef(onImport)
  const itemsRef = useRef(items)
  const [message, setMessage] = useState('记录默认只在本机解析；点击模型分析后，选中的记录才会发送到本机代理。')
  const [busy, setBusy] = useState(false)
  const [automationState, setAutomationState] = useState<AutomationState>('restoring')
  const [folderName, setFolderName] = useState('')
  const [lastScan, setLastScan] = useState('尚未扫描')
  const [scanStats, setScanStats] = useState({ files: 0, changed: 0, records: 0 })
  const [scope, setScope] = useState<AnalysisScope>('all')
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([])
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null)
  const [aiMessage, setAiMessage] = useState('')
  const [retryConversationIds, setRetryConversationIds] = useState<string[]>([])
  const [debugLog, setDebugLog] = useState<AiDebugEntry[]>(loadAiDebugLog)
  const [timelineStart, setTimelineStart] = useState('')
  const [timelineEnd, setTimelineEnd] = useState('')
  const [timelineMode, setTimelineMode] = useState<TimelineFilterMode>('last-chat')
  const [analysisConversationId, setAnalysisConversationId] = useState('')
  const [openSections, setOpenSections] = useState({ intake: true, analysis: true, debug: true, created: false, candidates: true, conversations: true })
  const [selectedConversationId, setSelectedConversationId] = useState<string>()
  const [messageScrollTop, setMessageScrollTop] = useState(0)
  const [messageViewportHeight, setMessageViewportHeight] = useState(600)
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set())
  const [candidateScrollTop, setCandidateScrollTop] = useState(0)
  const [candidateViewportHeight, setCandidateViewportHeight] = useState(600)
  const candidateListRef = useRef<HTMLDivElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const candidateScrollFrame = useRef(0)
  const messageScrollFrame = useRef(0)
  const pendingCandidateScrollTop = useRef(0)
  const pendingMessageScrollTop = useRef(0)
  const pendingCandidates = useMemo(() => candidates.filter((candidate) => candidate.status === 'pending'), [candidates])
  const createdCandidates = useMemo(() => candidates.filter((candidate) => candidate.status === 'created'), [candidates])
  const validSelectedCandidates = useMemo(() => {
    const available = new Set(pendingCandidates.map((candidate) => candidate.id))
    return new Set([...selectedCandidates].filter((id) => available.has(id)))
  }, [pendingCandidates, selectedCandidates])
  const intelById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const conversations = useMemo(() => buildConversationTimeline(items), [items])
  const filteredConversations = useMemo(() => conversations.filter((conversation) => timelineMode === 'last-chat'
    ? withinLastChatRange(conversation, timelineStart, timelineEnd)
    : conversation.records.some((item) => withinStrictTimeRange(item, timelineStart, timelineEnd))), [conversations, timelineEnd, timelineMode, timelineStart])
  const analysisConversation = useMemo(() => conversations.find((conversation) => conversation.id === analysisConversationId), [analysisConversationId, conversations])
  const analysisMessages = useMemo(() => {
    if (analysisConversationId) {
      const records = analysisConversation?.records ?? []
      return timelineMode === 'strict-window'
        ? records.filter((item) => withinStrictTimeRange(item, timelineStart, timelineEnd))
        : records
    }
    const scopeMatches = scope === 'all'
      ? items
      : items.filter((item) => item.status === 'new' && (scope === 'new' || !item.aiAnalyzedAt))
    if (timelineMode === 'strict-window') {
      // Strict mode deliberately excludes messages outside the chosen window.
      // It is for time-bounded extraction, not whole-conversation context.
      return scopeMatches.filter((item) => withinStrictTimeRange(item, timelineStart, timelineEnd))
    }
    const timeConversationIds = new Set(filteredConversations.map((conversation) => conversation.id))
    const timeMatches = !timelineStart && !timelineEnd
      ? scopeMatches
      : scopeMatches.filter((item) => timeConversationIds.has(conversationKey(item)))
    // Scope and time filters choose conversations. Once selected, send each
    // selected conversation's full history, not just matching message rows.
    return fullConversationRecords(items, timeMatches)
  }, [analysisConversation, analysisConversationId, filteredConversations, items, scope, timelineEnd, timelineMode, timelineStart])
  const analysisConversationCount = useMemo(() => new Set(analysisMessages.map(conversationKey)).size, [analysisMessages])
  const conversationsByPeriod = useMemo(() => {
    const groups = new Map<string, ConversationTimeline[]>()
    for (const conversation of filteredConversations) {
      const bucket = timelineBucket(conversation)
      const current = groups.get(bucket)
      if (current) current.push(conversation)
      else groups.set(bucket, [conversation])
    }
    return [...groups.entries()]
  }, [filteredConversations])
  const selectedConversation = useMemo(() => filteredConversations.find((conversation) => conversation.id === selectedConversationId), [filteredConversations, selectedConversationId])
  const selectedConversationRecords = selectedConversation?.records ?? []
  const safeMessageScrollTop = Math.min(messageScrollTop, Math.max(0, selectedConversationRecords.length * MESSAGE_ROW_HEIGHT - messageViewportHeight))
  const firstMessage = Math.max(0, Math.floor(safeMessageScrollTop / MESSAGE_ROW_HEIGHT) - MESSAGE_OVERSCAN)
  const lastMessage = Math.min(selectedConversationRecords.length, Math.ceil((safeMessageScrollTop + messageViewportHeight) / MESSAGE_ROW_HEIGHT) + MESSAGE_OVERSCAN)
  const renderedMessages = selectedConversationRecords.slice(firstMessage, lastMessage)
  const safeCandidateScrollTop = Math.min(candidateScrollTop, Math.max(0, pendingCandidates.length * CANDIDATE_ROW_HEIGHT - candidateViewportHeight))
  const firstCandidate = Math.max(0, Math.floor(safeCandidateScrollTop / CANDIDATE_ROW_HEIGHT) - CANDIDATE_OVERSCAN)
  const lastCandidate = Math.min(pendingCandidates.length, Math.ceil((safeCandidateScrollTop + candidateViewportHeight) / CANDIDATE_ROW_HEIGHT) + CANDIDATE_OVERSCAN)
  const renderedCandidates = pendingCandidates.slice(firstCandidate, lastCandidate)

  useEffect(() => {
    if (!conversationRequest) return
    // A people card should open the complete source conversation even if the
    // user previously narrowed the archive with a time-window filter.
    const timer = window.setTimeout(() => {
      setTimelineMode('last-chat')
      setTimelineStart('')
      setTimelineEnd('')
      setOpenSections((current) => ({ ...current, conversations: true }))
      setSelectedConversationId(conversationRequest.id)
      setMessageScrollTop(0)
      if (messageListRef.current) messageListRef.current.scrollTop = 0
    }, 0)
    return () => window.clearTimeout(timer)
  }, [conversationRequest])

  useEffect(() => { onImportRef.current = onImport }, [onImport])
  useEffect(() => { itemsRef.current = items }, [items])
  const appendDebugLog = useCallback((entry: AiDebugEntry) => {
    setDebugLog((current) => {
      const next = [entry, ...current].slice(0, MAX_DEBUG_LOG_ENTRIES)
      try { localStorage.setItem(AI_DEBUG_LOG_KEY, JSON.stringify(next)) } catch { /* A full browser cache must not interrupt analysis. */ }
      return next
    })
  }, [])
  useEffect(() => {
    const relay = (event: Event) => {
      const entry = (event as CustomEvent<AiDebugEntry>).detail
      if (!entry || typeof entry.event !== 'string' || typeof entry.at !== 'string') return
      appendDebugLog(entry)
    }
    window.addEventListener('theia:ai-debug', relay)
    return () => window.removeEventListener('theia:ai-debug', relay)
  }, [appendDebugLog])
  const clearDebugLog = () => {
    setDebugLog([])
    try { localStorage.removeItem(AI_DEBUG_LOG_KEY) } catch { /* Non-critical local cleanup. */ }
  }
  useEffect(() => {
    const element = candidateListRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setCandidateViewportHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const element = messageListRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setMessageViewportHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [selectedConversationId])
  useEffect(() => {
    void getAiStatus().then(setAiStatus).catch(() => setAiMessage('无法连接本机模型代理，请在选项中配置模型通道。'))
  }, [])

  const syncDirectory = useCallback(async (handle: LocalDirectoryHandle, force = false) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const files = await scanExportDirectory(handle)
      const importSignature = (entry: typeof files[number]) => entry.file.name.toLowerCase().endsWith('.json')
        ? `${entry.signature}:${DIRECTORY_IMPORT_SIGNATURE_VERSION}`
        : entry.signature
      const freshFiles = force ? files : files.filter((entry) => !importedRef.current.has(importSignature(entry)))
      const importedItems: IntelItem[] = []
      for (const [index, entry] of freshFiles.entries()) {
        const parsed = await parseIntelFile(entry.file, { path: entry.path })
        importedItems.push(...parsed)
        importedRef.current.add(importSignature(entry))
        // A large export may contain thousands of files. Yield regularly so the
        // desktop UI can keep painting and the user can still change sections.
        if (index > 0 && index % 8 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }
      try { localStorage.setItem(IMPORTED_FILES_KEY, JSON.stringify([...importedRef.current].slice(-MAX_TRACKED_IMPORT_FILES))) } catch { /* quota is non-fatal */ }
      const merged = importedItems.length ? onImportRef.current(importedItems) : undefined
      const now = new Date().toLocaleTimeString('zh-CN')
      setLastScan(`${now} · 扫描 ${files.length} 个文件 · 处理 ${freshFiles.length} 个`)
      setScanStats({ files: files.length, changed: freshFiles.length, records: importedItems.length })
      setMessage(merged
        ? `${force ? '已重新解析' : '已解析'} ${freshFiles.length} 个导出文件：${formatCount(importedItems.length)} 条解析消息，新增 ${formatCount(merged.added)} 条，更新 ${formatCount(merged.updated)} 条，已存在 ${formatCount(merged.duplicates)} 条。`
        : '目录已是最新状态。')
      setAutomationState('watching')
    } catch {
      setMessage('目录扫描失败，请重新授权或确认文件没有被占用。')
      setAutomationState('error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      if (!supportsDirectorySync()) { if (!cancelled) setAutomationState('unsupported'); return }
      try {
        const saved = await loadDirectoryHandle()
        if (!saved) { if (!cancelled) setAutomationState('idle'); return }
        handleRef.current = saved
        if (!cancelled) setFolderName(saved.name)
        const allowed = await ensureDirectoryPermission(saved)
        if (!cancelled) setAutomationState(allowed ? 'watching' : 'needs-permission')
        if (allowed && !cancelled) await syncDirectory(saved)
      } catch { if (!cancelled) setAutomationState('idle') }
    }
    void restore()
    return () => { cancelled = true }
  }, [syncDirectory])

  const connectDirectory = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      let handle = handleRef.current
      if (handle && !(await ensureDirectoryPermission(handle, true))) handle = null
      if (!handle) handle = await chooseExportDirectory()
      await saveDirectoryHandle(handle)
      handleRef.current = handle
      setFolderName(handle.name)
      setAutomationState('watching')
      busyRef.current = false
      setBusy(false)
      await syncDirectory(handle)
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError') { setMessage('目录连接失败，请检查浏览器权限后重试。'); setAutomationState('error') }
      busyRef.current = false
      setBusy(false)
    }
  }

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    if (!files.length || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const parsed = (await Promise.all(files.map((file) => parseIntelFile(file)))).flat()
      const merged = parsed.length ? onImport(parsed) : undefined
      setMessage(merged
        ? `已从 ${files.length} 个文件解析 ${formatCount(parsed.length)} 条消息：新增 ${formatCount(merged.added)} 条，更新 ${formatCount(merged.updated)} 条，已存在 ${formatCount(merged.duplicates)} 条。`
        : '没有发现足够完整的文本行。')
    } catch { setMessage('文件无法解析，请确认格式和编码后重试。') }
    finally { busyRef.current = false; setBusy(false); event.target.value = '' }
  }

  const addAttachments = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].filter((file) => file.size <= 8 * 1024 * 1024)
    setAttachmentFiles((current) => [...current, ...files].slice(0, 4))
    event.target.value = ''
  }

  /* Model setup moved to OptionsView.
  const configureProvider = useCallback(async (input?: AiProviderInput) => {
    if (providerBusy) return
    setProviderBusy(true)
    setProviderMessage('正在探测中转模型列表…')
    try {
      const status = await saveAiProvider(input ?? {
        _type: 'newapi_channel_conn',
        key: providerKey || undefined,
        url: providerUrl,
        model: providerModel || undefined,
        apiMode: providerMode,
      })
      applyProviderStatus(status)
      setProviderMessage(status.warning || `通道已保存，当前模型：${status.model}`)
    } catch (error) {
      setProviderMessage(error instanceof Error ? error.message : '中转配置失败。')
    } finally { setProviderBusy(false) }
  }, [applyProviderStatus, providerBusy, providerKey, providerMode, providerModel, providerUrl])

  const probeProviderModels = useCallback(async (input?: AiProviderInput) => {
    if (providerBusy) return
    setProviderBusy(true)
    setProviderMessage('正在检测中转模型列表…')
    try {
      const result = await discoverAiModels(input ?? {
        _type: 'newapi_channel_conn',
        key: providerKey || undefined,
        url: providerUrl,
        apiMode: providerMode,
      })
      setDiscoveredModels(result.models)
      if (!result.models.includes(providerModel)) setProviderModel(result.models[0])
      setProviderMessage(`检测到 ${result.models.length} 个模型，请选择后保存。`)
    } catch (error) {
      setDiscoveredModels([])
      setProviderMessage(error instanceof Error ? error.message : '模型列表探测失败。')
    } finally { setProviderBusy(false) }
  }, [providerBusy, providerKey, providerMode, providerModel, providerUrl])

  useEffect(() => {
    const url = providerUrl.trim()
    const key = providerKey.trim()
    if (!key || !isProviderUrlReady(url) || providerBusy) return
    const credentials = `${url}\u0000${key}`
    if (credentials === autoDetectedCredentials) return
    const timer = window.setTimeout(() => {
      setAutoDetectedCredentials(credentials)
      void probeProviderModels({ _type: 'newapi_channel_conn', key, url, apiMode: providerMode })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [autoDetectedCredentials, probeProviderModels, providerBusy, providerKey, providerMode, providerUrl])

  const chooseProviderModel = (model: string) => {
    setProviderModel(model)
    void configureProvider({ _type: 'newapi_channel_conn', key: providerKey || undefined, url: providerUrl, model, apiMode: providerMode })
  }

  const importProviderConfig = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as AiProviderInput
      if (parsed._type && parsed._type !== 'newapi_channel_conn') throw new Error('不支持的配置类型')
      await configureProvider({ ...parsed, _type: 'newapi_channel_conn' })
    } catch (error) {
      setProviderMessage(error instanceof Error ? error.message : '连接 JSON 无法解析。')
    }
  }

  const restoreEnvironmentProvider = async () => {
    if (providerBusy) return
    setProviderBusy(true)
    try {
      const status = await resetAiProvider()
      providerFormTouchedRef.current = false
      localStorage.removeItem(PROVIDER_DRAFT_KEY)
      setProviderKey('')
      applyProviderStatus(status)
      setProviderMessage(status.configured ? '已恢复环境变量中的模型通道。' : '本地通道已清除，环境变量中没有可用密钥。')
    } catch (error) { setProviderMessage(error instanceof Error ? error.message : '无法恢复环境配置。') }
    finally { setProviderBusy(false) }
  }

  */
  const runAiAnalysis = useCallback(async (automatic = false, retryIds: string[] = []) => {
    if (aiBusyRef.current) return
    const concurrency = normalizeAiConcurrency(aiSettings.concurrency)
    const automaticMatches = automatic
      ? itemsRef.current.filter((item) => item.status === 'new' && !item.aiAnalyzedAt)
      : []
    const retryMatches = retryIds.length ? itemsRef.current.filter((item) => retryIds.includes(conversationKey(item))) : []
    const retrySource = timelineMode === 'strict-window'
      ? analysisMessages.filter((item) => retryIds.includes(conversationKey(item)))
      : fullConversationRecords(itemsRef.current, retryMatches)
    const source = retryIds.length
      ? retrySource
      : automatic ? incrementalConversationRecords(itemsRef.current, automaticMatches) : analysisMessages
    if (!source.length) { setAiMessage('没有符合当前分析范围的记录。'); return }
    // Build local cards before any network call. A 20,000-message private
    // chat can take hundreds of task segments and must not leave People empty.
    onDirectPeopleDetected(buildDirectConversationFallbackPeople(source))
    aiBusyRef.current = true
    const controller = new AbortController()
    analysisAbortRef.current = controller
    setAiBusy(true)
    const selectedConversationCount = retryIds.length ? new Set(retryMatches.map(conversationKey)).size : automatic ? new Set(automaticMatches.map(conversationKey)).size : analysisConversationCount
    const startingMessage = retryIds.length
      ? `准备以 ${concurrency} 个并发会话重新提交 ${selectedConversationCount} 个失败会话的完整记录，共 ${formatCount(source.length)} 条消息。`
      : automatic
        ? `增量自动更新：以 ${concurrency} 个并发会话提交 ${formatCount(automaticMatches.length)} 条新增消息和 ${formatCount(source.length - automaticMatches.length)} 条前序上下文。`
        : `准备以 ${concurrency} 个并发会话提交 ${selectedConversationCount} 个完整对话，共 ${formatCount(source.length)} 条归档消息。`
    setAiProgress({ completed: 0, total: 0, candidates: 0 })
    setAiMessage(startingMessage)
    onAnalysisWorkChange({ stage: 'tasks', completed: 0, total: 0, candidates: 0, message: startingMessage })
    try {
      const attachments: AiAttachment[] = []
      for (const file of attachmentFiles) attachments.push(await fileToAttachment(file))
      const result = await analyzeIntel(source, attachments, aiSettings, (progress) => {
        const segmentLabel = progress.totalSegmentsInConversation
          ? `“${progress.currentConversation ?? '当前会话'}”第 ${progress.currentSegment}/${progress.totalSegmentsInConversation} 段`
          : `“${progress.currentConversation ?? '当前会话'}”`
        const progressMessage = progress.retryAttempt
          ? `${segmentLabel} 服务异常，${((progress.retryDelayMs ?? 0) / 1000).toFixed(1)} 秒后进行第 ${progress.retryAttempt}/${progress.retryTotal} 次自动重连。`
          : `已完成 ${progress.completed}/${progress.total} 个连续片段；${automatic ? '增量消息附带少量前序上下文' : '完整会话按时间覆盖上传，未做消息抽样'}。当前 ${segmentLabel}${progress.historicalSegment ? '（历史信息段）' : ''}；${concurrency} 个会话并行，得到 ${progress.candidates} 个候选。`
        setAiProgress(progress)
        setAiMessage(progressMessage)
        onAnalysisWorkChange({ stage: 'tasks', completed: progress.completed, total: progress.total, candidates: progress.candidates, message: progressMessage })
      }, appendDebugLog, onDirectPeopleDetected, { signal: controller.signal, concurrency })
      const retryableFailures = result.failedConversations.filter((conversation) => conversation.retryable)
      setRetryConversationIds(retryableFailures.map((conversation) => conversation.id))
      const automaticCoreIds = new Set(automaticMatches.map((item) => item.id))
      const acceptedCandidates = automatic
        ? result.candidates.filter((candidate) => candidate.sourceIds.some((id) => automaticCoreIds.has(id)))
        : result.candidates
      const analyzedIds = automatic ? [...automaticCoreIds] : result.analyzedIds
      onAiAnalysis(acceptedCandidates, analyzedIds, aiSettings, {
        sourceMessageCount: source.length,
        conversationCount: result.plan.totalConversations,
        processedConversationCount: result.processedConversations,
        requestedConversationCount: result.plan.totalConversations,
      }, result.peopleIncludedConversationIds)
      setSelectedCandidates(new Set(acceptedCandidates.map((candidate) => candidate.id)))
      if (acceptedCandidates.length) setOpenSections((current) => ({ ...current, candidates: true }))
      const progressSummary = [`已处理 ${result.processedSegments}/${result.plan.totalSegments} 个连续片段，完整完成 ${result.processedConversations}/${result.plan.totalConversations} 个对话。${automatic ? `本轮发送 ${formatCount(automaticMatches.length)} 条新增消息与 ${formatCount(source.length - automaticMatches.length)} 条前序上下文；候选必须引用新增消息。` : `范围内共有 ${formatCount(source.length)} 条原始消息；每个会话均按时间分段覆盖上传，未做抽样。`}`]
      if (result.cancelled) progressSummary.push('已停止本轮提炼；已完成片段的候选已保留在待确认列表。')
      if (result.failedConversations.length) {
        const firstFailure = result.failedConversations[0]
        progressSummary.push(`${result.failedConversations.length} 个会话未完成${retryableFailures.length ? `；其中 ${retryableFailures.length} 个可通过“重试失败会话”再次连接` : ''}。${firstFailure ? `最近错误：${firstFailure.name} · ${firstFailure.message}` : ''}`)
      }
      if (acceptedCandidates.length) {
        progressSummary.push(`${acceptedCandidates.length} 个候选已进入审核队列。`)
      } else if (result.diagnostics.rawCandidates === 0) {
        progressSummary.push(`模型对已请求的 ${result.diagnostics.attemptedConversations} 个片段均返回空候选；这不是前端删除造成的。`)
      } else {
        const rejected = result.diagnostics.rejectedOwnership + result.diagnostics.rejectedEvidence + result.diagnostics.rejectedExpired + result.diagnostics.rejectedDirection + result.diagnostics.rejectedInvalid + result.diagnostics.rejectedDuplicate
        progressSummary.push(`模型返回 ${result.diagnostics.rawCandidates} 个原始候选，校验排除了 ${rejected} 个（归属 ${result.diagnostics.rejectedOwnership}、证据 ${result.diagnostics.rejectedEvidence}、已过时 ${result.diagnostics.rejectedExpired}、方向错误 ${result.diagnostics.rejectedDirection}、格式 ${result.diagnostics.rejectedInvalid}、重复 ${result.diagnostics.rejectedDuplicate}）。`)
      }
      setAiMessage(progressSummary.join(' '))
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : '模型分析失败，请检查代理和密钥配置。'
      setAiMessage(failureMessage)
    } finally {
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null
      aiBusyRef.current = false
      setAiBusy(false)
      onAnalysisWorkChange(null)
    }
  }, [aiSettings, analysisConversationCount, analysisMessages, appendDebugLog, attachmentFiles, onAiAnalysis, onAnalysisWorkChange, onDirectPeopleDetected, timelineMode])

  const stopAiAnalysis = () => {
    if (!analysisAbortRef.current || !aiBusyRef.current) return
    setAiMessage('正在停止本轮提炼；已完成片段的候选会自动进入待确认列表。')
    analysisAbortRef.current.abort()
  }

  useEffect(() => {
    if (!aiSettings.autoEnabled) return
    const timer = window.setInterval(() => {
      if (aiStatus?.configured && !aiBusyRef.current && isDue(aiSettings.lastRunAt, aiSettings.intervalHours)) void runAiAnalysis(true)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [aiSettings.autoEnabled, aiSettings.intervalHours, aiSettings.lastRunAt, aiStatus?.configured, runAiAnalysis])

  const toggleCandidate = (id: string) => setSelectedCandidates((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const selectAllCandidates = () => setSelectedCandidates(new Set(pendingCandidates.map((candidate) => candidate.id)))
  const createCandidates = (next: AiTaskCandidate[]) => {
    const created = createAiQuests(next)
    setAiMessage(created
      ? `已生成 ${created} 条任务；候选会保留在下方“已生成任务”中，可追溯来源。`
      : '没有新增任务：所选候选可能已经生成，或已不在待确认队列中。')
  }
  const onCreateAiQuests = (next: AiTaskCandidate[]) => createCandidates(next)
  const createSelected = () => createCandidates(pendingCandidates.filter((candidate) => validSelectedCandidates.has(candidate.id)))
  const dismissCandidates = (ids: string[], reason: AiFeedbackReason = 'not-actionable') => {
    onDismissAiCandidates(ids, reason)
    setSelectedCandidates((current) => new Set([...current].filter((id) => !ids.includes(id))))
  }
  const handleCandidateScroll = (top: number) => {
    pendingCandidateScrollTop.current = top
    if (candidateScrollFrame.current) return
    candidateScrollFrame.current = window.requestAnimationFrame(() => {
      candidateScrollFrame.current = 0
      setCandidateScrollTop(pendingCandidateScrollTop.current)
    })
  }
  const handleMessageScroll = (top: number) => {
    pendingMessageScrollTop.current = top
    if (messageScrollFrame.current) return
    messageScrollFrame.current = window.requestAnimationFrame(() => {
      messageScrollFrame.current = 0
      setMessageScrollTop(pendingMessageScrollTop.current)
    })
  }
  const openConversation = (id: string) => {
    setSelectedConversationId(id)
    setMessageScrollTop(0)
    if (messageListRef.current) messageListRef.current.scrollTop = 0
  }
  const automationLabel = automationState === 'watching' ? `已连接 ${folderName}` : automationState === 'needs-permission' ? `等待重新授权 ${folderName}` : automationState === 'unsupported' ? '当前浏览器不支持目录访问' : '尚未连接导出目录'

  return (
    <div className="intel-view page-width">
      <section className={`intel-overview intel-collapsible-section ${openSections.intake ? 'is-open' : 'is-collapsed'}`}>
        <div className="page-intro">
          <div><span className="section-kicker">LOCAL AUTOMATION · 自动捕获导出记录</span><h2><button type="button" className="intel-section-toggle" aria-expanded={openSections.intake} onClick={() => setOpenSections((current) => ({ ...current, intake: !current.intake }))}>情报接入<ChevronDown size={17} /></button></h2></div>
          <div className="privacy-note"><ShieldCheck size={18} /><span>本机控制上传</span></div>
        </div>

        {openSections.intake && <>
        <div className={`automation-console automation-console--${automationState}`}>
          <div className="automation-pulse"><FolderSync size={23} /></div>
          <div className="automation-copy"><div><span>{automationLabel}</span>{automationState === 'watching' && <em>启动时已扫描一次</em>}</div><p>{message}</p><small>{lastScan}</small></div>
          <div className="automation-actions">
            {automationState === 'watching' && <button type="button" className="secondary-button batch-button" onClick={() => handleRef.current && void syncDirectory(handleRef.current, true)} disabled={busy}><RefreshCw size={15} />重新处理</button>}
            {automationState === 'watching' && <button type="button" className="icon-button" aria-label="立即扫描目录" onClick={() => handleRef.current && void syncDirectory(handleRef.current)} disabled={busy}><RefreshCw size={17} /></button>}
            <button type="button" className="primary-button" onClick={() => void connectDirectory()} disabled={busy || automationState === 'unsupported'}><FolderOpen size={16} />{folderName ? '重新连接' : '连接目录'}</button>
          </div>
        </div>
        {automationState === 'watching' && <div className="scan-stats" aria-label="扫描统计"><span><strong>{formatCount(scanStats.files)}</strong>个可解析导出文件</span><span><strong>{formatCount(scanStats.changed)}</strong>个新增或变动文件</span><span><strong>{formatCount(scanStats.records)}</strong>条本次解析消息（导入前）</span></div>}
        {archive.lastImport && <div className="scan-stats scan-stats--archive" aria-label="最近导入结果"><span>最近导入：解析 <strong>{formatCount(archive.lastImport.parsedMessageCount)}</strong> 条</span><span>新增 <strong>{formatCount(archive.lastImport.addedMessageCount)}</strong> 条</span><span>更新 <strong>{formatCount(archive.lastImport.updatedMessageCount)}</strong> 条</span><span>已存在 <strong>{formatCount(archive.lastImport.duplicateMessageCount)}</strong> 条</span></div>}
        <div className="connector-grid">{connectors.map(({ name, detail, icon: Icon }) => <article className="connector" key={name}><div className="connector-icon"><Icon size={21} /></div><div><h3>{name}</h3><p>{detail}</p></div><span>{automationState === 'watching' ? '自动识别' : '待目录'}</span></article>)}</div>
        <div className="import-zone"><div className="import-icon"><Upload size={23} /></div><div><h3>临时导入文本</h3><p>不连接目录时，也可以一次选择多份 JSON、CSV 或 TXT 导出记录。</p></div><input ref={inputRef} type="file" accept=".json,.csv,.txt" multiple onChange={importFiles} hidden /><button type="button" className="secondary-button" onClick={() => inputRef.current?.click()} disabled={busy}><FileJson size={17} />{busy ? '处理中…' : '选择文件'}</button></div>
        <div className="security-line"><LockKeyhole size={14} />不绕过登录或解密私人数据库；只读取你明确授权的导出目录。</div>
        </>}
      </section>

      <section className={`ai-console intel-list-section intel-collapsible-section ${openSections.analysis ? 'is-open' : 'is-collapsed'}`}>
        <div className="list-heading"><div><span className="section-kicker">MODEL WORKBENCH · 批量分析</span><h2><button type="button" className="intel-section-toggle" aria-expanded={openSections.analysis} onClick={() => setOpenSections((current) => ({ ...current, analysis: !current.analysis }))}>模型任务提炼<ChevronDown size={17} /></button></h2></div><span className={`ai-status ${aiStatus?.configured ? 'is-ready' : ''}`}>{aiStatus ? (aiStatus.configured ? `${aiStatus.provider} · ${aiStatus.model}` : '尚未配置通道') : '检查连接中…'}</span></div>
        {openSections.analysis && <>
        {/* Model and appearance controls moved to OptionsView.
        <div className="provider-console">
          <div className="provider-heading"><span><ServerCog size={16} />模型通道</span><small>{aiStatus?.source === 'local-file' ? `本地配置 · ${aiStatus.keyHint}` : '环境变量配置'}</small></div>
          <div className="provider-fields">
            <label><span>服务地址</span><input type="url" value={providerUrl} onChange={(event) => { providerFormTouchedRef.current = true; setProviderUrl(event.target.value); setAutoDetectedCredentials(''); setDiscoveredModels([]) }} placeholder="https://relay.example.com" /></label>
            <label><span>API Key</span><div className="provider-key-input"><KeyRound size={14} /><input type="text" autoComplete="off" spellCheck={false} value={providerKey} onChange={(event) => { providerFormTouchedRef.current = true; setProviderKey(event.target.value); setDiscoveredModels([]) }} placeholder={aiStatus?.keyHint || '粘贴中转密钥'} /></div></label>
            <label><span>模型 ID{availableModels.length ? ` · ${availableModels.length} 个可选` : ''}</span>{availableModels.length ? <select value={providerModel} onChange={(event) => chooseProviderModel(event.target.value)} disabled={providerBusy}>{!availableModels.includes(providerModel) && providerModel && <option value={providerModel}>{providerModel}</option>}{availableModels.map((model) => <option value={model} key={model}>{model}</option>)}</select> : <input value={providerModel} onChange={(event) => { providerFormTouchedRef.current = true; setProviderModel(event.target.value) }} placeholder="填写地址和 Key 后自动获取" />}</label>
            <label><span>接口模式</span><select value={providerMode} onChange={(event) => { providerFormTouchedRef.current = true; setProviderMode(event.target.value as AiStatus['apiMode']) }}><option value="auto">自动兼容</option><option value="responses">Responses API</option><option value="chat-completions">Chat Completions</option></select></label>
          </div>
          <div className="provider-actions">
            <button type="button" className="secondary-button" onClick={() => void probeProviderModels({ _type: 'newapi_channel_conn', key: providerKey || undefined, url: providerUrl, apiMode: providerMode })} disabled={providerBusy || !providerUrl}><Save size={15} />{providerBusy ? '检测中…' : '重新检测模型'}</button>
            {!availableModels.length && providerModel && <button type="button" className="secondary-button" onClick={() => void configureProvider()} disabled={providerBusy || !providerUrl}>保存手动模型</button>}
            <input ref={providerConfigRef} type="file" accept=".json,application/json" onChange={importProviderConfig} hidden />
            <button type="button" className="secondary-button" onClick={() => providerConfigRef.current?.click()} disabled={providerBusy}><FileJson size={15} />导入连接 JSON</button>
            <button type="button" className="icon-button" aria-label="恢复环境变量配置" onClick={() => void restoreEnvironmentProvider()} disabled={providerBusy}><RefreshCw size={15} /></button>
            <span>{aiStatus?.baseUrl || '尚未保存通道地址'}</span>
          </div>
          {providerMessage && <p className="provider-message" role="status">{providerMessage}</p>}
        </div>
        <div className="ai-controls ai-controls--four">
          <label><span>分析模式</span><select value={settings.mode} onChange={(event) => setSettings((current) => ({ ...current, mode: event.target.value as AiSettings['mode'] }))}><option value="balanced">平衡：任务与提醒</option><option value="action">行动优先</option><option value="planning">长期规划</option><option value="review">复盘与整理</option></select></label>
          <label><span>分析范围</span><select value={scope} onChange={(event) => setScope(event.target.value as AnalysisScope)}><option value="unprocessed">未分析的新记录</option><option value="new">全部新记录</option><option value="all">全部记录</option></select></label>
          <label><span>自动模型更新</span><select value={settings.intervalHours} onChange={(event) => setSettings((current) => ({ ...current, intervalHours: Math.max(24, Number(event.target.value)) }))}><option value="24">每 24 小时</option><option value="48">每 48 小时</option><option value="72">每 72 小时</option><option value="168">每 7 天</option></select></label>
        </div>
        <label className="ai-instructions"><span>自定义要求</span><textarea value={settings.instructions} onChange={(event) => setSettings((current) => ({ ...current, instructions: event.target.value }))} rows={3} placeholder="例如：优先识别开学、缴费、预约和需要回复的事项；把不确定日期留空。" /></label>
        <div className="attachment-row"><input ref={attachmentRef} type="file" accept="image/*,.pdf,.json,.csv,.txt" multiple onChange={addAttachments} hidden /><button type="button" className="secondary-button" onClick={() => attachmentRef.current?.click()} disabled={aiBusy}><ImagePlus size={16} />添加图片或文件</button>{attachmentFiles.map((file, index) => <span className="attachment-chip" key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachmentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></span>)}</div>
        <div className="ai-actions"><button type="button" className="primary-button" onClick={() => void runAiAnalysis()} disabled={aiBusy || !aiStatus?.configured}><Sparkles size={16} />{aiBusy ? '模型分析中…' : scope === 'all' ? '一键解析全部' : '解析当前范围'}</button><label className="auto-switch"><input type="checkbox" checked={settings.autoEnabled} onChange={(event) => setSettings((current) => ({ ...current, autoEnabled: event.target.checked }))} /><span>自动分析</span></label><span>{formatLastRun(aiSettings.lastRunAt)} · {settings.autoEnabled ? `每 ${settings.intervalHours} 小时检查未分析记录` : '自动分析已关闭'}</span>{aiProgress && aiBusy && <span>{aiProgress.completed}/{aiProgress.total} 条 · {aiProgress.candidates} 个候选</span>}</div>
        {aiMessage && <p className="ai-message" role="status">{aiMessage}</p>}
        */}
        <div className="intel-analysis-brief">
          <label><span>提炼范围</span><select value={scope} onChange={(event) => setScope(event.target.value as AnalysisScope)}><option value="unprocessed">未分析的新记录</option><option value="new">全部新记录</option><option value="all">全部记录</option></select></label>
          <label className="intel-conversation-picker"><span>指定对话</span><select value={analysisConversationId} onChange={(event) => setAnalysisConversationId(event.target.value)}><option value="">全部符合范围的对话</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.name} · {formatCount(conversation.records.length)} 条</option>)}</select></label>
          <label><span>时间模式</span><select value={timelineMode} onChange={(event) => setTimelineMode(event.target.value as TimelineFilterMode)}><option value="last-chat">按最后聊天时间</option><option value="strict-window">严格时间窗口</option></select></label>
          <div className="intel-time-filter">
            <label><span>{timelineMode === 'last-chat' ? '最后聊天时间从' : '消息时间从'}</span><input type="date" value={timelineStart} onChange={(event) => setTimelineStart(event.target.value)} max={timelineEnd || undefined} /></label>
            <label><span>至</span><input type="date" value={timelineEnd} onChange={(event) => setTimelineEnd(event.target.value)} min={timelineStart || undefined} /></label>
            {(timelineStart || timelineEnd) && <button type="button" className="icon-button" title="清除时间筛选" aria-label="清除时间筛选" onClick={() => { setTimelineStart(''); setTimelineEnd('') }}><X size={15} /></button>}
          </div>
          <span>{analysisConversationId
            ? `已指定“${analysisConversation?.name ?? '已移除的对话'}”；${timelineMode === 'strict-window' ? `严格窗口内上传 ${formatCount(analysisMessages.length)} 条消息。` : `将上传该对话完整历史，共 ${formatCount(analysisMessages.length)} 条消息。`}`
            : timelineMode === 'last-chat'
            ? `当前选中 ${filteredConversations.length}/${conversations.length} 个会话；会将其完整历史按分段覆盖上传。`
            : `严格窗口内有 ${formatCount(analysisMessages.length)} 条消息，来自 ${analysisConversationCount} 个会话；窗口外消息不会发送。`}</span>
        </div>
        <div className="archive-structure" aria-label="档案与模型分析结构">
          <div className="archive-stage"><span>原始消息档案</span><strong>{formatCount(archive.messageCount)}</strong><small>去重后留存的消息总数；不是文件数，也不是模型上下文。</small></div>
          <div className="archive-stage"><span>已归档对话</span><strong>{formatCount(archive.conversationCount)}</strong><small>{archive.identifiedConversationCount ? `${formatCount(archive.identifiedConversationCount)} 个由导出目录确认。` : '旧记录尚未带目录身份。'}{archive.messagesWithoutConversation ? ` ${formatCount(archive.messagesWithoutConversation)} 条旧记录按来源月份临时归档。` : ''}</small></div>
          <div className="archive-stage"><span>本轮选择</span><strong>{formatCount(analysisConversationCount)} 个对话</strong><small>{analysisConversationId ? `已指定“${analysisConversation?.name ?? '对话'}”，范围内有 ${formatCount(analysisMessages.length)} 条消息。` : `范围内有 ${formatCount(analysisMessages.length)} 条消息，按${timelineMode === 'last-chat' ? '最后聊天时间' : '严格时间窗口'}筛选。`}</small></div>
          <div className="archive-stage"><span>模型输入方式</span><strong>完整覆盖分段</strong><small>超长会话按时间连续分段，每段保留少量前序上下文；全部消息都会上传，不做抽样或固定条数截断。</small></div>
        </div>
        <div className="attachment-row"><input ref={attachmentRef} type="file" accept="image/*,.pdf,.json,.csv,.txt" multiple onChange={addAttachments} hidden /><button type="button" className="secondary-button" onClick={() => attachmentRef.current?.click()} disabled={aiBusy}><ImagePlus size={16} />添加图片或文件</button>{attachmentFiles.map((file, index) => <span className="attachment-chip" key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachmentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></span>)}</div>
        <div className="ai-actions"><button type="button" className="primary-button" onClick={() => void runAiAnalysis()} disabled={aiBusy || !aiStatus?.configured}><Sparkles size={16} />{aiBusy ? '按对话提炼中' : analysisConversationId ? '提炼指定对话' : scope === 'all' ? '提炼全部对话' : '提炼当前范围'}</button>{aiBusy && <button type="button" className="secondary-button ai-stop-button" onClick={stopAiAnalysis}><CircleStop size={15} />停止并保留候选</button>}{retryConversationIds.length > 0 && <button type="button" className="secondary-button" onClick={() => void runAiAnalysis(false, retryConversationIds)} disabled={aiBusy || !aiStatus?.configured}><RefreshCw size={15} />重试失败会话 {retryConversationIds.length}</button>}<span>{formatLastRun(aiSettings.lastRunAt)} · {normalizeAiConcurrency(aiSettings.concurrency)} 个会话并行{aiProgress && aiBusy && aiProgress.total ? ` · ${aiProgress.completed}/${aiProgress.total} 个片段` : ''}</span></div>
        {aiMessage && <p className="ai-message" role="status">{aiMessage}</p>}
        </>}
      </section>

      <section className={`intel-list-section intel-collapsible-section ai-debug-section ${openSections.debug ? 'is-open' : 'is-collapsed'}`}>
        <div className="list-heading"><div><span className="section-kicker">LOCAL DEBUG · 不含聊天正文与密钥</span><h2><button type="button" className="intel-section-toggle" aria-expanded={openSections.debug} onClick={() => setOpenSections((current) => ({ ...current, debug: !current.debug }))}>模型调试日志<ChevronDown size={17} /></button></h2></div><div className="list-heading-actions"><span>{debugLog.length} 条</span><button type="button" className="icon-button" title="清除本机界面日志" aria-label="清除本机界面日志" onClick={clearDebugLog} disabled={!debugLog.length}><Trash2 size={15} /></button></div></div>
        {openSections.debug && <><div className="bulk-note">服务端会在本地日志目录写入调试事件。日志仅含会话名称、分段序号、记录数、请求状态、重试和候选统计，不保存聊天正文、附件或密钥。</div><div className="ai-debug-log">{debugLog.map((entry, index) => <article className={`ai-debug-entry ai-debug-entry--${entry.level}`} key={`${entry.at}-${entry.event}-${index}`}><time>{formatChatTime(entry.at)}</time><strong>{debugEventLabel(entry.event)}</strong><span>{entry.conversationName ?? '批处理'}</span>{typeof entry.segmentIndex === 'number' && <em>第 {entry.segmentIndex}/{entry.segmentCount} 段{entry.historical ? ' · 历史' : ''}</em>}{typeof entry.recordCount === 'number' && <em>{formatCount(entry.recordCount)} 条消息</em>}{typeof entry.coreRecordCount === 'number' && <em>核心 {formatCount(entry.coreRecordCount)} 条{entry.overlapRecordCount ? ` · 重叠 ${formatCount(entry.overlapRecordCount)} 条` : ''}</em>}{typeof entry.attempt === 'number' && <em>第 {entry.attempt}/{entry.attemptTotal} 次</em>}{typeof entry.status === 'number' && <em>HTTP {entry.status}</em>}{typeof entry.candidateCount === 'number' && <em>模型 {entry.candidateCount} 个</em>}{typeof entry.acceptedCandidateCount === 'number' && <em>保留 {entry.acceptedCandidateCount} 个</em>}{entry.message && <p>{entry.message}</p>}</article>)}{!debugLog.length && <p className="empty-note">尚无模型请求日志。</p>}</div></>}
      </section>

      {createdCandidates.length > 0 && (
        <section className={`intel-list-section generated-candidates intel-collapsible-section ${openSections.created ? 'is-open' : 'is-collapsed'}`}>
          <div className="list-heading"><div><span className="section-kicker">CREATED QUESTS · 已保留记录</span><h2><button type="button" className="intel-section-toggle" aria-expanded={openSections.created} onClick={() => setOpenSections((current) => ({ ...current, created: !current.created }))}>已生成任务<ChevronDown size={17} /></button></h2></div><div className="list-heading-actions"><span>{createdCandidates.length} 条已生成</span></div></div>
          {openSections.created && <>
          <div className="bulk-note">生成后任务已进入任务列表；这里保留候选和原始来源，避免确认后记录看起来消失。</div>
          <div className="candidate-list">{createdCandidates.slice(0, 120).map((candidate) => {
            const sources = candidate.sourceIds.map((id) => intelById.get(id)).filter((item): item is IntelItem => Boolean(item))
            const platforms = [...new Set(sources.map((item) => item.source))]
            return <article className="candidate-item candidate-item--created" key={candidate.id}><span className="candidate-state" aria-label="已生成任务"><Check size={15} /></span><div><div className="candidate-meta"><span className="candidate-created-label">已生成</span>{platforms.map((platform) => <span key={platform}>{platform}</span>)}</div><h3>{candidate.title}</h3><p>{candidate.description}</p><small>{candidate.place ?? '未指定地点'} · {formatQuestTime({ ...candidate, sourceCapturedAt: candidate.sourceCapturedAt ?? candidate.createdAt }, sources)}</small></div><span /></article>
          })}</div>
          {createdCandidates.length > 120 && <p className="list-overflow-note">已生成记录较多，此处显示最近 120 条；全部任务均在任务列表中可见。</p>}
          </>}
        </section>
      )}

      <section className={`intel-list-section intel-collapsible-section ${openSections.candidates ? 'is-open' : 'is-collapsed'}`}>
        <div className="list-heading"><div><span className="section-kicker">REVIEW QUEUE · 人工确认</span><h2><button type="button" className="intel-section-toggle" aria-expanded={openSections.candidates} onClick={() => setOpenSections((current) => ({ ...current, candidates: !current.candidates }))}>候选任务<ChevronDown size={17} /></button></h2></div><div className="list-heading-actions"><span>{pendingCandidates.length} 个待确认</span><button type="button" className="secondary-button" onClick={selectAllCandidates} disabled={!pendingCandidates.length}>全选</button><button type="button" className="secondary-button" onClick={() => dismissCandidates([...validSelectedCandidates])} disabled={!validSelectedCandidates.size}><Trash2 size={15} />忽略已选 {validSelectedCandidates.size}</button><button type="button" className="primary-button bulk-quest-button" onClick={() => onCreateAiQuests(pendingCandidates)} disabled={!pendingCandidates.length}><Sparkles size={15} />一键生成全部</button><button type="button" className="primary-button bulk-quest-button" onClick={createSelected} disabled={!validSelectedCandidates.size}><Check size={15} />生成已选 {validSelectedCandidates.size}</button></div></div>
        {openSections.candidates && <>
        <div ref={candidateListRef} className={`candidate-list ${pendingCandidates.length ? 'candidate-list--virtual' : ''}`} onScroll={(event) => handleCandidateScroll(event.currentTarget.scrollTop)}><div className="candidate-list-spacer" style={{ height: `${pendingCandidates.length * CANDIDATE_ROW_HEIGHT}px` }}><div className="candidate-list-window" style={{ transform: `translateY(${firstCandidate * CANDIDATE_ROW_HEIGHT}px)` }}>{renderedCandidates.map((candidate) => {
          const sources = candidate.sourceIds.map((id) => intelById.get(id)).filter((item): item is IntelItem => Boolean(item))
          const platforms = [...new Set(sources.map((item) => item.source))]
          const providers = [...new Set(sources.map(sourceProvider).filter((name): name is string => Boolean(name)))]
          return <article className="candidate-item" style={{ height: `${CANDIDATE_ROW_HEIGHT}px` }} key={candidate.id}><input type="checkbox" aria-label={`选择 ${candidate.title}`} checked={validSelectedCandidates.has(candidate.id)} onChange={() => toggleCandidate(candidate.id)} /><div><div className="candidate-meta">{platforms.map((platform) => <span key={platform}>{platform}</span>)}{providers.length > 0 && <span>提供者：{providers.join('、')}</span>}{candidate.locationPrecision === 'exact' && <span>精确地点</span>}{candidate.locationPrecision === 'approximate' && <span>大致范围</span>}</div><h3>{candidate.title}</h3><p>{candidate.description}</p><small>{candidate.place ?? '未指定地点'} · {formatQuestTime({ ...candidate, sourceCapturedAt: candidate.sourceCapturedAt ?? candidate.createdAt }, sources)}</small></div><label className="candidate-feedback"><span>忽略并学习</span><select aria-label={`忽略 ${candidate.title} 的原因`} defaultValue="" onChange={(event) => { const reason = event.target.value as AiFeedbackReason; if (reason) dismissCandidates([candidate.id], reason) }}><option value="" disabled>选择原因</option><option value="expired">已经过期</option><option value="ownership">人物/方向错误</option><option value="completed">已经完成</option><option value="not-actionable">没有行动价值</option><option value="incorrect">内容不准确</option><option value="other">其他/直接删除</option></select></label></article>
        })}</div></div>{!pendingCandidates.length && <p className="empty-note">还没有模型候选。提炼会按对话合并结果，并在这里等待确认。</p>}</div>
        </>}
      </section>

      <section className={`intel-list-section conversation-section intel-collapsible-section ${openSections.conversations ? 'is-open' : 'is-collapsed'}`}>
        <div className="list-heading"><div><span className="section-kicker">LOCAL CONVERSATIONS · 原始对话目录</span><h2><button type="button" className="intel-section-toggle" aria-expanded={openSections.conversations} onClick={() => setOpenSections((current) => ({ ...current, conversations: !current.conversations }))}>对话档案<ChevronDown size={17} /></button></h2></div><div className="list-heading-actions"><span>{filteredConversations.length}/{conversations.length} 个对话</span></div></div>
        {openSections.conversations && <>
        <div className="bulk-note">这里是去重后的原始消息档案，不是模型候选。每个文件夹或导出会话被归为一个对话；按最后聊天时间倒序和月份分组。选择时间范围后，显示范围与模型提炼范围一致。</div>
        <div className="conversation-timeline">
          {conversationsByPeriod.map(([period, entries]) => <section className="conversation-period" key={period}>
            <div className="conversation-period-heading"><span>{period === '未记录时间' ? period : `${period} · 最后聊天`}</span><small>{entries.length} 个对话</small></div>
            {entries.map((conversation) => {
              const latest = conversation.records.at(-1)
              const kind = conversation.kind === 'group' ? '群聊' : conversation.kind === 'direct' ? '私聊' : '对话'
              return <article className={`conversation-row ${selectedConversation?.id === conversation.id ? 'is-selected' : ''} ${analysisConversationId === conversation.id ? 'is-analysis-target' : ''}`} key={conversation.id}>
                <div className="conversation-row-icon"><MessagesSquare size={17} /></div>
                <div className="conversation-row-copy"><div><span>{conversation.source}</span><span>{kind}</span><time><Clock3 size={12} />最后聊天：{formatChatTime(conversation.lastAt)}</time></div><h3>{conversation.name}</h3><p>{latest?.content || latest?.summary || '没有可显示的消息内容。'}</p><small>{formatCount(conversation.records.length)} 条消息{conversation.firstAt ? ` · 最早 ${formatChatTime(conversation.firstAt)}` : ' · 消息时间未记录'}</small></div>
                <div className="conversation-row-actions"><button type="button" className="conversation-analyze" onClick={() => { setAnalysisConversationId(conversation.id); setOpenSections((current) => ({ ...current, analysis: true })) }} aria-label={`单独提炼 ${conversation.name}`}><Sparkles size={14} />单独提炼</button><button type="button" className="conversation-open" onClick={() => openConversation(conversation.id)} aria-label={`查看 ${conversation.name} 的对话`}><span>查看对话</span><ChevronRight size={16} /></button></div>
              </article>
            })}
          </section>)}
          {!filteredConversations.length && <p className="empty-note">当前时间范围内没有最后聊天时间可匹配的对话。</p>}
        </div>
        {selectedConversation && <section className="conversation-detail" aria-label={`${selectedConversation.name} 的对话内容`}>
          <div className="conversation-detail-heading"><div><span className="section-kicker">DIALOGUE · 按消息时间排序</span><h3>{selectedConversation.name}</h3><p>{selectedConversation.source} · {selectedConversation.kind === 'group' ? '群聊' : selectedConversation.kind === 'direct' ? '私聊' : '对话'} · {formatCount(selectedConversation.records.length)} 条消息 · 最后聊天 {formatChatTime(selectedConversation.lastAt)}</p></div><button type="button" className="icon-button" title="关闭对话内容" aria-label="关闭对话内容" onClick={() => setSelectedConversationId(undefined)}><X size={16} /></button></div>
          <div ref={messageListRef} className="conversation-message-list" onScroll={(event) => handleMessageScroll(event.currentTarget.scrollTop)}><div className="conversation-message-spacer" style={{ height: `${selectedConversationRecords.length * MESSAGE_ROW_HEIGHT}px` }}><div className="conversation-message-window" style={{ transform: `translateY(${firstMessage * MESSAGE_ROW_HEIGHT}px)` }}>{renderedMessages.map((item) => <article className="conversation-message" style={{ height: `${MESSAGE_ROW_HEIGHT}px` }} key={item.id}><div><span>{item.speakerRole === 'self' ? '本人发言' : item.speakerRole === 'other' ? '对方发言' : '发言方向未确认'}</span>{item.speaker && <strong>{item.speaker}</strong>}{item.messageType && <em>类型：{item.messageType}</em>}<time>{formatChatTime(item.capturedAt)}</time></div><p title={item.content || item.summary}>{item.content || item.summary}</p></article>)}</div></div></div>
        </section>}
        </>}
      </section>
    </div>
  )
}

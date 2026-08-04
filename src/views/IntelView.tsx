import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Check, ChevronDown, ChevronRight, Clock3, FileJson, FileText, FolderOpen, FolderSync, GraduationCap, ImagePlus, LockKeyhole, MessageCircle, MessagesSquare, Pause, RefreshCw, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import type { AiExtractionCheckpoint, AiFeedbackReason, AiSettings, AiTaskCandidate, ArchiveAnalysisSummary, ArchiveSummary, IntelItem, Person } from '../types'
import { parseIntelFile } from '../lib/importer'
import { sourceProvider } from '../lib/people'
import { chooseExportDirectory, DIRECTORY_IMPORT_SIGNATURE_VERSION, ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle, scanExportDirectory, supportsDirectorySync, type LocalDirectoryHandle } from '../lib/directorySync'
import { planDirectoryImport } from '../lib/directoryManifest'
import { AI_STATUS_CHANGED_EVENT, analyzeIntel, buildDirectConversationFallbackPeople, fileToAttachment, getAiStatus, type AiAttachment, type AiDebugEntry, type AiProgress, type AiStatus } from '../lib/aiClient'
import { formatQuestTime } from '../lib/questTime'
import { normalizeAiConcurrency } from '../lib/aiConcurrency'
import { checkpointForRetry } from '../lib/analysisCheckpoint'
import { analysisConversationFingerprint, analysisConversationKey } from '../lib/analysisWatermark'

export interface AnalysisWorkState {
  stage: 'tasks' | 'people'
  completed: number
  total: number
  completedConversations?: number
  totalConversations?: number
  candidates: number
  message: string
}

interface AnalysisTargets {
  tasks: boolean
  people: boolean
}

interface IntelViewProps {
  active: boolean
  items: IntelItem[]
  intelHydrated: boolean
  archiveLoadError?: string
  archive: ArchiveSummary
  candidates: AiTaskCandidate[]
  aiSettings: AiSettings
  onImport: (items: IntelItem[], options?: { replace?: boolean; replaceFiles?: string[]; fileCount?: number; sourceFingerprint?: string }) => { added: number; updated: number; duplicates: number; archiveMessageCount: number; conversationCount: number }
  onAiAnalysis: (candidates: AiTaskCandidate[], analyzedIds: string[], settings: AiSettings, summary: Omit<ArchiveAnalysisSummary, 'analyzedAt'>, completedSuccessfully: boolean, watermarkEligible?: boolean) => void
  onDirectPeopleDetected: (people: Person[]) => void
  onPeopleAnalysis: (items: IntelItem[], settings: AiSettings, onProgress?: (progress: AiProgress) => void) => Promise<{ started: boolean; reason?: string; failedConversationIds?: string[]; analyzedIds?: string[] }>
  onAnalysisWatermark: (analyzedIds: string[], eligible: boolean) => void
  onStopPeopleAnalysis: () => void
  onAnalysisCheckpoint: (checkpoint?: AiExtractionCheckpoint) => void
  onCreateAiQuests: (candidates: AiTaskCandidate[]) => number
  onDismissAiCandidates: (ids: string[], reason?: AiFeedbackReason) => void
  onAnalysisWorkChange: (state: AnalysisWorkState | null) => void
  conversationRequest?: { id: string; sequence: number }
}

type AutomationState = 'idle' | 'restoring' | 'watching' | 'needs-permission' | 'unsupported' | 'error'
type AnalysisScope = 'unprocessed' | 'new' | 'all'
type TimelineFilterMode = 'last-chat' | 'strict-window'

const DIRECTORY_SNAPSHOT_KEY = 'theia:directory-snapshot:v1'
const DIRECTORY_MANIFEST_KEY = 'theia:directory-manifest:v1'
const DIRECTORY_SYNC_STATE_KEY = 'theia:directory-sync-state:v2'
const AI_DEBUG_LOG_KEY = 'theia:ai-debug-log:v1'
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

function loadDirectorySyncState() {
  try {
    const stored = localStorage.getItem(DIRECTORY_SYNC_STATE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as { fingerprint?: unknown; manifest?: unknown }
      if (parsed?.manifest && typeof parsed.manifest === 'object' && !Array.isArray(parsed.manifest)) {
        return {
          fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : '',
          manifest: new Map(Object.entries(parsed.manifest as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          legacy: false,
        }
      }
    }
  } catch { /* Fall through to the legacy pair. */ }
  try {
    const parsed = JSON.parse(localStorage.getItem(DIRECTORY_MANIFEST_KEY) ?? '{}') as unknown
    const manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? new Map(Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : new Map<string, string>()
    return { fingerprint: localStorage.getItem(DIRECTORY_SNAPSHOT_KEY) ?? '', manifest, legacy: true }
  } catch { return { fingerprint: '', manifest: new Map<string, string>(), legacy: true } }
}

async function directoryFingerprint(value: string) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${value.length}`
}

export function IntelView({ active, items, intelHydrated, archiveLoadError, archive, candidates, aiSettings, onImport, onAiAnalysis, onDirectPeopleDetected, onPeopleAnalysis, onAnalysisWatermark, onStopPeopleAnalysis, onAnalysisCheckpoint, onCreateAiQuests: createAiQuests, onDismissAiCandidates, onAnalysisWorkChange, conversationRequest }: IntelViewProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const attachmentRef = useRef<HTMLInputElement>(null)
  const handleRef = useRef<LocalDirectoryHandle | null>(null)
  const busyRef = useRef(false)
  const aiBusyRef = useRef(false)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const checkpointRef = useRef<AiExtractionCheckpoint | undefined>(aiSettings.interruptedRun)
  const resumePromptedRef = useRef<string | undefined>(undefined)
  const onImportRef = useRef(onImport)
  const itemsRef = useRef(items)
  const archiveRef = useRef(archive)
  const [message, setMessage] = useState('记录默认只在本机解析；点击模型分析后，选中的记录才会发送到本机代理。')
  const [busy, setBusy] = useState(false)
  const [automationState, setAutomationState] = useState<AutomationState>('restoring')
  const [folderName, setFolderName] = useState('')
  const [lastScan, setLastScan] = useState('尚未扫描')
  const [scanStats, setScanStats] = useState({ files: 0, changed: 0, records: 0, rebuilt: false })
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
  const [analysisTargets, setAnalysisTargets] = useState<AnalysisTargets>({ tasks: true, people: true })
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
  // Generated candidates are removed once a quest is created; keep no
  // temporary archive section in the interface for legacy snapshots.
  const createdCandidates: AiTaskCandidate[] = []
  const validSelectedCandidates = useMemo(() => {
    const available = new Set(pendingCandidates.map((candidate) => candidate.id))
    return new Set([...selectedCandidates].filter((id) => available.has(id)))
  }, [pendingCandidates, selectedCandidates])
  const conversationIndexEnabled = active || aiBusy || aiSettings.autoEnabled || Boolean(aiSettings.interruptedRun) || Boolean(conversationRequest)
  // Keep directory discovery mounted, but avoid indexing hundreds of
  // thousands of records while the archive screen is hidden and idle.
  const indexedItems = conversationIndexEnabled ? items : null
  const intelById = useMemo(() => indexedItems ? new Map(indexedItems.map((item) => [item.id, item])) : new Map<string, IntelItem>(), [indexedItems])
  const conversations = useMemo(() => indexedItems ? buildConversationTimeline(indexedItems) : [], [indexedItems])
  const conversationFingerprints = useMemo(() => new Map(conversations.map((conversation) => [conversation.id, analysisConversationFingerprint(conversation.records)])), [conversations])
  const conversationKinds = useMemo(() => new Map(conversations.map((conversation) => [conversation.id, conversation.kind])), [conversations])
  const filteredConversations = useMemo(() => conversations.filter((conversation) => timelineMode === 'last-chat'
    ? withinLastChatRange(conversation, timelineStart, timelineEnd)
    : conversation.records.some((item) => withinStrictTimeRange(item, timelineStart, timelineEnd))), [conversations, timelineEnd, timelineMode, timelineStart])
  const analysisConversation = useMemo(() => conversations.find((conversation) => conversation.id === analysisConversationId), [analysisConversationId, conversations])
  const analysisMessages = useMemo(() => {
    if (!indexedItems) return []
    if (analysisConversationId) {
      const records = analysisConversation?.records ?? []
      return timelineMode === 'strict-window'
        ? records.filter((item) => withinStrictTimeRange(item, timelineStart, timelineEnd))
        : records
    }
    const workflowNeedsAnalysis = (item: IntelItem) => {
      if (item.status !== 'new') return false
      if (scope === 'new') return true
      if (scope !== 'unprocessed') return true
      const conversationId = analysisConversationKey(item)
      const fingerprint = conversationFingerprints.get(conversationId)
      const taskWatermark = aiSettings.analysisWatermarks?.tasks?.[conversationId]
      const peopleWatermark = aiSettings.analysisWatermarks?.people?.[conversationId]
      if (!fingerprint) return true
      const taskNeedsAnalysis = taskWatermark !== fingerprint
      const peopleNeedsAnalysis = conversationKinds.get(conversationId) === 'direct' && peopleWatermark !== fingerprint
      if (analysisTargets.tasks && analysisTargets.people) return taskNeedsAnalysis || peopleNeedsAnalysis
      if (analysisTargets.people) return peopleNeedsAnalysis
      // Legacy message markers only remain a task-workflow fallback. They do
      // not suppress a people-only run from the same conversation.
      if (taskWatermark === fingerprint) return false
      return !item.aiAnalyzedAt
    }
    const scopeMatches = scope === 'all' ? indexedItems : indexedItems.filter(workflowNeedsAnalysis)
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
    return fullConversationRecords(indexedItems, timeMatches)
  }, [aiSettings.analysisWatermarks, analysisConversation, analysisConversationId, analysisTargets, conversationFingerprints, conversationKinds, filteredConversations, indexedItems, scope, timelineEnd, timelineMode, timelineStart])
  const analysisConversationCount = useMemo(() => new Set(analysisMessages.map(conversationKey)).size, [analysisMessages])
    const automaticWorkPending = useMemo(() => conversations.some((conversation) => {
      if (!conversation.records.some((item) => item.status === 'new')) return false
      const fingerprint = conversationFingerprints.get(conversation.id)
      if (!fingerprint) return true
      const taskWatermark = aiSettings.analysisWatermarks?.tasks?.[conversation.id]
      const legacyTaskDone = !taskWatermark && conversation.records.every((item) => Boolean(item.aiAnalyzedAt))
      const taskNeedsAnalysis = taskWatermark !== fingerprint && !legacyTaskDone
    const peopleNeedsAnalysis = conversation.kind === 'direct' && aiSettings.analysisWatermarks?.people?.[conversation.id] !== fingerprint
    return analysisTargets.tasks && analysisTargets.people
      ? taskNeedsAnalysis || peopleNeedsAnalysis
      : analysisTargets.people ? peopleNeedsAnalysis : taskNeedsAnalysis
  }), [aiSettings.analysisWatermarks, analysisTargets, conversationFingerprints, conversations])
  const configuredProviderCapacity = aiStatus?.scheduler?.totalMaxConcurrency ?? aiStatus?.totalMaxConcurrency ?? 0
  // Preserve the user's configured pool behavior. Request size is controlled
  // by the conversation segment planner, not by silently lowering channel
  // concurrency at the UI layer.
  const effectiveConcurrency = normalizeAiConcurrency(Math.max(Number(aiSettings.concurrency) || 0, configuredProviderCapacity))
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
  useEffect(() => { archiveRef.current = archive }, [archive])
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
    const updateStatus = (event: Event) => setAiStatus((event as CustomEvent<AiStatus>).detail)
    window.addEventListener(AI_STATUS_CHANGED_EVENT, updateStatus)
    return () => window.removeEventListener(AI_STATUS_CHANGED_EVENT, updateStatus)
  }, [])

  const syncDirectory = useCallback(async (handle: LocalDirectoryHandle, force = false) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const scan = await scanExportDirectory(handle)
      const files = scan.files
      if (!scan.complete) {
        const reasons = [
          scan.truncated ? '文件数量超过 20,000 个' : '',
          scan.skippedOversizedFiles ? `${scan.skippedOversizedFiles} 个文件超过 512 MB` : '',
          scan.depthLimitReached ? '目录层级超过 24 层' : '',
        ].filter(Boolean)
        throw new Error(`目录扫描不完整（${reasons.join('；')}）。为避免误删记录，本次未修改现有归档。`)
      }
      const importSignature = (entry: typeof files[number]) => entry.file.name.toLowerCase().endsWith('.json')
        ? `${entry.signature}:${DIRECTORY_IMPORT_SIGNATURE_VERSION}`
        : entry.signature
      const currentFingerprint = await directoryFingerprint(JSON.stringify({
        name: handle.name,
        files: files.map((entry) => [entry.path, importSignature(entry)]),
      }))
      const directoryState = loadDirectorySyncState()
      const durableFingerprint = archiveRef.current.sourceFingerprint ?? ''
      const manifestMatchesArchive = !durableFingerprint || directoryState.fingerprint === durableFingerprint
      const previousFingerprint = manifestMatchesArchive ? directoryState.fingerprint : durableFingerprint
      const previousManifest = manifestMatchesArchive ? directoryState.manifest : new Map<string, string>()
      const manifestFiles = files.map((entry) => ({ path: entry.path, signature: importSignature(entry) }))
      const currentManifest = new Map(manifestFiles.map((entry) => [entry.path, entry.signature]))
      const completeSourceProvenance = itemsRef.current.length > 0 && itemsRef.current.every((item) => Boolean(item.sourceFile))
      const plan = planDirectoryImport({
        files: manifestFiles,
        previousManifest,
        previousFingerprint,
        currentFingerprint,
        archiveItemCount: itemsRef.current.length,
        completeSourceProvenance,
        force,
      })
      const { directoryChanged, incrementalUpdate, rebuildSnapshot, removedFiles } = plan
      const changedPaths = new Set(plan.changedFiles.map((entry) => entry.path))
      const changedFiles = files.filter((entry) => changedPaths.has(entry.path))
      const parsePaths = new Set(plan.filesToParse.map((entry) => entry.path))
      const filesToParse = files.filter((entry) => parsePaths.has(entry.path))
      const importedItems: IntelItem[] = []
      for (const [index, entry] of filesToParse.entries()) {
        const parsed = await parseIntelFile(entry.file, { path: entry.path })
        importedItems.push(...parsed)
        // A large export may contain thousands of files. Yield regularly so the
        // desktop UI can keep painting and the user can still change sections.
        if (index > 0 && index % 8 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }
      const merged = rebuildSnapshot
        ? onImportRef.current(importedItems, { replace: true, fileCount: files.length, sourceFingerprint: currentFingerprint })
        : incrementalUpdate
          ? onImportRef.current(importedItems, { replaceFiles: [...new Set([...changedFiles.map((entry) => entry.path), ...removedFiles])], fileCount: files.length, sourceFingerprint: currentFingerprint })
          : undefined
      // Advance the manifest only after the in-memory archive accepted the
      // replacement. A parse/import failure must be retried on the next scan.
      if (rebuildSnapshot || incrementalUpdate || directoryChanged || directoryState.legacy) {
        // Fingerprint and manifest describe one commit and must advance in a
        // single localStorage write. A quota failure leaves the old commit
        // intact, so the next scan safely retries instead of skipping files.
        try {
          localStorage.setItem(DIRECTORY_SYNC_STATE_KEY, JSON.stringify({
            fingerprint: currentFingerprint,
            manifest: Object.fromEntries(currentManifest),
          }))
        } catch { /* local cache is optional; the next scan retries safely */ }
      }
      const now = new Date().toLocaleTimeString('zh-CN')
      const processedFileCount = filesToParse.length
      setLastScan(`${now} · 扫描 ${files.length} 个文件 · 处理 ${processedFileCount} 个`)
      setScanStats({ files: files.length, changed: processedFileCount + removedFiles.length, records: importedItems.length, rebuilt: rebuildSnapshot })
      setMessage(merged
        ? rebuildSnapshot
          ? `已按目录重建 ${files.length} 个文件：当前 ${formatCount(merged.archiveMessageCount)} 条消息、${formatCount(merged.conversationCount)} 个会话；本次解析 ${formatCount(importedItems.length)} 条。`
          : `已增量同步 ${changedFiles.length} 个新增或变更文件、${removedFiles.length} 个已删除文件：当前 ${formatCount(merged.archiveMessageCount)} 条消息；新增 ${formatCount(merged.added)} 条，更新 ${formatCount(merged.updated)} 条。`
        : '目录已是最新状态。')
      setAutomationState('watching')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '目录扫描失败，请重新授权或确认文件没有被占用。')
      setAutomationState('error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      if (!intelHydrated) return
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
  }, [intelHydrated, syncDirectory])

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

  const runAiAnalysis = useCallback(async (automatic = false, retryIds: string[] = [], resumeCheckpoint?: AiExtractionCheckpoint) => {
    if (aiBusyRef.current) return
    const targets = resumeCheckpoint?.targets ?? analysisTargets
    if (!targets.tasks && !targets.people) {
      setAiMessage('请至少选择“任务”或“人物”后再开始提炼。')
      return
    }
    const concurrency = effectiveConcurrency
    const analysisItems = itemsRef.current
    const resumeConversationIds = new Set(resumeCheckpoint?.conversationIds ?? [])
    const resumeCompletedIds = new Set(resumeCheckpoint?.completedConversationIds ?? [])
    const automaticMatches = automatic
      ? analysisItems.filter((item) => item.status === 'new' && (() => {
        const conversationId = analysisConversationKey(item)
        const fingerprint = conversationFingerprints.get(conversationId)
        const taskDone = Boolean(fingerprint && aiSettings.analysisWatermarks?.tasks?.[conversationId] === fingerprint)
        const peopleDone = Boolean(fingerprint && aiSettings.analysisWatermarks?.people?.[conversationId] === fingerprint)
        const peopleApplicable = conversationKinds.get(conversationId) === 'direct'
        if (targets.tasks && targets.people) return (!taskDone && !item.aiAnalyzedAt) || (peopleApplicable && !peopleDone)
        if (targets.people) return peopleApplicable && !peopleDone
        return !taskDone && !item.aiAnalyzedAt
      })())
      : []
    const automaticFullConversationIds = new Set<string>()
    if (automatic && automaticMatches.length) {
      const recordsByConversation = new Map<string, IntelItem[]>()
      analysisItems.forEach((item) => {
        const id = analysisConversationKey(item)
        const records = recordsByConversation.get(id)
        if (records) records.push(item)
        else recordsByConversation.set(id, [item])
      })
      for (const item of automaticMatches) {
        const conversationId = analysisConversationKey(item)
        const fingerprint = conversationFingerprints.get(conversationId)
        const records = recordsByConversation.get(conversationId) ?? []
        const taskWatermark = aiSettings.analysisWatermarks?.tasks?.[conversationId]
        const peopleWatermark = aiSettings.analysisWatermarks?.people?.[conversationId]
        const taskDone = Boolean(fingerprint && taskWatermark === fingerprint)
        const peopleDone = Boolean(fingerprint && peopleWatermark === fingerprint)
        const legacyTaskDone = !taskWatermark && records.length > 0 && records.every((record) => Boolean(record.aiAnalyzedAt))
        const peopleApplicable = conversationKinds.get(conversationId) === 'direct'
        const taskNeedsFull = targets.tasks && !taskDone && !legacyTaskDone && !taskWatermark
        const peopleNeedsFull = targets.people && peopleApplicable && !peopleDone && !peopleWatermark
        if (taskNeedsFull || peopleNeedsFull) automaticFullConversationIds.add(conversationId)
      }
    }
    const retryMatches = retryIds.length ? itemsRef.current.filter((item) => retryIds.includes(conversationKey(item))) : []
    const retrySource = timelineMode === 'strict-window'
      ? analysisMessages.filter((item) => retryIds.includes(conversationKey(item)))
      : fullConversationRecords(itemsRef.current, retryMatches)
    const resumeMatches = resumeCheckpoint
      ? itemsRef.current.filter((item) => resumeConversationIds.has(conversationKey(item)) && !resumeCompletedIds.has(conversationKey(item)))
      : []
    const resumeSource = resumeCheckpoint
      ? resumeCheckpoint.timelineMode === 'strict-window'
        ? resumeMatches.filter((item) => withinStrictTimeRange(item, resumeCheckpoint.timelineStart ?? '', resumeCheckpoint.timelineEnd ?? ''))
        : resumeMatches
      : []
    const automaticSource = automatic
      ? (() => {
        const fullItems = fullConversationRecords(
          analysisItems,
          automaticMatches.filter((item) => automaticFullConversationIds.has(conversationKey(item))),
        )
        const incrementalItems = incrementalConversationRecords(
          analysisItems,
          automaticMatches.filter((item) => !automaticFullConversationIds.has(conversationKey(item))),
        )
        const selectedIds = new Set([...fullItems, ...incrementalItems].map((item) => item.id))
        return analysisItems.filter((item) => selectedIds.has(item.id))
      })()
      : []
    const source = resumeCheckpoint
      ? resumeSource
      : retryIds.length
        ? retrySource
        : automatic ? automaticSource : analysisMessages
    if (!source.length) {
      // A resumed checkpoint can outlive the imported archive (for example
      // after the user removed a folder or switched to a strict time range).
      // There is no remaining work in that case, so do not ask to resume the
      // same empty run on every subsequent launch.
      if (resumeCheckpoint) {
        checkpointRef.current = undefined
        onAnalysisCheckpoint(undefined)
        setAiMessage('上次提炼已没有剩余记录，已自动清理恢复状态。')
      } else {
        setAiMessage('没有符合当前分析范围的记录。')
      }
      return
    }
    const selectedConversationIds = new Set(source.map(conversationKey))
    const selectedConversationCount = resumeCheckpoint
      ? selectedConversationIds.size + resumeCompletedIds.size
      : retryIds.length ? new Set(retryMatches.map(conversationKey)).size : automatic ? new Set(automaticMatches.map(conversationKey)).size : analysisConversationCount
    const checkpoint: AiExtractionCheckpoint = resumeCheckpoint ?? {
      version: 1,
      stage: targets.tasks ? 'tasks' : 'people',
      targets,
      scope,
      timelineMode,
      ...(timelineStart ? { timelineStart } : {}),
      ...(timelineEnd ? { timelineEnd } : {}),
      ...(analysisConversationId ? { conversationId: analysisConversationId } : {}),
      conversationIds: [...selectedConversationIds],
      completedConversationIds: [],
      startedAt: new Date().toISOString(),
    }
    checkpointRef.current = checkpoint
    onAnalysisCheckpoint(checkpoint)
    const peopleStage = checkpoint.stage === 'people' || !targets.tasks
    const persistCompletedConversation = (progress: AiProgress) => {
      const completedId = progress.completedConversationId
      const current = checkpointRef.current
      if (!completedId || !current || current.completedConversationIds.includes(completedId)) return
      const next = { ...current, completedConversationIds: [...current.completedConversationIds, completedId] }
      checkpointRef.current = next
      onAnalysisCheckpoint(next)
    }
    // Build local cards only when the user explicitly requested People. A
    // task-only run must not silently add cards as a side effect.
    if (targets.people) onDirectPeopleDetected(buildDirectConversationFallbackPeople(source))
    setRetryConversationIds([])
    aiBusyRef.current = true
    const controller = new AbortController()
    analysisAbortRef.current = controller
    setAiBusy(true)
    const workflowLabel = targets.tasks && targets.people ? '任务与人物' : targets.tasks ? '任务' : '人物'
    const startingMessage = retryIds.length
      ? `准备以 ${concurrency} 个并发会话重新提交 ${selectedConversationCount} 个失败会话的完整记录，共 ${formatCount(source.length)} 条消息。`
      : automatic
        ? `增量自动更新：将提炼${workflowLabel}，以 ${concurrency} 个并发会话提交 ${formatCount(automaticMatches.length)} 条新增消息和 ${formatCount(source.length - automaticMatches.length)} 条前序上下文。`
        : `准备提炼${workflowLabel}：以 ${concurrency} 个并发会话提交 ${selectedConversationCount} 个完整对话，共 ${formatCount(source.length)} 条归档消息。`
    setAiProgress({ completed: 0, total: 0, completedConversations: 0, totalConversations: selectedConversationCount, candidates: 0 })
    setAiMessage(startingMessage)
    if (!peopleStage) onAnalysisWorkChange({ stage: 'tasks', completed: 0, total: 0, completedConversations: 0, totalConversations: selectedConversationCount, candidates: 0, message: startingMessage })
    try {
      if (peopleStage) {
        const peopleResult = await onPeopleAnalysis(source, aiSettings, (progress) => {
          const progressMessage = `人物总进度：${progress.completedConversations ?? 0}/${progress.totalConversations ?? selectedConversationCount} 个对话；片段 ${progress.completed}/${progress.total}；已保留 ${progress.candidates} 张人物卡。`
          setAiProgress(progress)
          persistCompletedConversation(progress)
          setAiMessage(progressMessage)
        })
        if (peopleResult.started) {
          const peopleAnalyzedIds = automatic
            ? (() => {
              const resultIds = new Set(peopleResult.analyzedIds ?? [])
              const successfulConversationIds = new Set(
                analysisItems
                  .filter((item) => resultIds.has(item.id))
                  .map(conversationKey),
              )
              analysisItems.forEach((item) => {
                const conversationId = conversationKey(item)
                if (successfulConversationIds.has(conversationId)) resultIds.add(item.id)
              })
              return [...resultIds]
            })()
            : peopleResult.analyzedIds ?? []
          onAnalysisWatermark(peopleAnalyzedIds, timelineMode === 'last-chat')
        }
        if (!peopleResult.started) {
          setAiMessage(peopleResult.reason ?? '当前范围没有可提炼的人物。')
          checkpointRef.current = undefined
          onAnalysisCheckpoint(undefined)
          return
        }
        if (peopleResult.failedConversationIds?.length) {
          setRetryConversationIds(peopleResult.failedConversationIds)
          setAiMessage(`人物提炼已保留成功结果；${peopleResult.failedConversationIds.length} 个会话仍需重试，恢复进度已保存。`)
          return
        }
        checkpointRef.current = undefined
        onAnalysisCheckpoint(undefined)
        return
      }
      const attachments: AiAttachment[] = []
      for (const file of attachmentFiles) attachments.push(await fileToAttachment(file))
      const result = await analyzeIntel(source, attachments, aiSettings, (progress) => {
        const segmentLabel = progress.totalSegmentsInConversation
          ? `“${progress.currentConversation ?? '当前会话'}”第 ${progress.currentSegment}/${progress.totalSegmentsInConversation} 段`
          : `“${progress.currentConversation ?? '当前会话'}”`
        const progressMessage = progress.retryAttempt
          ? `${segmentLabel} 服务异常，${progress.retryDelayMs ? `${(progress.retryDelayMs / 1000).toFixed(1)} 秒后` : '立即'}进行第 ${progress.retryAttempt}/${progress.retryTotal} 次自动重连。`
          : `任务总进度：${progress.completedConversations ?? 0}/${progress.totalConversations ?? selectedConversationCount} 个对话；片段 ${progress.completed}/${progress.total}。${automatic ? '增量消息附带少量前序上下文' : '完整会话按时间覆盖上传，未做消息抽样'}。当前 ${segmentLabel}${progress.historicalSegment ? '（历史信息段）' : ''}；得到 ${progress.candidates} 个候选。`
        setAiProgress(progress)
        persistCompletedConversation(progress)
        setAiMessage(progressMessage)
        onAnalysisWorkChange({ stage: 'tasks', completed: progress.completed, total: progress.total, completedConversations: progress.completedConversations, totalConversations: progress.totalConversations ?? selectedConversationCount, candidates: progress.candidates, message: progressMessage })
      }, appendDebugLog, onDirectPeopleDetected, { signal: controller.signal, concurrency })
      const retryableFailures = result.failedConversations.filter((conversation) => conversation.retryable)
      setRetryConversationIds(retryableFailures.map((conversation) => conversation.id))
      const automaticCoreIds = new Set(automaticMatches.map((item) => item.id))
      const acceptedCandidates = automatic
        ? result.candidates.filter((candidate) => candidate.sourceIds.some((id) => automaticCoreIds.has(id)))
        : result.candidates
      const analyzedIds = automatic
        ? (() => {
          // Incremental requests contain only new rows plus context. Once a
          // conversation with an existing workflow watermark succeeds, add
          // the rest of the start-of-run snapshot so the saved fingerprint
          // advances to the current complete conversation without claiming
          // messages imported while this request was running.
          const resultIds = new Set(result.analyzedIds)
          const successfulConversationIds = new Set(
            analysisItems
              .filter((item) => resultIds.has(item.id))
              .map(conversationKey),
          )
          analysisItems.forEach((item) => {
            const conversationId = conversationKey(item)
            if (successfulConversationIds.has(conversationId)) resultIds.add(item.id)
          })
          return [...resultIds]
        })()
        : result.analyzedIds
      onAiAnalysis(acceptedCandidates, analyzedIds, aiSettings, {
        sourceMessageCount: source.length,
        conversationCount: result.plan.totalConversations,
        processedConversationCount: result.processedConversations,
        requestedConversationCount: result.plan.totalConversations,
      }, !result.cancelled && result.failedConversations.length === 0, timelineMode === 'last-chat')
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
      if (targets.people && !result.cancelled && result.failedConversations.length === 0) {
        const peopleCheckpoint = { ...checkpointRef.current!, stage: 'people' as const, completedConversationIds: [] }
        checkpointRef.current = peopleCheckpoint
        onAnalysisCheckpoint(peopleCheckpoint)
        const peopleResult = await onPeopleAnalysis(source, aiSettings, (progress) => {
          const peopleMessage = `人物总进度：${progress.completedConversations ?? 0}/${progress.totalConversations ?? selectedConversationCount} 个对话；片段 ${progress.completed}/${progress.total}；已保留 ${progress.candidates} 张人物卡。`
          setAiProgress(progress)
          persistCompletedConversation(progress)
          setAiMessage(peopleMessage)
        })
        if (!peopleResult.started) {
          setAiMessage(peopleResult.reason ?? '当前范围没有可提炼的人物。')
          checkpointRef.current = undefined
          onAnalysisCheckpoint(undefined)
        }
        if (peopleResult.started) {
          const peopleAnalyzedIds = automatic
            ? (() => {
              const resultIds = new Set(peopleResult.analyzedIds ?? [])
              const successfulConversationIds = new Set(
                analysisItems
                  .filter((item) => resultIds.has(item.id))
                  .map(conversationKey),
              )
              analysisItems.forEach((item) => {
                const conversationId = conversationKey(item)
                if (successfulConversationIds.has(conversationId)) resultIds.add(item.id)
              })
              return [...resultIds]
            })()
            : peopleResult.analyzedIds ?? []
          onAnalysisWatermark(peopleAnalyzedIds, timelineMode === 'last-chat')
          if (peopleResult.failedConversationIds?.length) {
            setRetryConversationIds(peopleResult.failedConversationIds)
            setAiMessage(`任务提炼已完成，人物提炼保留了成功结果；${peopleResult.failedConversationIds.length} 个会话仍需重试。`)
          } else {
            checkpointRef.current = undefined
            onAnalysisCheckpoint(undefined)
          }
        }
      } else if (!result.cancelled && result.failedConversations.length === 0) {
        checkpointRef.current = undefined
        onAnalysisCheckpoint(undefined)
      }
    } catch (error) {
      const failureMessage = error instanceof Error && error.name === 'AbortError'
        ? '已停止本轮提炼；已经写入本地的候选和人物卡会保留。'
        : error instanceof Error ? error.message : '模型分析失败，请检查代理和密钥配置。'
      setAiMessage(failureMessage)
    } finally {
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null
      aiBusyRef.current = false
      setAiBusy(false)
      onAnalysisWorkChange(null)
    }
  }, [aiSettings, analysisConversationCount, analysisConversationId, analysisMessages, analysisTargets, appendDebugLog, attachmentFiles, conversationFingerprints, conversationKinds, effectiveConcurrency, onAiAnalysis, onAnalysisCheckpoint, onAnalysisWatermark, onAnalysisWorkChange, onDirectPeopleDetected, onPeopleAnalysis, scope, timelineEnd, timelineMode, timelineStart])

  const stopAiAnalysis = () => {
    if (!aiBusyRef.current) return
    const current = checkpointRef.current
    if (current) {
      const paused = { ...current, pausedAt: new Date().toISOString() }
      checkpointRef.current = paused
      onAnalysisCheckpoint(paused)
    }
    setAiMessage('正在停止本轮提炼；已完成片段的候选会自动进入待确认列表。')
    analysisAbortRef.current?.abort()
    onStopPeopleAnalysis()
  }

  const retryFailedAnalysis = () => {
    const retryCheckpoint = checkpointForRetry(checkpointRef.current, retryConversationIds)
    if (retryCheckpoint) {
      void runAiAnalysis(false, [], retryCheckpoint)
      return
    }
    void runAiAnalysis(false, retryConversationIds)
  }

  useEffect(() => {
    const checkpoint = aiSettings.interruptedRun
    if (!checkpoint || !items.length || aiBusyRef.current || resumePromptedRef.current === checkpoint.startedAt) return
    resumePromptedRef.current = checkpoint.startedAt
    const timer = window.setTimeout(() => {
      const shouldResume = window.confirm(`发现上次未完成的${checkpoint.stage === 'people' ? '人物' : '任务'}提炼（已完成 ${checkpoint.completedConversationIds.length}/${checkpoint.conversationIds.length} 个对话）。是否继续？`)
      if (shouldResume) {
        void runAiAnalysis(false, [], checkpoint)
      } else {
        // Declining means "not now", not "discard progress". Keep the
        // checkpoint on disk and suppress only this launch's prompt.
        setAiMessage('已保留上次未完成提炼；本次启动不再自动询问，下次启动仍可继续。')
      }
    }, 180)
    return () => window.clearTimeout(timer)
  }, [aiSettings.interruptedRun, items.length, onAnalysisCheckpoint, runAiAnalysis])

  useEffect(() => {
    if (!aiSettings.autoEnabled) return
    const timer = window.setInterval(() => {
      const taskDue = isDue(aiSettings.lastRunAt, aiSettings.intervalHours)
      const peopleDue = isDue(aiSettings.lastPeopleFollowupAt, aiSettings.intervalHours)
      const due = analysisTargets.tasks && analysisTargets.people ? taskDue || peopleDue : analysisTargets.people ? peopleDue : taskDue
      if (aiStatus?.configured && !aiBusyRef.current && (due || automaticWorkPending)) void runAiAnalysis(true)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [aiSettings.autoEnabled, aiSettings.intervalHours, aiSettings.lastPeopleFollowupAt, aiSettings.lastRunAt, aiStatus?.configured, analysisTargets, automaticWorkPending, runAiAnalysis])

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
            {automationState === 'watching' && <button type="button" className="secondary-button batch-button" onClick={() => handleRef.current && void syncDirectory(handleRef.current, true)} disabled={busy}><RefreshCw size={15} />按目录重建</button>}
            {automationState === 'watching' && <button type="button" className="icon-button" aria-label="立即扫描目录" onClick={() => handleRef.current && void syncDirectory(handleRef.current)} disabled={busy}><RefreshCw size={17} /></button>}
            <button type="button" className="primary-button" onClick={() => void connectDirectory()} disabled={busy || automationState === 'unsupported'}><FolderOpen size={16} />{folderName ? '重新连接' : '连接目录'}</button>
          </div>
        </div>
        {archiveLoadError && <p className="archive-load-error" role="alert">{archiveLoadError}</p>}
        {automationState === 'watching' && <div className="scan-stats" aria-label="扫描统计"><span><strong>{formatCount(scanStats.files)}</strong>个可解析导出文件</span><span><strong>{formatCount(scanStats.changed)}</strong>个{scanStats.rebuilt ? '重建处理' : '新增或变动'}文件</span><span><strong>{formatCount(scanStats.records)}</strong>条本次解析消息（导入前）</span></div>}
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
          <div className="intel-workflow-picker" role="group" aria-label="提炼内容">
            <span>提炼内容</span>
            <label className="auto-switch"><input type="checkbox" checked={analysisTargets.tasks} onChange={(event) => setAnalysisTargets((current) => ({ ...current, tasks: event.target.checked }))} disabled={aiBusy} /><span>任务</span></label>
            <label className="auto-switch"><input type="checkbox" checked={analysisTargets.people} onChange={(event) => setAnalysisTargets((current) => ({ ...current, people: event.target.checked }))} disabled={aiBusy} /><span>人物</span></label>
            <button type="button" className="text-button" onClick={() => setAnalysisTargets({ tasks: true, people: true })} disabled={aiBusy || (analysisTargets.tasks && analysisTargets.people)}>全选</button>
          </div>
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
          <div className="archive-stage"><span>当前导出文件</span><strong>{archive.fileCount === undefined ? '未记录' : formatCount(archive.fileCount)}</strong><small>连接目录中的 JSON、CSV、TXT 文件数；不等于消息数。</small></div>
          <div className="archive-stage"><span>原始消息档案</span><strong>{formatCount(archive.messageCount)}</strong><small>当前目录快照去重后留存的消息总数；不是文件数，也不是模型上下文。</small></div>
          <div className="archive-stage"><span>已归档对话</span><strong>{formatCount(archive.conversationCount)}</strong><small>{archive.identifiedConversationCount ? `${formatCount(archive.identifiedConversationCount)} 个由导出目录确认。` : '旧记录尚未带目录身份。'}{archive.messagesWithoutConversation ? ` ${formatCount(archive.messagesWithoutConversation)} 条旧记录按来源月份临时归档。` : ''}</small></div>
          <div className="archive-stage"><span>本轮选择</span><strong>{formatCount(analysisConversationCount)} 个对话</strong><small>{analysisConversationId ? `已指定“${analysisConversation?.name ?? '对话'}”，范围内有 ${formatCount(analysisMessages.length)} 条消息。` : `范围内有 ${formatCount(analysisMessages.length)} 条消息，按${timelineMode === 'last-chat' ? '最后聊天时间' : '严格时间窗口'}筛选。`}</small></div>
          <div className="archive-stage"><span>模型输入方式</span><strong>完整覆盖分段</strong><small>超长会话按时间连续分段，每段保留少量前序上下文；全部消息都会上传，不做抽样或固定条数截断。</small></div>
        </div>
        <div className="attachment-row"><input ref={attachmentRef} type="file" accept="image/*,.pdf,.json,.csv,.txt" multiple onChange={addAttachments} hidden /><button type="button" className="secondary-button" onClick={() => attachmentRef.current?.click()} disabled={aiBusy}><ImagePlus size={16} />添加图片或文件</button>{attachmentFiles.map((file, index) => <span className="attachment-chip" key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachmentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></span>)}</div>
        <div className="ai-actions"><button type="button" className="primary-button" onClick={() => void runAiAnalysis()} disabled={aiBusy || !aiStatus?.configured || (!analysisTargets.tasks && !analysisTargets.people)}><Sparkles size={16} />{aiBusy ? '按对话提炼中' : analysisConversationId ? '提炼指定对话' : scope === 'all' ? '提炼全部对话' : '提炼当前范围'}</button>{aiBusy && <button type="button" className="secondary-button ai-stop-button" onClick={stopAiAnalysis}><Pause size={15} />暂停并保存进度</button>}{retryConversationIds.length > 0 && <button type="button" className="secondary-button" onClick={retryFailedAnalysis} disabled={aiBusy || !aiStatus?.configured}><RefreshCw size={15} />重试失败会话 {retryConversationIds.length}</button>}<span>{formatLastRun(aiSettings.lastRunAt)} · {effectiveConcurrency} 个会话并行{aiProgress && aiBusy ? ` · 总进度 ${aiProgress.completedConversations ?? 0}/${aiProgress.totalConversations ?? analysisConversationCount} 个对话${aiProgress.total ? ` · ${aiProgress.completed}/${aiProgress.total} 个片段` : ''}` : ''}</span></div>
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

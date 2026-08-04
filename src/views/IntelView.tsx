import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Check, ChevronDown, Trash2 } from 'lucide-react'
import type { AiExtractionCheckpoint, AiFeedbackReason, AiSettings, AiTaskCandidate, ArchiveAnalysisSummary, ArchiveSummary, IntelItem, Person } from '../types'
import { parseIntelFile } from '../lib/importer'
import { chooseExportDirectory, DIRECTORY_IMPORT_SIGNATURE_VERSION, ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle, scanExportDirectory, supportsDirectorySync, type LocalDirectoryHandle } from '../lib/directorySync'
import { planDirectoryImport } from '../lib/directoryManifest'
import { AI_STATUS_CHANGED_EVENT, getAiStatus, type AiDebugEntry, type AiProgress, type AiStatus } from '../lib/aiClient'
import { formatQuestTime } from '../lib/questTime'
import { normalizeAiConcurrency } from '../lib/aiConcurrency'
import { CandidateQueue } from './intel/CandidateQueue'
import { ConversationBrowser } from './intel/ConversationBrowser'
import { ArchivePanel, type AutomationState } from './intel/ArchivePanel'
import { AnalysisPanel } from './intel/AnalysisPanel'
import { useIntelAnalysisSelection, type AnalysisScope, type AnalysisTargets, type TimelineFilterMode } from '../hooks/useIntelAnalysisSelection'
import { useAiWorkflow, type AnalysisWorkState } from '../hooks/useAiWorkflow'

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

const DIRECTORY_SNAPSHOT_KEY = 'theia:directory-snapshot:v1'
const DIRECTORY_MANIFEST_KEY = 'theia:directory-manifest:v1'
const DIRECTORY_SYNC_STATE_KEY = 'theia:directory-sync-state:v2'
const AI_DEBUG_LOG_KEY = 'theia:ai-debug-log:v1'
const MAX_DEBUG_LOG_ENTRIES = 800

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
    people_merge_started: '人物归并开始',
    people_merge_succeeded: '人物归并完成',
    people_merge_failed: '人物归并失败',
    people_merge_aborted: '人物归并取消',
    people_run_completed: '人物处理结束',
    run_completed: '提炼结束',
  }
  return labels[event] ?? event
}

function formatChatTime(value?: string) {
  if (!value) return '未记录时间'
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '未记录时间'
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
  const [analysisRetained, setAnalysisRetained] = useState(false)
  const [debugLog, setDebugLog] = useState<AiDebugEntry[]>(loadAiDebugLog)
  const [timelineStart, setTimelineStart] = useState('')
  const [timelineEnd, setTimelineEnd] = useState('')
  const [timelineMode, setTimelineMode] = useState<TimelineFilterMode>('last-chat')
  const [analysisTargets, setAnalysisTargets] = useState<AnalysisTargets>({ tasks: true, people: true })
  const [analysisConversationId, setAnalysisConversationId] = useState('')
  const [openSections, setOpenSections] = useState({ intake: true, analysis: true, debug: true, created: false, candidates: true, conversations: true })
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set())
  const pendingCandidates = useMemo(() => candidates.filter((candidate) => candidate.status === 'pending'), [candidates])
  // Generated candidates are removed once a quest is created; keep no
  // temporary archive section in the interface for legacy snapshots.
  const createdCandidates: AiTaskCandidate[] = []
  const validSelectedCandidates = useMemo(() => {
    const available = new Set(pendingCandidates.map((candidate) => candidate.id))
    return new Set([...selectedCandidates].filter((id) => available.has(id)))
  }, [pendingCandidates, selectedCandidates])
  const conversationIndexEnabled = active || analysisRetained || aiSettings.autoEnabled || Boolean(aiSettings.interruptedRun) || Boolean(conversationRequest)
  // Keep directory discovery mounted, but avoid indexing hundreds of
  // thousands of records while the archive screen is hidden and idle.
  const indexedItems = conversationIndexEnabled ? items : null
  const intelById = useMemo(() => indexedItems ? new Map(indexedItems.map((item) => [item.id, item])) : new Map<string, IntelItem>(), [indexedItems])
  const { conversations, conversationFingerprints, conversationKinds, filteredConversations, analysisConversation, analysisMessages, analysisConversationCount, automaticWorkPending } = useIntelAnalysisSelection({ indexedItems, aiSettings, scope, timelineMode, timelineStart, timelineEnd, analysisConversationId, analysisTargets })
  const configuredProviderCapacity = aiStatus?.scheduler?.totalMaxConcurrency ?? aiStatus?.totalMaxConcurrency ?? 0
  // Preserve the user's configured pool behavior. Request size is controlled
  // by the conversation segment planner, not by silently lowering channel
  // concurrency at the UI layer.
  const effectiveConcurrency = normalizeAiConcurrency(Math.max(Number(aiSettings.concurrency) || 0, configuredProviderCapacity))
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
  const showCandidateQueue = useCallback(() => {
    setOpenSections((current) => ({ ...current, candidates: true }))
  }, [])
  const selectWorkflowCandidates = useCallback((ids: string[]) => {
    setSelectedCandidates(new Set(ids))
  }, [])
  const {
    busy: aiBusy,
    progress: aiProgress,
    message: aiMessage,
    setMessage: setAiMessage,
    retryConversationIds,
    run: runAiAnalysis,
    stop: stopAiAnalysis,
    retry: retryFailedAnalysis,
  } = useAiWorkflow({
    items,
    aiSettings,
    aiStatus,
    scope,
    timelineMode,
    timelineStart,
    timelineEnd,
    analysisTargets,
    analysisConversationId,
    analysisMessages,
    analysisConversationCount,
    conversationFingerprints,
    conversationKinds,
    automaticWorkPending,
    effectiveConcurrency,
    attachmentFiles,
    appendDebugLog,
    onAiAnalysis,
    onDirectPeopleDetected,
    onPeopleAnalysis,
    onAnalysisWatermark,
    onStopPeopleAnalysis,
    onAnalysisCheckpoint,
    onAnalysisWorkChange,
    onBusyChange: setAnalysisRetained,
    onCandidatesSelected: selectWorkflowCandidates,
    onCandidatesAvailable: showCandidateQueue,
  })
  useEffect(() => {
    void getAiStatus().then(setAiStatus).catch(() => setAiMessage('无法连接本机模型代理，请在选项中配置模型通道。'))
    const updateStatus = (event: Event) => setAiStatus((event as CustomEvent<AiStatus>).detail)
    window.addEventListener(AI_STATUS_CHANGED_EVENT, updateStatus)
    return () => window.removeEventListener(AI_STATUS_CHANGED_EVENT, updateStatus)
  }, [setAiMessage])

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
  const resetConversationTimeline = useCallback(() => {
    setTimelineMode('last-chat')
    setTimelineStart('')
    setTimelineEnd('')
  }, [])
  const openConversationSection = useCallback(() => {
    setOpenSections((current) => ({ ...current, conversations: true }))
  }, [])
  const analyzeConversation = useCallback((id: string) => {
    setAnalysisConversationId(id)
    setOpenSections((current) => ({ ...current, analysis: true }))
  }, [])
  const automationLabel = automationState === 'watching' ? `已连接 ${folderName}` : automationState === 'needs-permission' ? `等待重新授权 ${folderName}` : automationState === 'unsupported' ? '当前浏览器不支持目录访问' : '尚未连接导出目录'

  return (
    <div className="intel-view page-width">
      <ArchivePanel
        open={openSections.intake}
        automationState={automationState}
        automationLabel={automationLabel}
        folderName={folderName}
        message={message}
        lastScan={lastScan}
        busy={busy}
        archive={archive}
        archiveLoadError={archiveLoadError}
        scanStats={scanStats}
        inputRef={inputRef}
        onToggleOpen={() => setOpenSections((current) => ({ ...current, intake: !current.intake }))}
        onConnect={() => void connectDirectory()}
        onScan={() => { if (handleRef.current) void syncDirectory(handleRef.current) }}
        onRebuild={() => { if (handleRef.current) void syncDirectory(handleRef.current, true) }}
        onImportFiles={importFiles}
      />

      <AnalysisPanel
        open={openSections.analysis}
        aiStatus={aiStatus}
        scope={scope}
        analysisTargets={analysisTargets}
        analysisConversationId={analysisConversationId}
        analysisConversation={analysisConversation}
        conversations={conversations}
        filteredConversationCount={filteredConversations.length}
        timelineMode={timelineMode}
        timelineStart={timelineStart}
        timelineEnd={timelineEnd}
        analysisMessageCount={analysisMessages.length}
        analysisConversationCount={analysisConversationCount}
        archive={archive}
        attachmentRef={attachmentRef}
        attachmentFiles={attachmentFiles}
        aiBusy={aiBusy}
        retryConversationIds={retryConversationIds}
        aiSettings={aiSettings}
        effectiveConcurrency={effectiveConcurrency}
        aiProgress={aiProgress}
        aiMessage={aiMessage}
        onToggleOpen={() => setOpenSections((current) => ({ ...current, analysis: !current.analysis }))}
        onScopeChange={setScope}
        onTargetsChange={setAnalysisTargets}
        onConversationChange={setAnalysisConversationId}
        onTimelineModeChange={setTimelineMode}
        onTimelineStartChange={setTimelineStart}
        onTimelineEndChange={setTimelineEnd}
        onClearTimeline={() => { setTimelineStart(''); setTimelineEnd('') }}
        onAddAttachments={addAttachments}
        onRemoveAttachment={(index) => setAttachmentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
        onRun={() => void runAiAnalysis()}
        onStop={stopAiAnalysis}
        onRetry={retryFailedAnalysis}
      />

      <section className={`intel-list-section intel-collapsible-section ai-debug-section ${openSections.debug ? 'is-open' : 'is-collapsed'}`}>
        <div className="list-heading"><div><span className="section-kicker">LOCAL DEBUG · 不含聊天正文与密钥</span><h2><button type="button" className="intel-section-toggle" aria-expanded={openSections.debug} onClick={() => setOpenSections((current) => ({ ...current, debug: !current.debug }))}>模型调试日志<ChevronDown size={17} /></button></h2></div><div className="list-heading-actions"><span>{debugLog.length} 条</span><button type="button" className="icon-button" title="清除本机界面日志" aria-label="清除本机界面日志" onClick={clearDebugLog} disabled={!debugLog.length}><Trash2 size={15} /></button></div></div>
        {openSections.debug && <><div className="bulk-note">服务端会在本地日志目录写入调试事件。日志仅含会话名称、分段序号、记录数、请求状态、重试和候选统计，不保存聊天正文、附件或密钥。</div><div className="ai-debug-log">{debugLog.map((entry, index) => <article className={`ai-debug-entry ai-debug-entry--${entry.level}`} key={`${entry.at}-${entry.event}-${index}`}><time>{formatChatTime(entry.at)}</time><strong>{debugEventLabel(entry.event)}</strong><span>{entry.personName ?? entry.conversationName ?? '批处理'}</span>{typeof entry.segmentIndex === 'number' && <em>第 {entry.segmentIndex}/{entry.segmentCount} 段{entry.historical ? ' · 历史' : ''}</em>}{typeof entry.pendingCount === 'number' && typeof entry.totalCount === 'number' && <em>等待 {entry.pendingCount}/{entry.totalCount}</em>}{typeof entry.durationMs === 'number' && <em>{entry.durationMs} ms</em>}{entry.model && <em>{entry.model}</em>}{typeof entry.recordCount === 'number' && <em>{formatCount(entry.recordCount)} 条消息</em>}{typeof entry.coreRecordCount === 'number' && <em>核心 {formatCount(entry.coreRecordCount)} 条{entry.overlapRecordCount ? ` · 重叠 ${formatCount(entry.overlapRecordCount)} 条` : ''}</em>}{typeof entry.attempt === 'number' && <em>第 {entry.attempt}/{entry.attemptTotal} 次</em>}{typeof entry.status === 'number' && <em>HTTP {entry.status}</em>}{typeof entry.candidateCount === 'number' && <em>模型 {entry.candidateCount} 个</em>}{typeof entry.acceptedCandidateCount === 'number' && <em>保留 {entry.acceptedCandidateCount} 个</em>}{entry.message && <p>{entry.message}</p>}</article>)}{!debugLog.length && <p className="empty-note">尚无模型请求日志。</p>}</div></>}
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

      <CandidateQueue
        open={openSections.candidates}
        candidates={pendingCandidates}
        selectedIds={validSelectedCandidates}
        intelById={intelById}
        onToggleOpen={() => setOpenSections((current) => ({ ...current, candidates: !current.candidates }))}
        onSelectAll={selectAllCandidates}
        onToggleCandidate={toggleCandidate}
        onDismiss={dismissCandidates}
        onCreateAll={() => onCreateAiQuests(pendingCandidates)}
        onCreateSelected={createSelected}
      />

      <ConversationBrowser
        open={openSections.conversations}
        conversations={conversations}
        filteredConversations={filteredConversations}
        analysisConversationId={analysisConversationId}
        conversationRequest={conversationRequest}
        onToggleOpen={() => setOpenSections((current) => ({ ...current, conversations: !current.conversations }))}
        onOpen={openConversationSection}
        onAnalyze={analyzeConversation}
        onResetTimeline={resetConversationTimeline}
      />

    </div>
  )
}

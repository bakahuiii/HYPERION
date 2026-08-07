import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Check, ChevronDown, Trash2 } from 'lucide-react'
import type { AiExtractionCheckpoint, AiFeedbackReason, AiSettings, AiTaskCandidate, ArchiveAnalysisSummary, ArchiveSummary, ContextEvent, IntelItem, Person, SelfAnalysis } from '../types'
import { AI_STATUS_CHANGED_EVENT, getAiStatus, type AiDebugEntry, type AiProgress, type AiStatus } from '../lib/aiClient'
import { localProxyUrl } from '../lib/apiUrl'
import { formatQuestTime } from '../lib/questTime'
import { normalizeAiConcurrency } from '../lib/aiConcurrency'
import { CandidateQueue } from './intel/CandidateQueue'
import { ConversationBrowser } from './intel/ConversationBrowser'
import { AnalysisPanel } from './intel/AnalysisPanel'
import { useIntelAnalysisSelection, type AnalysisScope, type AnalysisTargets, type TimelineFilterMode } from '../hooks/useIntelAnalysisSelection'
import { useAiWorkflow, type AnalysisWorkState } from '../hooks/useAiWorkflow'
import { useArchiveConversationIndex } from '../hooks/useArchiveConversationIndex'
import { loadIntelSnapshot, loadSharedIntelSnapshot, type ArchiveConversationSummary } from '../lib/intelStore'

interface IntelViewProps {
  active: boolean
  items: IntelItem[]
  archiveLoadError?: string
  archive: ArchiveSummary
  candidates: AiTaskCandidate[]
  contextEvents: ContextEvent[]
  aiSettings: AiSettings
  onAiAnalysis: (candidates: AiTaskCandidate[], analyzedIds: string[], settings: AiSettings, summary: Omit<ArchiveAnalysisSummary, 'analyzedAt'>, completedSuccessfully: boolean, watermarkEligible?: boolean) => void
  onDirectPeopleDetected: (people: Person[]) => void
  onPeopleAnalysis: (items: IntelItem[], settings: AiSettings, onProgress?: (progress: AiProgress) => void) => Promise<{ started: boolean; reason?: string; failedConversationIds?: string[]; analyzedIds?: string[] }>
  onSelfAnalysis: (analysis: SelfAnalysis) => void
  onAnalysisWatermark: (analyzedIds: string[], eligible: boolean) => void
  onStopPeopleAnalysis: () => void
  onAnalysisCheckpoint: (checkpoint?: AiExtractionCheckpoint) => void
  onCreateAiQuests: (candidates: AiTaskCandidate[]) => number
  onDismissAiCandidates: (ids: string[], reason?: AiFeedbackReason) => void
  onAnalysisWorkChange: (state: AnalysisWorkState | null) => void
  onArchiveLoaded?: (items: IntelItem[]) => void
  conversationRequest?: { id: string; sequence: number }
}

const AI_DEBUG_LOG_KEY = 'hyperion:ai-debug-log:v1'
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
    self_observation_segment_started: '自我观察请求',
    self_observation_segment_succeeded: '自我观察完成',
    self_observation_segment_failed: '自我观察失败',
    self_observation_started: '自我观察开始',
    self_observation_succeeded: '自我观察完成',
    self_observation_failed: '自我观察失败',
    self_merge_succeeded: '自我阶段归并完成',
    self_merge_failed: '自我阶段归并失败',
    self_analysis_completed: '自我分析完成',
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

export function IntelView({ active, items, archiveLoadError, archive, candidates, contextEvents, aiSettings, onAiAnalysis, onDirectPeopleDetected, onPeopleAnalysis, onSelfAnalysis, onAnalysisWatermark, onStopPeopleAnalysis, onAnalysisCheckpoint, onCreateAiQuests: createAiQuests, onDismissAiCandidates, onAnalysisWorkChange, onArchiveLoaded, conversationRequest }: IntelViewProps) {
  const attachmentRef = useRef<HTMLInputElement>(null)
  const [scope, setScope] = useState<AnalysisScope>('all')
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([])
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [analysisRetained, setAnalysisRetained] = useState(false)
  const [deferredAnalysisItems, setDeferredAnalysisItems] = useState<IntelItem[] | null>(null)
  const pendingDeferredRunRef = useRef(false)
  const [debugLog, setDebugLog] = useState<AiDebugEntry[]>(loadAiDebugLog)
  const [timelineStart, setTimelineStart] = useState('')
  const [timelineEnd, setTimelineEnd] = useState('')
  const [timelineMode, setTimelineMode] = useState<TimelineFilterMode>('last-chat')
  const [analysisTargets, setAnalysisTargets] = useState<AnalysisTargets>({ tasks: true, people: true, self: true })
  const [analysisConversationId, setAnalysisConversationId] = useState('')
  const [openSections, setOpenSections] = useState({ analysis: true, debug: true, created: false, candidates: true, conversations: false })
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set())
  const [mnemoIssue, setMnemoIssue] = useState('')
  const pendingCandidates = useMemo(() => candidates.filter((candidate) => candidate.status === 'pending'), [candidates])
  // Generated candidates are removed once a quest is created; keep no
  // temporary archive section in the interface for legacy snapshots.
  const createdCandidates: AiTaskCandidate[] = []
  const validSelectedCandidates = useMemo(() => {
    const available = new Set(pendingCandidates.map((candidate) => candidate.id))
    return new Set([...selectedCandidates].filter((id) => available.has(id)))
  }, [pendingCandidates, selectedCandidates])
  const conversationIndexEnabled = active || analysisRetained || aiSettings.autoEnabled || Boolean(aiSettings.interruptedRun) || Boolean(conversationRequest)
  // Keep archive list work out of the background. The browser fetches its
  // compact directory only after the user opens this specific section.
  const archiveBrowserEnabled = (active && openSections.conversations) || Boolean(conversationRequest)
  // Keep directory discovery mounted, but avoid indexing hundreds of
  // thousands of records while the archive screen is hidden and idle.
  const workflowItems = deferredAnalysisItems ?? items
  const indexedItems = conversationIndexEnabled ? workflowItems : null
  const intelById = useMemo(() => indexedItems ? new Map(indexedItems.map((item) => [item.id, item])) : new Map<string, IntelItem>(), [indexedItems])
  const { conversations, conversationFingerprints, conversationKinds, filteredConversations, analysisConversation, analysisMessages, analysisConversationCount, automaticWorkPending, automaticPendingRecordCount } = useIntelAnalysisSelection({ indexedItems, aiSettings, scope, timelineMode, timelineStart, timelineEnd, analysisConversationId, analysisTargets })
  const archiveConversationIndex = useArchiveConversationIndex(archiveBrowserEnabled, `${archive.sourceFingerprint ?? ''}:${archive.lastImport?.importedAt ?? ''}:${archive.messageCount}`)
  const browserConversationFallback = useMemo<ArchiveConversationSummary[]>(() => conversations.map((conversation) => {
    let latestPreview = conversation.records.at(-1)
    for (let index = conversation.records.length - 1; index >= 0; index -= 1) {
      if (conversation.records[index].speakerRole === 'other') {
        latestPreview = conversation.records[index]
        break
      }
    }
    return {
      id: conversation.id,
      name: conversation.name,
      kind: conversation.kind,
      source: conversation.source,
      recordCount: conversation.records.length,
      firstAt: conversation.firstAt,
      lastAt: conversation.lastAt,
      latestPreview,
    }
  }), [conversations])
  const usePagedConversationIndex = !archiveConversationIndex.error && (archiveConversationIndex.loading || archiveConversationIndex.conversations.length > 0 || archive.messageCount === 0)
  const browserConversations = usePagedConversationIndex ? archiveConversationIndex.conversations : browserConversationFallback
  const browserFilteredConversations = useMemo(() => browserConversations.filter((conversation) => {
    if (timelineMode === 'last-chat') {
      if (!timelineStart && !timelineEnd) return true
      const lastAt = Date.parse(conversation.lastAt ?? '')
      const startAt = timelineStart ? Date.parse(`${timelineStart}T00:00:00`) : Number.NEGATIVE_INFINITY
      const endAt = timelineEnd ? Date.parse(`${timelineEnd}T23:59:59.999`) : Number.POSITIVE_INFINITY
      return Number.isFinite(lastAt) && lastAt >= startAt && lastAt <= endAt
    }
    if (!timelineStart && !timelineEnd) return true
    const firstAt = Date.parse(conversation.firstAt ?? '')
    const lastAt = Date.parse(conversation.lastAt ?? '')
    const startAt = timelineStart ? Date.parse(`${timelineStart}T00:00:00`) : Number.NEGATIVE_INFINITY
    const endAt = timelineEnd ? Date.parse(`${timelineEnd}T23:59:59.999`) : Number.POSITIVE_INFINITY
    return Number.isFinite(firstAt) && Number.isFinite(lastAt) && firstAt <= endAt && lastAt >= startAt
  }), [browserConversations, timelineEnd, timelineMode, timelineStart])
  const configuredProviderCapacity = aiStatus?.scheduler?.totalMaxConcurrency ?? aiStatus?.totalMaxConcurrency ?? 0
  // Preserve the user's configured pool behavior. Request size is controlled
  // by the conversation segment planner, not by silently lowering channel
  // concurrency at the UI layer.
  const effectiveConcurrency = normalizeAiConcurrency(Math.max(Number(aiSettings.concurrency) || 0, configuredProviderCapacity))
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
    window.addEventListener('hyperion:ai-debug', relay)
    return () => window.removeEventListener('hyperion:ai-debug', relay)
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
    run: runAiAnalysisDirect,
    stop: stopAiAnalysis,
    retry: retryFailedAnalysis,
  } = useAiWorkflow({
    items: workflowItems,
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
    automaticPendingRecordCount,
    effectiveConcurrency,
    attachmentFiles,
    contextEvents,
    appendDebugLog,
    onAiAnalysis,
    onDirectPeopleDetected,
    onPeopleAnalysis,
    onSelfAnalysis,
    onAnalysisWatermark,
    onStopPeopleAnalysis,
    onAnalysisCheckpoint,
    onAnalysisWorkChange,
    onBusyChange: setAnalysisRetained,
    onCandidatesSelected: selectWorkflowCandidates,
    onCandidatesAvailable: showCandidateQueue,
  })
  const loadDeferredArchive = useCallback(async () => {
    if (deferredAnalysisItems?.length) return deferredAnalysisItems
    let loaded: IntelItem[]
    try {
      loaded = (await loadSharedIntelSnapshot()).items
    } catch {
      loaded = (await loadIntelSnapshot())?.items ?? []
    }
    if (!loaded.length) throw new Error('本地归档没有可供提炼的消息。')
    setDeferredAnalysisItems(loaded)
    onArchiveLoaded?.(loaded)
    return loaded
  }, [deferredAnalysisItems, onArchiveLoaded])
  const runAiAnalysis = useCallback(async () => {
    // A large archive can stay body-deferred at startup. Local producers may
    // append one journal row meanwhile; treating that single row as a complete
    // archive would make self analysis miss the rest of the user's history.
    if (archive.messageCount > workflowItems.length) {
      pendingDeferredRunRef.current = true
      setAiMessage('正在按需读取归档，读取完成后会自动开始提炼。')
      try { await loadDeferredArchive() } catch (error) {
        pendingDeferredRunRef.current = false
        setAiMessage(error instanceof Error ? error.message : '归档读取失败。')
      }
      return
    }
    return runAiAnalysisDirect()
  }, [archive.messageCount, loadDeferredArchive, runAiAnalysisDirect, setAiMessage, workflowItems.length])
  useEffect(() => {
    if (!pendingDeferredRunRef.current || !workflowItems.length) return
    pendingDeferredRunRef.current = false
    void runAiAnalysisDirect()
  }, [runAiAnalysisDirect, workflowItems.length])
  useEffect(() => {
    void getAiStatus().then(setAiStatus).catch(() => setAiMessage('无法连接本机模型代理，请在选项中配置模型通道。'))
    const updateStatus = (event: Event) => setAiStatus((event as CustomEvent<AiStatus>).detail)
    window.addEventListener(AI_STATUS_CHANGED_EVENT, updateStatus)
    return () => window.removeEventListener(AI_STATUS_CHANGED_EVENT, updateStatus)
  }, [setAiMessage])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const response = await fetch(localProxyUrl('/api/mnemo/status'), { cache: 'no-store' })
        if (!response.ok) return
        const status = await response.json() as {
          agent?: { lastError?: unknown }
          directories?: Array<{ lastError?: unknown }>
        }
        const agentIssue = typeof status.agent?.lastError === 'string' ? status.agent.lastError : ''
        const inboxIssue = status.directories
          ?.map((directory) => typeof directory.lastError === 'string' ? directory.lastError : '')
          .find(Boolean) ?? ''
        if (!cancelled) setMnemoIssue(agentIssue || inboxIssue)
      } catch {
        // A transient local-proxy failure is not a data anomaly.
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

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
  return (
    <div className="intel-view page-width">
      {(archiveLoadError || mnemoIssue) && <p className="archive-load-error" role="alert">{archiveLoadError || mnemoIssue}</p>}

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
        conversations={browserConversations}
        filteredConversations={browserFilteredConversations}
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

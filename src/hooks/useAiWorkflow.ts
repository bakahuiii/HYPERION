import { useCallback, useEffect, useRef, useState } from 'react'

import type { AiExtractionCheckpoint, AiSettings, AiTaskCandidate, ArchiveAnalysisSummary, IntelItem, Person } from '../types'
import {
  analyzeIntel,
  buildDirectConversationFallbackPeople,
  fileToAttachment,
  type AiDebugEntry,
  type AiProgress,
  type AiStatus,
} from '../lib/aiClient'
import { checkpointForRetry } from '../lib/analysisCheckpoint'
import { analysisConversationKey } from '../lib/analysisWatermark'
import {
  conversationKey,
  fullConversationRecords,
  incrementalConversationRecords,
  withinStrictTimeRange,
} from '../lib/intelConversationView'
import type { AnalysisScope, AnalysisTargets, TimelineFilterMode } from './useIntelAnalysisSelection'

export interface AnalysisWorkState {
  stage: 'tasks' | 'people'
  completed: number
  total: number
  completedConversations?: number
  totalConversations?: number
  candidates: number
  message: string
}

interface PeopleAnalysisResult {
  started: boolean
  reason?: string
  failedConversationIds?: string[]
  analyzedIds?: string[]
}

interface UseAiWorkflowOptions {
  items: IntelItem[]
  aiSettings: AiSettings
  aiStatus: AiStatus | null
  scope: AnalysisScope
  timelineMode: TimelineFilterMode
  timelineStart: string
  timelineEnd: string
  analysisTargets: AnalysisTargets
  analysisConversationId: string
  analysisMessages: IntelItem[]
  analysisConversationCount: number
  conversationFingerprints: ReadonlyMap<string, string>
  conversationKinds: ReadonlyMap<string, IntelItem['conversationKind']>
  automaticWorkPending: boolean
  effectiveConcurrency: number
  attachmentFiles: File[]
  appendDebugLog: (entry: AiDebugEntry) => void
  onAiAnalysis: (
    candidates: AiTaskCandidate[],
    analyzedIds: string[],
    settings: AiSettings,
    summary: Omit<ArchiveAnalysisSummary, 'analyzedAt'>,
    completedSuccessfully: boolean,
    watermarkEligible?: boolean,
  ) => void
  onDirectPeopleDetected: (people: Person[]) => void
  onPeopleAnalysis: (items: IntelItem[], settings: AiSettings, onProgress?: (progress: AiProgress) => void) => Promise<PeopleAnalysisResult>
  onAnalysisWatermark: (analyzedIds: string[], eligible: boolean) => void
  onStopPeopleAnalysis: () => void
  onAnalysisCheckpoint: (checkpoint?: AiExtractionCheckpoint) => void
  onAnalysisWorkChange: (state: AnalysisWorkState | null) => void
  onBusyChange?: (busy: boolean) => void
  onCandidatesSelected: (ids: string[]) => void
  onCandidatesAvailable: () => void
}

function isDue(lastRunAt: string | undefined, intervalHours: number) {
  return !lastRunAt || Date.now() - new Date(lastRunAt).getTime() >= Math.max(24, intervalHours) * 60 * 60 * 1000
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

/**
 * Owns the long-running task/people extraction state machine. Keeping this
 * outside IntelView prevents a render-only panel from retaining stale archive
 * closures while a provider request is in flight for several minutes.
 */
export function useAiWorkflow({
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
  onBusyChange,
  onCandidatesSelected,
  onCandidatesAvailable,
}: UseAiWorkflowOptions) {
  const itemsRef = useRef(items)
  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const checkpointRef = useRef<AiExtractionCheckpoint | undefined>(aiSettings.interruptedRun)
  const resumePromptedRef = useRef<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<AiProgress | null>(null)
  const [message, setMessage] = useState('')
  const [retryConversationIds, setRetryConversationIds] = useState<string[]>([])

  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { checkpointRef.current = aiSettings.interruptedRun }, [aiSettings.interruptedRun])

  const run = useCallback(async (automatic = false, retryIds: string[] = [], resumeCheckpoint?: AiExtractionCheckpoint) => {
    if (busyRef.current) return
    const targets = resumeCheckpoint?.targets ?? analysisTargets
    if (!targets.tasks && !targets.people) {
      setMessage('请至少选择“任务”或“人物”后再开始提炼。')
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
    const retryMatches = retryIds.length ? analysisItems.filter((item) => retryIds.includes(conversationKey(item))) : []
    const retrySource = timelineMode === 'strict-window'
      ? analysisMessages.filter((item) => retryIds.includes(conversationKey(item)))
      : fullConversationRecords(analysisItems, retryMatches)
    const resumeMatches = resumeCheckpoint
      ? analysisItems.filter((item) => resumeConversationIds.has(conversationKey(item)) && !resumeCompletedIds.has(conversationKey(item)))
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
      if (resumeCheckpoint) {
        checkpointRef.current = undefined
        onAnalysisCheckpoint(undefined)
        setMessage('上次提炼已没有剩余记录，已自动清理恢复状态。')
      } else {
        setMessage('没有符合当前分析范围的记录。')
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
    const persistCompletedConversation = (nextProgress: AiProgress) => {
      const completedId = nextProgress.completedConversationId
      const current = checkpointRef.current
      if (!completedId || !current || current.completedConversationIds.includes(completedId)) return
      const next = { ...current, completedConversationIds: [...current.completedConversationIds, completedId] }
      checkpointRef.current = next
      onAnalysisCheckpoint(next)
    }
    if (targets.people) onDirectPeopleDetected(buildDirectConversationFallbackPeople(source))
    setRetryConversationIds([])
    busyRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    onBusyChange?.(true)
    const workflowLabel = targets.tasks && targets.people ? '任务与人物' : targets.tasks ? '任务' : '人物'
    const startingMessage = retryIds.length
      ? `准备以 ${concurrency} 个并发会话重新提交 ${selectedConversationCount} 个失败会话的完整记录，共 ${formatCount(source.length)} 条消息。`
      : automatic
        ? `增量自动更新：将提炼${workflowLabel}，以 ${concurrency} 个并发会话提交 ${formatCount(automaticMatches.length)} 条新增消息和 ${formatCount(source.length - automaticMatches.length)} 条前序上下文。`
        : `准备提炼${workflowLabel}：以 ${concurrency} 个并发会话提交 ${selectedConversationCount} 个完整对话，共 ${formatCount(source.length)} 条归档消息。`
    setProgress({ completed: 0, total: 0, completedConversations: 0, totalConversations: selectedConversationCount, candidates: 0 })
    setMessage(startingMessage)
    if (!peopleStage) onAnalysisWorkChange({ stage: 'tasks', completed: 0, total: 0, completedConversations: 0, totalConversations: selectedConversationCount, candidates: 0, message: startingMessage })
    try {
      if (peopleStage) {
        const peopleResult = await onPeopleAnalysis(source, aiSettings, (nextProgress) => {
          const progressMessage = `人物总进度：${nextProgress.completedConversations ?? 0}/${nextProgress.totalConversations ?? selectedConversationCount} 个对话；片段 ${nextProgress.completed}/${nextProgress.total}；已保留 ${nextProgress.candidates} 张人物卡。`
          setProgress(nextProgress)
          persistCompletedConversation(nextProgress)
          setMessage(progressMessage)
        })
        if (peopleResult.started) {
          const peopleAnalyzedIds = automatic
            ? expandSuccessfulConversationIds(analysisItems, peopleResult.analyzedIds ?? [])
            : peopleResult.analyzedIds ?? []
          onAnalysisWatermark(peopleAnalyzedIds, timelineMode === 'last-chat')
        }
        if (!peopleResult.started) {
          setMessage(peopleResult.reason ?? '当前范围没有可提炼的人物。')
          checkpointRef.current = undefined
          onAnalysisCheckpoint(undefined)
          return
        }
        if (peopleResult.failedConversationIds?.length) {
          setRetryConversationIds(peopleResult.failedConversationIds)
          setMessage(`人物提炼已保留成功结果；${peopleResult.failedConversationIds.length} 个会话仍需重试，恢复进度已保存。`)
          return
        }
        checkpointRef.current = undefined
        onAnalysisCheckpoint(undefined)
        return
      }

      const attachments = []
      for (const file of attachmentFiles) attachments.push(await fileToAttachment(file))
      const result = await analyzeIntel(source, attachments, aiSettings, (nextProgress) => {
        const segmentLabel = nextProgress.totalSegmentsInConversation
          ? `“${nextProgress.currentConversation ?? '当前会话'}”第 ${nextProgress.currentSegment}/${nextProgress.totalSegmentsInConversation} 段`
          : `“${nextProgress.currentConversation ?? '当前会话'}”`
        const progressMessage = nextProgress.retryAttempt
          ? `${segmentLabel} 服务异常，${nextProgress.retryDelayMs ? `${(nextProgress.retryDelayMs / 1000).toFixed(1)} 秒后` : '立即'}进行第 ${nextProgress.retryAttempt}/${nextProgress.retryTotal} 次自动重连。`
          : `任务总进度：${nextProgress.completedConversations ?? 0}/${nextProgress.totalConversations ?? selectedConversationCount} 个对话；片段 ${nextProgress.completed}/${nextProgress.total}。${automatic ? '增量消息附带少量前序上下文' : '完整会话按时间覆盖上传，未做消息抽样'}。当前 ${segmentLabel}${nextProgress.historicalSegment ? '（历史信息段）' : ''}；得到 ${nextProgress.candidates} 个候选。`
        setProgress(nextProgress)
        persistCompletedConversation(nextProgress)
        setMessage(progressMessage)
        onAnalysisWorkChange({ stage: 'tasks', completed: nextProgress.completed, total: nextProgress.total, completedConversations: nextProgress.completedConversations, totalConversations: nextProgress.totalConversations ?? selectedConversationCount, candidates: nextProgress.candidates, message: progressMessage })
      }, appendDebugLog, onDirectPeopleDetected, { signal: controller.signal, concurrency })
      const retryableFailures = result.failedConversations.filter((conversation) => conversation.retryable)
      setRetryConversationIds(retryableFailures.map((conversation) => conversation.id))
      const automaticCoreIds = new Set(automaticMatches.map((item) => item.id))
      const acceptedCandidates = automatic
        ? result.candidates.filter((candidate) => candidate.sourceIds.some((id) => automaticCoreIds.has(id)))
        : result.candidates
      const analyzedIds = automatic
        ? expandSuccessfulConversationIds(analysisItems, result.analyzedIds)
        : result.analyzedIds
      onAiAnalysis(acceptedCandidates, analyzedIds, aiSettings, {
        sourceMessageCount: source.length,
        conversationCount: result.plan.totalConversations,
        processedConversationCount: result.processedConversations,
        requestedConversationCount: result.plan.totalConversations,
      }, !result.cancelled && result.failedConversations.length === 0, timelineMode === 'last-chat')
      onCandidatesSelected(acceptedCandidates.map((candidate) => candidate.id))
      if (acceptedCandidates.length) onCandidatesAvailable()
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
      setMessage(progressSummary.join(' '))
      if (targets.people && !result.cancelled && result.failedConversations.length === 0) {
        const peopleCheckpoint = { ...checkpointRef.current!, stage: 'people' as const, completedConversationIds: [] }
        checkpointRef.current = peopleCheckpoint
        onAnalysisCheckpoint(peopleCheckpoint)
        const peopleResult = await onPeopleAnalysis(source, aiSettings, (nextProgress) => {
          const peopleMessage = `人物总进度：${nextProgress.completedConversations ?? 0}/${nextProgress.totalConversations ?? selectedConversationCount} 个对话；片段 ${nextProgress.completed}/${nextProgress.total}；已保留 ${nextProgress.candidates} 张人物卡。`
          setProgress(nextProgress)
          persistCompletedConversation(nextProgress)
          setMessage(peopleMessage)
        })
        if (!peopleResult.started) {
          setMessage(peopleResult.reason ?? '当前范围没有可提炼的人物。')
          checkpointRef.current = undefined
          onAnalysisCheckpoint(undefined)
        } else {
          const peopleAnalyzedIds = automatic
            ? expandSuccessfulConversationIds(analysisItems, peopleResult.analyzedIds ?? [])
            : peopleResult.analyzedIds ?? []
          onAnalysisWatermark(peopleAnalyzedIds, timelineMode === 'last-chat')
          if (peopleResult.failedConversationIds?.length) {
            setRetryConversationIds(peopleResult.failedConversationIds)
            setMessage(`任务提炼已完成，人物提炼保留了成功结果；${peopleResult.failedConversationIds.length} 个会话仍需重试。`)
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
      setMessage(failureMessage)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      busyRef.current = false
      setBusy(false)
      onBusyChange?.(false)
      onAnalysisWorkChange(null)
    }
  }, [aiSettings, analysisConversationCount, analysisConversationId, analysisMessages, analysisTargets, appendDebugLog, attachmentFiles, conversationFingerprints, conversationKinds, effectiveConcurrency, onAiAnalysis, onAnalysisCheckpoint, onAnalysisWatermark, onAnalysisWorkChange, onBusyChange, onCandidatesAvailable, onCandidatesSelected, onDirectPeopleDetected, onPeopleAnalysis, scope, timelineEnd, timelineMode, timelineStart])

  const stop = useCallback(() => {
    if (!busyRef.current) return
    const current = checkpointRef.current
    if (current) {
      const paused = { ...current, pausedAt: new Date().toISOString() }
      checkpointRef.current = paused
      onAnalysisCheckpoint(paused)
    }
    setMessage('正在停止本轮提炼；已完成片段的候选会自动进入待确认列表。')
    abortRef.current?.abort()
    onStopPeopleAnalysis()
  }, [onAnalysisCheckpoint, onStopPeopleAnalysis])

  const retry = useCallback(() => {
    const retryCheckpoint = checkpointForRetry(checkpointRef.current, retryConversationIds)
    if (retryCheckpoint) {
      void run(false, [], retryCheckpoint)
      return
    }
    void run(false, retryConversationIds)
  }, [retryConversationIds, run])

  useEffect(() => {
    const checkpoint = aiSettings.interruptedRun
    if (!checkpoint || !items.length || busyRef.current || resumePromptedRef.current === checkpoint.startedAt) return
    resumePromptedRef.current = checkpoint.startedAt
    const timer = window.setTimeout(() => {
      const shouldResume = window.confirm(`发现上次未完成的${checkpoint.stage === 'people' ? '人物' : '任务'}提炼（已完成 ${checkpoint.completedConversationIds.length}/${checkpoint.conversationIds.length} 个对话）。是否继续？`)
      if (shouldResume) void run(false, [], checkpoint)
      else setMessage('已保留上次未完成提炼；本次启动不再自动询问，下次启动仍可继续。')
    }, 180)
    return () => window.clearTimeout(timer)
  }, [aiSettings.interruptedRun, items.length, run])

  useEffect(() => {
    if (!aiSettings.autoEnabled) return
    const timer = window.setInterval(() => {
      const taskDue = isDue(aiSettings.lastRunAt, aiSettings.intervalHours)
      const peopleDue = isDue(aiSettings.lastPeopleFollowupAt, aiSettings.intervalHours)
      const due = analysisTargets.tasks && analysisTargets.people ? taskDue || peopleDue : analysisTargets.people ? peopleDue : taskDue
      if (aiStatus?.configured && !busyRef.current && (due || automaticWorkPending)) void run(true)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [aiSettings.autoEnabled, aiSettings.intervalHours, aiSettings.lastPeopleFollowupAt, aiSettings.lastRunAt, aiStatus?.configured, analysisTargets, automaticWorkPending, run])

  return {
    busy,
    progress,
    message,
    setMessage,
    retryConversationIds,
    run,
    stop,
    retry,
  }
}

function expandSuccessfulConversationIds(items: IntelItem[], analyzedIds: string[]) {
  const resultIds = new Set(analyzedIds)
  const successfulConversationIds = new Set(
    items.filter((item) => resultIds.has(item.id)).map(conversationKey),
  )
  items.forEach((item) => {
    if (successfulConversationIds.has(conversationKey(item))) resultIds.add(item.id)
  })
  return [...resultIds]
}

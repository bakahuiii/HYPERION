import { useMemo } from 'react'

import type { AiSettings, IntelItem } from '../types'
import { analysisConversationFingerprint, analysisConversationKey } from '../lib/analysisWatermark'
import { buildConversationTimeline, conversationKey, fullConversationRecords, withinLastChatRange, withinStrictTimeRange } from '../lib/intelConversationView'

export type AnalysisScope = 'unprocessed' | 'new' | 'all'
export type TimelineFilterMode = 'last-chat' | 'strict-window'

export interface AnalysisTargets {
  tasks: boolean
  people: boolean
  self: boolean
}

interface UseIntelAnalysisSelectionOptions {
  indexedItems: IntelItem[] | null
  aiSettings: AiSettings
  scope: AnalysisScope
  timelineMode: TimelineFilterMode
  timelineStart: string
  timelineEnd: string
  analysisConversationId: string
  analysisTargets: AnalysisTargets
}

export function useIntelAnalysisSelection({
  indexedItems,
  aiSettings,
  scope,
  timelineMode,
  timelineStart,
  timelineEnd,
  analysisConversationId,
  analysisTargets,
}: UseIntelAnalysisSelectionOptions) {
  const conversations = useMemo(() => indexedItems ? buildConversationTimeline(indexedItems) : [], [indexedItems])
  const conversationRecordsById = useMemo(() => new Map(conversations.map((conversation) => [conversation.id, conversation.records])), [conversations])
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
      // "All conversations" must mean all archived records, including
      // reviewed self-journal rows and manually confirmed AI imports. The
      // previous status-first check made the self pipeline look empty even
      // when its source counter was non-zero.
      if (scope === 'all') return true
      if (item.status !== 'new') return false
      if (scope === 'new') return true
      const conversationId = analysisConversationKey(item)
      const fingerprint = conversationFingerprints.get(conversationId)
      const taskWatermark = aiSettings.analysisWatermarks?.tasks?.[conversationId]
      const peopleWatermark = aiSettings.analysisWatermarks?.people?.[conversationId]
      if (!fingerprint) return true
      const taskNeedsAnalysis = taskWatermark !== fingerprint
      const peopleNeedsAnalysis = conversationKinds.get(conversationId) === 'direct' && peopleWatermark !== fingerprint
      if (analysisTargets.tasks && analysisTargets.people) return taskNeedsAnalysis || peopleNeedsAnalysis
      if (analysisTargets.people) return peopleNeedsAnalysis
      if (taskWatermark === fingerprint) return false
      return !item.aiAnalyzedAt
    }
    const scopeMatches = scope === 'all' ? indexedItems : indexedItems.filter(workflowNeedsAnalysis)
    if (timelineMode === 'strict-window') return scopeMatches.filter((item) => withinStrictTimeRange(item, timelineStart, timelineEnd))
    const timeConversationIds = new Set(filteredConversations.map((conversation) => conversation.id))
    const timeMatches = !timelineStart && !timelineEnd
      ? scopeMatches
      : scopeMatches.filter((item) => timeConversationIds.has(conversationKey(item)))
    return fullConversationRecords(indexedItems, timeMatches)
  }, [aiSettings.analysisWatermarks, analysisConversation, analysisConversationId, analysisTargets, conversationFingerprints, conversationKinds, filteredConversations, indexedItems, scope, timelineEnd, timelineMode, timelineStart])
  const analysisConversationCount = useMemo(() => new Set(analysisMessages.map(conversationKey)).size, [analysisMessages])
  const automaticPendingRecordCount = useMemo(() => (indexedItems ?? []).reduce((count, item) => {
    if (item.status !== 'new') return count
    const conversationId = analysisConversationKey(item)
    const fingerprint = conversationFingerprints.get(conversationId)
    if (!fingerprint) return count + 1
    const taskWatermark = aiSettings.analysisWatermarks?.tasks?.[conversationId]
    const records = conversationRecordsById.get(conversationId) ?? []
    const legacyTaskDone = !taskWatermark && records.length > 0 && records.every((record) => Boolean(record.aiAnalyzedAt))
    const taskNeedsAnalysis = taskWatermark !== fingerprint && !legacyTaskDone
    const peopleNeedsAnalysis = conversationKinds.get(conversationId) === 'direct' && aiSettings.analysisWatermarks?.people?.[conversationId] !== fingerprint
    const needsAnalysis = analysisTargets.tasks && analysisTargets.people
      ? taskNeedsAnalysis || peopleNeedsAnalysis
      : analysisTargets.people ? peopleNeedsAnalysis : taskNeedsAnalysis
    return needsAnalysis ? count + 1 : count
  }, 0), [aiSettings.analysisWatermarks, analysisTargets, conversationFingerprints, conversationKinds, conversationRecordsById, indexedItems])
  const automaticWorkPending = automaticPendingRecordCount > 0

  return { conversations, conversationFingerprints, conversationKinds, filteredConversations, analysisConversation, analysisMessages, analysisConversationCount, automaticWorkPending, automaticPendingRecordCount }
}

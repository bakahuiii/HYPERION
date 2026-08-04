import { useMemo } from 'react'

import type { AiSettings, IntelItem } from '../types'
import { analysisConversationFingerprint, analysisConversationKey } from '../lib/analysisWatermark'
import { buildConversationTimeline, conversationKey, fullConversationRecords, withinLastChatRange, withinStrictTimeRange } from '../lib/intelConversationView'

export type AnalysisScope = 'unprocessed' | 'new' | 'all'
export type TimelineFilterMode = 'last-chat' | 'strict-window'

export interface AnalysisTargets {
  tasks: boolean
  people: boolean
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
      if (scope === 'all') return true
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

  return { conversations, conversationFingerprints, conversationKinds, filteredConversations, analysisConversation, analysisMessages, analysisConversationCount, automaticWorkPending }
}

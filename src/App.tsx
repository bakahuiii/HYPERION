import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, CircleStop, Sparkles, X } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { QuestModal } from './components/QuestModal'
import { QuestSourceModal } from './components/QuestSourceModal'
import { AppearanceModal } from './components/AppearanceModal'
import { TaskMapView, type TaskAtlasArrangement } from './views/TaskMapView'
import { IntelView, type AnalysisWorkState } from './views/IntelView'
import { loadData, resetData, saveData } from './lib/storage'
import { normalizeAppearance } from './lib/appearance'
import { loadIntelSnapshot, loadSharedIntelMeta, loadSharedIntelSnapshot, saveIntelSnapshot, saveSharedIntelSnapshot } from './lib/intelStore'
import { shouldLoadSharedIntelSnapshot } from './lib/intelSnapshotSelection'
import { createSeedData } from './seed'
import type { AiExtractionCheckpoint, AiFeedbackReason, AiSettings, AiTaskCandidate, AiTaskFeedback, AppData, ArchiveAnalysisSummary, AppearanceSettings, IntelItem, Person, PersonEvidence, Place, Profile, Quest, TaskAtlasCategory, TaskAtlasPosition, ViewId } from './types'
import { loadBackgroundAsset } from './lib/appearanceAssets'
import { sourceProvider } from './lib/people'
import { analyzePeople, buildDirectConversationFallbackPeople, candidateRejectionReason, consolidatePerson, generateTaskGuidance, getAiStatus, type AiDebugEntry, type AiProgress } from './lib/aiClient'
import { loadSharedMeta, loadSharedSnapshot, saveSharedSnapshot, SharedSnapshotConflictError } from './lib/sharedSync'
import { mergeSharedChanges, toSharedData, type SharedData } from './lib/sharedStateMerge'
import { loadSharedSettings, saveSharedSettings, waitForSharedSettingsWrites } from './lib/settingsClient'
import { editableSettingsSignature } from './lib/settingsState'
import { mapSearchPrecision, mapSearchRadius, searchMapPlaces } from './lib/mapSearch'
import { archiveSummaryWithAnalysis, archiveSummaryWithImport, summarizeArchive } from './lib/archiveSummary'
import { fetchTaskWeather } from './lib/weather'
import { avatarImageUrl } from './lib/mediaProxy'
import { normalizeAiConcurrency } from './lib/aiConcurrency'
import { inferConversationKind } from './lib/conversationAnalysis'
import { filterDismissedPeople, removePeopleCards, resolvePersonDismissals } from './lib/peopleState'
import { removeQuestAndDetachChildren } from './lib/questState'
import { taskGuidanceRequestIsCurrent, taskGuidanceSignature } from './lib/questGuidance'
import { completedConversationWatermarks } from './lib/analysisWatermark'

const TimelineView = lazy(() => import('./views/TimelineView').then((module) => ({ default: module.TimelineView })))
const MapView = lazy(() => import('./views/MapView').then((module) => ({ default: module.MapView })))
const PeopleView = lazy(() => import('./views/PeopleView').then((module) => ({ default: module.PeopleView })))
const OptionsView = lazy(() => import('./views/OptionsView').then((module) => ({ default: module.OptionsView })))

function sourceDetails(items: IntelItem[]) {
  return {
    platforms: [...new Set(items.map((item) => item.source))],
    providers: [...new Set(items.map(sourceProvider).filter((provider): provider is string => Boolean(provider)))],
  }
}

function stableId(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function placeCategoryForCandidate(candidate: AiTaskCandidate): Place['category'] {
  const text = `${candidate.title} ${candidate.description} ${candidate.tags.join(' ')}`
  if (/学校|校园|课程|开学|返校|考试|学习|提交/.test(text)) return 'study'
  if (/医院|健康|训练|锻炼|运动|恢复/.test(text)) return 'health'
  if (/见面|约会|朋友|聚会|喝酒|吃饭|咖啡/.test(text)) return 'social'
  return 'explore'
}

function feedbackEntry(candidate: AiTaskCandidate, decision: AiTaskFeedback['decision'], reason: AiFeedbackReason): AiTaskFeedback {
  return {
    id: `feedback-${candidate.id}`,
    title: candidate.title,
    description: candidate.description,
    decision,
    reason,
    sourceCapturedAt: candidate.sourceCapturedAt,
    createdAt: new Date().toISOString(),
  }
}

function appendTaskFeedback(settings: AiSettings, additions: AiTaskFeedback[]) {
  if (!additions.length) return settings
  const replaced = new Set(additions.map((item) => item.id))
  return { ...settings, feedback: [...(settings.feedback ?? []).filter((item) => !replaced.has(item.id)), ...additions].slice(-80) }
}

function cleanDanglingPersonReferences(current: AppData): AppData {
  const peopleIds = new Set(current.people.map((person) => person.id))
  let changed = false
  const quests = current.quests.map((quest) => {
    const existingIds = Array.isArray(quest.characterIds) ? quest.characterIds : []
    const characterIds = existingIds.filter((personId) => peopleIds.has(personId))
    if (Array.isArray(quest.characterIds) && characterIds.length === existingIds.length) return quest
    changed = true
    return { ...quest, characterIds }
  })
  return changed ? { ...current, quests } : current
}

interface IntelImportResult {
  added: number
  updated: number
  duplicates: number
  archiveMessageCount: number
  conversationCount: number
}

function dismissInvalidAiCandidates(current: AppData, indexedIntel?: ReadonlyMap<string, IntelItem>) {
  const cleaned = cleanDanglingPersonReferences(current)
  // A generated candidate is only a temporary review artifact. The task
  // already stores its evidence, so retaining this duplicate grows the local
  // snapshot and makes the Intel view misleading after confirmation.
  const withoutGeneratedArchive = cleaned.aiCandidates.filter((candidate) => candidate.status !== 'created')
  const compacted = withoutGeneratedArchive.length === cleaned.aiCandidates.length
    ? cleaned
    : { ...cleaned, aiCandidates: withoutGeneratedArchive }
  const pending = compacted.aiCandidates.filter((candidate) => candidate.status === 'pending')
  if (!pending.length) return compacted
  const recordsById = indexedIntel ?? new Map(cleaned.intel.map((item) => [item.id, item]))
  const dismissed = pending.flatMap((candidate) => {
    const evidence = candidate.sourceIds.map((id) => recordsById.get(id)).filter((item): item is IntelItem => Boolean(item))
    const reason = candidateRejectionReason(candidate, evidence, cleaned.aiSettings)
    return reason ? [{ candidate, reason }] : []
  })
  if (!dismissed.length) return compacted
  const dismissedIds = new Set(dismissed.map(({ candidate }) => candidate.id))
  return {
    ...compacted,
    aiCandidates: compacted.aiCandidates.map((candidate) => dismissedIds.has(candidate.id) ? { ...candidate, status: 'dismissed' as const } : candidate),
    aiSettings: appendTaskFeedback(compacted.aiSettings, dismissed.map(({ candidate, reason }) => feedbackEntry(candidate, 'dismissed', reason))),
  }
}

function restoreQuestEvidence(quests: Quest[], candidates: AiTaskCandidate[]) {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  let changed = false
  const restored = quests.map((quest) => {
    if (!quest.id.startsWith('q-ai-')) return quest
    const candidate = candidatesById.get(quest.id.slice(5))
    const sourceIds = quest.sourceIds?.length ? quest.sourceIds : candidate?.sourceIds
    if (!sourceIds?.length) return quest
    const sourceCapturedAt = quest.sourceCapturedAt ?? candidate?.sourceCapturedAt ?? candidate?.createdAt
    if (quest.sourceIds?.length && quest.sourceCapturedAt === sourceCapturedAt) return quest
    changed = true
    return { ...quest, sourceIds, sourceCapturedAt }
  })
  return changed ? restored : quests
}

function enrichQuestCharacters(quests: Quest[], candidates: AiTaskCandidate[], people: Person[], itemsById: ReadonlyMap<string, IntelItem>) {
  if (!people.length) return quests
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const peopleByName = new Map<string, Person[]>()
  const peopleByConversation = new Map<string, Person[]>()
  people.forEach((person) => {
    const name = canonicalPersonName(person.name)
    peopleByName.set(name, [...peopleByName.get(name) ?? [], person])
    person.conversationIds?.forEach((conversationId) => {
      peopleByConversation.set(conversationId, [...peopleByConversation.get(conversationId) ?? [], person])
    })
  })

  let changed = false
  const enriched = quests.map((quest) => {
    const linked = new Set(quest.characterIds)
    const candidate = quest.id.startsWith('q-ai-') ? candidatesById.get(quest.id.slice(5)) : undefined
    const evidence = quest.sourceIds?.map((id) => itemsById.get(id)).filter((item): item is IntelItem => Boolean(item)) ?? []
    const names = new Set([
      ...(candidate?.people ?? []),
      ...evidence.filter((item) => item.speakerRole === 'other' && item.speaker?.trim()).map((item) => item.speaker!.trim()),
    ].map(canonicalPersonName))
    names.forEach((name) => peopleByName.get(name)?.forEach((person) => linked.add(person.id)))
    evidence.filter((item) => inferConversationKind(item) === 'direct' && item.conversationId).forEach((item) => {
      peopleByConversation.get(item.conversationId!)?.forEach((person) => linked.add(person.id))
    })
    const characterIds = [...linked]
    if (characterIds.length === quest.characterIds.length && characterIds.every((id, index) => id === quest.characterIds[index])) return quest
    changed = true
    return { ...quest, characterIds }
  })
  return changed ? enriched : quests
}

function backgroundCss(url?: string) {
  return url ? `url(${JSON.stringify(url)})` : 'none'
}

function capturedAtTime(value: string | undefined) {
  const time = value ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(time) ? time : Number.NaN
}

function earliestObserved(values: Array<string | undefined>) {
  const known = values.filter((value): value is string => Boolean(value))
  return known.sort((left, right) => {
    const leftTime = capturedAtTime(left)
    const rightTime = capturedAtTime(right)
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
    return left.localeCompare(right)
  })[0]
}

function latestObserved(values: Array<string | undefined>) {
  const known = values.filter((value): value is string => Boolean(value))
  return known.sort((left, right) => {
    const leftTime = capturedAtTime(left)
    const rightTime = capturedAtTime(right)
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime
    return right.localeCompare(left)
  })[0]
}

function canonicalPersonName(name: string) {
  return name.replace(/\s+/g, '').toLocaleLowerCase()
}

function personEvidenceKey(claim: PersonEvidence) {
  const compact = (value: string) => value.replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
  return `${claim.kind}|${compact(claim.text)}|${compact(claim.quote)}`
}

function personProfileSignalScore(claim: PersonEvidence) {
  const compact = `${claim.text} ${claim.quote}`.replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
  let score = claim.kind === 'preference' ? 7 : 2
  if (claim.evidenceStrength === 'repeated') score += 5
  if (/(?:喜欢|不喜欢|想要|想去|爱吃|感兴趣|习惯|常去|希望|讨厌|擅长|在意|计划|准备)/.test(compact)) score += 3
  if (claim.quote.trim().length >= 8) score += 1
  if (/^(?:好|嗯|哦|哈哈|行|可以|知道了|收到)[!！。.]?$/.test(claim.quote.trim())) score -= 6
  return score
}

function mergePersonEvidence(current: PersonEvidence[] = [], incoming: PersonEvidence[] = []) {
  const claims = new Map<string, PersonEvidence>()
  for (const claim of [...current, ...incoming]) {
    if (!claim.text?.trim() || !claim.quote?.trim() || !claim.sourceIds?.length) continue
    const key = personEvidenceKey(claim)
    const existing = claims.get(key)
    if (!existing) {
      claims.set(key, { ...claim, sourceIds: [...new Set(claim.sourceIds)].slice(0, 12) })
      continue
    }
    const sourceIds = [...new Set([...existing.sourceIds, ...claim.sourceIds])].slice(0, 12)
    claims.set(key, {
      ...existing,
      sourceIds,
      evidenceStrength: sourceIds.length >= 2 ? 'repeated' : 'single',
      firstObservedAt: earliestObserved([existing.firstObservedAt, claim.firstObservedAt]),
      lastObservedAt: latestObserved([existing.lastObservedAt, claim.lastObservedAt]),
    })
  }
  const ordered = [...claims.values()].sort((left, right) => {
    const leftTime = new Date(left.lastObservedAt ?? left.firstObservedAt ?? '').getTime()
    const rightTime = new Date(right.lastObservedAt ?? right.firstObservedAt ?? '').getTime()
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
    return personEvidenceKey(left).localeCompare(personEvidenceKey(right))
  })
  if (ordered.length <= 240) return ordered
  const selected = new Set<number>()
  for (let index = 0; index < 36; index += 1) selected.add(index)
  for (let index = Math.max(36, ordered.length - 36); index < ordered.length; index += 1) selected.add(index)
  const highSignal = ordered
    .map((claim, index) => ({ index, score: personProfileSignalScore(claim) }))
    .filter((entry) => entry.score >= 5)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  for (const { index } of highSignal) {
    if (selected.size >= 168) break
    selected.add(index)
  }
  const middle = ordered.map((_, index) => index).filter((index) => !selected.has(index))
  for (let slot = 0; selected.size < 240 && middle.length; slot += 1) {
    selected.add(middle[Math.min(middle.length - 1, Math.floor((slot + 0.5) * middle.length / Math.max(1, 240 - 72)))])
  }
  return [...selected].sort((left, right) => left - right).map((index) => ordered[index])
}

function notesFromPersonEvidence(evidence: PersonEvidence[], kind: PersonEvidence['kind'], limit: number) {
  return [...new Set(evidence.filter((claim) => claim.kind === kind).map((claim) => claim.text.trim()).filter(Boolean))].slice(0, limit)
}

function portraitEvidenceSignature(person: Person) {
  const evidence = person.evidence ?? []
  const profileNotes = person.profileNotes?.trim() ?? ''
  if (!evidence.length && !profileNotes) return ''
  return stableId(JSON.stringify({
    evidence: evidence.map((claim) => [
      claim.kind,
      claim.text,
      claim.quote,
      [...claim.sourceIds].sort(),
      claim.category ?? null,
      claim.stability ?? null,
      claim.importanceScore ?? null,
      claim.portraitEligible !== false,
      claim.origin ?? null,
      claim.evidenceStrength,
      claim.firstObservedAt ?? null,
      claim.lastObservedAt ?? null,
    ]),
    profileNotes,
  }))
}

function isLocalExportVerifiedPerson(person: Person) {
  return person.model.includes('local-export-verified') || person.model.includes('\u5bfc\u51fa\u8bb0\u5f55\u6838\u9a8c')
}

const PERSON_FACT_BUFFER_LIMIT = 48
const PERSON_CONSOLIDATION_MAX_CONCURRENT = 4
const TASK_GUIDANCE_REFRESH_INTERVAL_MS = 10 * 60 * 1000
// Version 5 separates a deliberate card deletion from the old bulk-clear
// implementation. The suppression is used only for passive local fallback
// cards; explicit model extraction always removes it and can recreate a card.
const PEOPLE_DISMISSAL_SEMANTICS_VERSION = 5

function enrichPeopleEvidence(people: Person[], items: IntelItem[]) {
  const itemsById = new Map(items.map((item) => [item.id, item]))
  const avatarByName = new Map<string, string>()
  const avatarByConversation = new Map<string, string>()
  items.forEach((item) => {
    if (!item.avatarUrl) return
    if (item.speaker?.trim()) avatarByName.set(canonicalPersonName(item.speaker), item.avatarUrl)
    if (inferConversationKind(item) === 'direct' && item.conversationId && !avatarByConversation.has(item.conversationId)) avatarByConversation.set(item.conversationId, item.avatarUrl)
  })
  let changed = false
  const enriched = people.map((person) => {
    const evidence = person.sourceIds.map((id) => itemsById.get(id)).filter((item): item is IntelItem => Boolean(item))
    if (!evidence.length) return person
    const conversationIds = [...new Set([...person.conversationIds ?? [], ...evidence.map((item) => item.conversationId).filter((id): id is string => Boolean(id))])]
    const firstObservedAt = person.firstObservedAt ?? earliestObserved(evidence.map((item) => item.capturedAt))
    const lastObservedAt = person.lastObservedAt ?? latestObserved(evidence.map((item) => item.capturedAt))
    const avatarUrl = avatarByName.get(canonicalPersonName(person.name))
      ?? person.conversationIds?.map((id) => avatarByConversation.get(id)).find((url): url is string => Boolean(url))
      ?? person.avatarUrl
    if (firstObservedAt === person.firstObservedAt && lastObservedAt === person.lastObservedAt && avatarUrl === person.avatarUrl && conversationIds.length === (person.conversationIds?.length ?? 0)) return person
    changed = true
    return { ...person, avatarUrl, firstObservedAt, lastObservedAt, conversationIds }
  })
  return changed ? enriched : people
}

function mergePeople(current: AppData, additions: Person[], options: { restoreDismissedConversations?: boolean } = {}) {
  const visiblePeople = filterDismissedPeople(current.people, current.dismissedPersonConversationIds ?? [])
  const workingCurrent = visiblePeople.length === current.people.length
    ? current
    : { ...current, people: visiblePeople }
  const resolved = resolvePersonDismissals(
    additions,
    workingCurrent.dismissedPersonConversationIds ?? [],
    options.restoreDismissedConversations === true,
  )
  const restoredConversationIds = new Set(resolved.restoredConversationIds)
  const allowedAdditions = resolved.additions
  if (!allowedAdditions.length) return workingCurrent
  const people = [...workingCurrent.people]
  let changed = false
  for (const incoming of allowedAdditions) {
    const incomingConversationIds = new Set(incoming.conversationIds ?? [])
    const index = people.findIndex((existing) => {
      if (canonicalPersonName(existing.name) !== canonicalPersonName(incoming.name)) return false
      const sourceOverlap = existing.sourceIds.some((id) => incoming.sourceIds.includes(id))
      const conversationOverlap = (existing.conversationIds ?? []).some((id) => incomingConversationIds.has(id))
      return sourceOverlap || conversationOverlap
    })
    if (index < 0) {
      people.push(incoming)
      changed = true
      continue
    }
    const existing = people[index]
    const evidence = mergePersonEvidence(existing.evidence, incoming.evidence)
    const hasModelEvidence = evidence.length > 0
    // Reprocessing the same conversation should be idempotent. Looking only
    // at whether the incoming payload contains claims would clear a ready
    // portrait on every retry, even when no new evidence was added.
    const evidenceChanged = JSON.stringify(existing.evidence ?? []) !== JSON.stringify(evidence)
    const merged: Person = {
      ...existing,
      avatarUrl: incoming.avatarUrl ?? existing.avatarUrl,
      // Once the evidence pass has contributed claims, old summary strings no
      // longer drive the card. The final profile is rebuilt only from quotes.
      facts: hasModelEvidence
        ? notesFromPersonEvidence(evidence, 'fact', PERSON_FACT_BUFFER_LIMIT)
        : [...new Set([...existing.facts, ...incoming.facts])].slice(0, PERSON_FACT_BUFFER_LIMIT),
      preferences: hasModelEvidence
        ? notesFromPersonEvidence(evidence, 'preference', 24)
        : [...new Set([...(existing.preferences ?? []), ...(incoming.preferences ?? [])])].slice(0, 18),
      evidence: hasModelEvidence ? evidence : existing.evidence ?? incoming.evidence,
      advice: evidenceChanged ? [] : [...new Set([...(existing.advice ?? []), ...(incoming.advice ?? [])])].slice(0, 9),
      sourceIds: [...new Set([...existing.sourceIds, ...incoming.sourceIds, ...evidence.flatMap((claim) => claim.sourceIds)])].slice(0, 120),
      conversationIds: [...new Set([...(existing.conversationIds ?? []), ...(incoming.conversationIds ?? [])])].slice(0, 30),
      firstObservedAt: earliestObserved([existing.firstObservedAt, incoming.firstObservedAt]),
      lastObservedAt: latestObserved([existing.lastObservedAt, incoming.lastObservedAt]),
      portrait: evidenceChanged ? undefined : incoming.portrait ?? existing.portrait,
      portraitBlocks: evidenceChanged ? undefined : incoming.portraitBlocks ?? existing.portraitBlocks,
      portraitCoverage: evidenceChanged ? undefined : incoming.portraitCoverage ?? existing.portraitCoverage,
      portraitSchemaVersion: evidenceChanged ? undefined : incoming.portraitSchemaVersion ?? existing.portraitSchemaVersion,
      portraitSourceIds: evidenceChanged ? undefined : incoming.portraitSourceIds ?? existing.portraitSourceIds,
      profileNotesUsed: evidenceChanged ? undefined : incoming.profileNotesUsed ?? existing.profileNotesUsed,
      portraitEvidenceSignature: evidenceChanged ? undefined : existing.portraitEvidenceSignature,
      portraitStatus: evidenceChanged ? 'processing' : incoming.portraitStatus ?? existing.portraitStatus,
      portraitFailure: evidenceChanged ? undefined : incoming.portraitFailure ?? existing.portraitFailure,
      portraitRetryCount: evidenceChanged ? 0 : Math.max(existing.portraitRetryCount ?? 0, incoming.portraitRetryCount ?? 0),
      platforms: [...new Set([...existing.platforms, ...incoming.platforms])],
      // A local folder-verified card is deliberately created before lengthy
      // model work. Do not overwrite a richer model result with that label.
      model: isLocalExportVerifiedPerson(existing) && !isLocalExportVerifiedPerson(incoming)
        ? incoming.model
        : existing.model,
    }
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      people[index] = merged
      changed = true
    }
  }
  if (!changed && !restoredConversationIds.size) return workingCurrent
  return {
    ...workingCurrent,
    people,
    // A model result is an explicit request to recreate the card. Remove only
    // the matching suppression entries; unrelated deleted cards stay hidden
    // from passive fallback imports until they are explicitly re-extracted.
    dismissedPersonConversationIds: restoredConversationIds.size
      ? workingCurrent.dismissedPersonConversationIds.filter((id) => !restoredConversationIds.has(id))
      : workingCurrent.dismissedPersonConversationIds,
  }
}

function App() {
  const [data, setData] = useState<AppData>(() => cleanDanglingPersonReferences(loadData()))
  const [intelHydrated, setIntelHydrated] = useState(false)
  const [archiveLoadError, setArchiveLoadError] = useState('')
  const [syncErrors, setSyncErrors] = useState<{ shared?: string; settings?: string }>({})
  const [view, setView] = useState<ViewId>('quests')
  const [selectedPlaceId, setSelectedPlaceId] = useState(data.places[0]?.id ?? '')
  const [selectedPersonId, setSelectedPersonId] = useState(data.people[0]?.id ?? '')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [questModalOpen, setQuestModalOpen] = useState(false)
  const [editingQuest, setEditingQuest] = useState<Quest | undefined>()
  const [sourceQuest, setSourceQuest] = useState<Quest | undefined>()
  const [appearanceModalOpen, setAppearanceModalOpen] = useState(false)
  const [analysisWork, setAnalysisWork] = useState<AnalysisWorkState | null>(null)
  const [backgroundUrls, setBackgroundUrls] = useState<Record<string, string>>({})
  const [appearancePreview, setAppearancePreview] = useState<{ profile: Profile; appearance: AppearanceSettings } | null>(null)
  const [sharedReady, setSharedReady] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef(data)
  const sharedReadyRef = useRef(false)
  const sharedUpdatedAtRef = useRef('')
  const sharedBaseDataRef = useRef<SharedData>(toSharedData(data))
  const sharedSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const skipSharedWriteRef = useRef(false)
  const sharedWriteTimerRef = useRef<number | undefined>(undefined)
  const sharedIntelWriteTimerRef = useRef<number | undefined>(undefined)
  const lastSharedIntelWriteKeyRef = useRef('')
  const pendingSharedIntelWriteKeyRef = useRef('')
  const skipInitialLocalIntelPersistRef = useRef(false)
  const skipInitialSharedIntelPersistRef = useRef(false)
  const hasAuthoritativeIntelSnapshotRef = useRef(false)
  const initialLocalIntelUpdatedAtRef = useRef<string | undefined>(undefined)
  const sharedIntelUpdatedAtRef = useRef<string | null>(null)
  const settingsReadyRef = useRef(false)
  const settingsWriteTimerRef = useRef<number | undefined>(undefined)
  const flushInFlightRef = useRef<Promise<void> | null>(null)
  const checkpointWriteTimerRef = useRef<number | undefined>(undefined)
  const pendingCheckpointRef = useRef<AiExtractionCheckpoint | undefined>(data.aiSettings.interruptedRun)
  const pendingPersonConsolidationsRef = useRef(new Set<string>())
  const personConsolidationControllersRef = useRef(new Map<string, AbortController>())
  const personConsolidationRetriesRef = useRef(new Map<string, number>())
  const completedPersonConsolidationSignaturesRef = useRef(new Map<string, string>())
  const peopleConsolidationPausedRef = useRef(false)
  const peopleAnalysisAbortRef = useRef<AbortController | null>(null)
  const peopleDismissalMigrationRef = useRef(false)
  const prefetchedAvatarUrlsRef = useRef(new Set<string>())
  const taskGuidanceBootstrapRef = useRef(false)
  const taskGuidanceInFlightRef = useRef(new Set<string>())
  const taskGuidanceControllersRef = useRef(new Map<string, { controller: AbortController; signature: string }>())
  const [taskGuidanceRefreshTick, setTaskGuidanceRefreshTick] = useState(0)
  const effectiveProfile = appearancePreview?.profile ?? data.profile
  const effectiveAppearance = normalizeAppearance(appearancePreview?.appearance ?? data.appearance)
  const regularSettingsSignature = useMemo(() => editableSettingsSignature({
    profile: data.profile,
    appearance: data.appearance,
    aiSettings: data.aiSettings,
  }), [data.aiSettings, data.appearance, data.profile])
  const sharedIntelWriteKey = `${data.archive.sourceFingerprint ?? 'adhoc'}\u0000${data.archive.lastImport?.importedAt ?? 'initial'}\u0000${data.intel.length}\u0000${data.intel[0]?.id ?? ''}\u0000${data.intel.at(-1)?.id ?? ''}`
  const effectiveSelectedPlaceId = data.places.some((place) => place.id === selectedPlaceId)
    ? selectedPlaceId
    : data.places[0]?.id ?? ''

  const appendPeopleDebug = (entry: AiDebugEntry) => {
    window.dispatchEvent(new CustomEvent<AiDebugEntry>('theia:ai-debug', { detail: entry }))
  }

  const persistSharedSnapshot = useCallback((snapshot: AppData) => {
    const localAtEnqueue = toSharedData(snapshot)
    const operation = sharedSaveQueueRef.current.then(async () => {
      let outgoing = localAtEnqueue
      let mergeBase = sharedBaseDataRef.current
      let mergedConflict = false
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const saved = await saveSharedSnapshot(outgoing, sharedUpdatedAtRef.current || null)
          sharedUpdatedAtRef.current = saved.updatedAt ?? ''
          sharedBaseDataRef.current = outgoing
          if (mergedConflict) {
            // Preserve edits made after this write was queued while bringing
            // independent remote changes into the current renderer.
            setData((current) => {
              const reconciled = mergeSharedChanges(localAtEnqueue, toSharedData(current), outgoing)
              return cleanDanglingPersonReferences({ ...current, ...reconciled, intel: current.intel, peopleModelVersion: 5 })
            })
          }
          return saved
        } catch (error) {
          if (!(error instanceof SharedSnapshotConflictError)) throw error
          const remote = await loadSharedSnapshot()
          sharedUpdatedAtRef.current = remote.updatedAt ?? ''
          if (!remote.data) continue
          outgoing = mergeSharedChanges(mergeBase, outgoing, remote.data)
          mergeBase = remote.data
          mergedConflict = true
        }
      }
      throw new Error('共享数据连续发生写入冲突，请稍后重试')
    })
    const visibleOperation = operation.then((saved) => {
      setSyncErrors((current) => current.shared ? { ...current, shared: undefined } : current)
      return saved
    }, (error) => {
      setSyncErrors((current) => ({ ...current, shared: `任务、人物与地点的共享状态保存失败：${error instanceof Error ? error.message : String(error)}` }))
      throw error
    })
    sharedSaveQueueRef.current = visibleOperation.then(() => undefined, () => undefined)
    return visibleOperation
  }, [])
  const visualMotion = effectiveAppearance.performanceVersion === 1 && effectiveAppearance.motionEnabled
  const referencedIntelIds = useMemo(() => new Set([
    ...data.quests.flatMap((quest) => quest.sourceIds ?? []),
    ...data.aiCandidates.flatMap((candidate) => candidate.sourceIds),
  ]), [data.aiCandidates, data.quests])
  const intelById = useMemo(() => {
    if (!referencedIntelIds.size) return new Map<string, IntelItem>()
    const indexed = new Map<string, IntelItem>()
    for (const item of data.intel) {
      if (referencedIntelIds.has(item.id)) indexed.set(item.id, item)
    }
    return indexed
  }, [data.intel, referencedIntelIds])
  const restoredQuests = useMemo(() => restoreQuestEvidence(data.quests, data.aiCandidates), [data.aiCandidates, data.quests])
  const questsWithEvidence = useMemo(() => enrichQuestCharacters(restoredQuests, data.aiCandidates, data.people, intelById), [data.aiCandidates, data.people, intelById, restoredQuests])
  const newIntelCount = useMemo(() => data.intel.reduce((count, item) => count + (item.status === 'new' ? 1 : 0), 0), [data.intel])

  useEffect(() => {
    dataRef.current = data
    saveData(data)
  }, [data])

  useEffect(() => {
    // Starting an image request through the local proxy downloads and caches a
    // newly discovered session avatar before the person view is opened.
    data.people.forEach((person) => {
      const source = avatarImageUrl(person.avatarUrl)
      if (!source || prefetchedAvatarUrlsRef.current.has(source)) return
      prefetchedAvatarUrlsRef.current.add(source)
      const image = new Image()
      image.decoding = 'async'
      image.src = source
    })
  }, [data.people])

  useEffect(() => {
    let active = true
    const initialSignature = editableSettingsSignature({
      profile: dataRef.current.profile,
      appearance: dataRef.current.appearance,
      aiSettings: dataRef.current.aiSettings,
    })
    void loadSharedSettings().then((settings) => {
      if (!active) return
      const currentSignature = editableSettingsSignature({
        profile: dataRef.current.profile,
        appearance: dataRef.current.appearance,
        aiSettings: dataRef.current.aiSettings,
      })
      if (settings.initialized && currentSignature === initialSignature) {
        setSyncErrors((current) => current.settings ? { ...current, settings: undefined } : current)
        setData((current) => ({
          ...current,
          profile: settings.profile,
          appearance: settings.appearance,
          aiSettings: settings.aiSettings,
        }))
      } else {
        // The settings write effect runs once readiness becomes observable.
        // Reading dataRef there preserves edits made while this request was in
        // flight instead of seeding the INI from the mount-time snapshot.
        setSyncErrors((current) => current.settings ? { ...current, settings: undefined } : current)
      }
    }).catch((error) => {
      // The browser cache remains usable when the optional local proxy is offline.
      if (active) setSyncErrors((current) => ({ ...current, settings: `通用设置读取失败：${error instanceof Error ? error.message : String(error)}` }))
    }).finally(() => {
      if (!active) return
      settingsReadyRef.current = true
      setSettingsReady(true)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!settingsReady) return
    if (settingsWriteTimerRef.current) window.clearTimeout(settingsWriteTimerRef.current)
    settingsWriteTimerRef.current = window.setTimeout(() => {
      const current = dataRef.current
      void saveSharedSettings({ profile: current.profile, appearance: current.appearance, aiSettings: current.aiSettings })
        .then(() => setSyncErrors((errors) => errors.settings ? { ...errors, settings: undefined } : errors))
        .catch((error) => setSyncErrors((errors) => ({ ...errors, settings: `通用设置保存失败：${error instanceof Error ? error.message : String(error)}` })))
    }, 350)
    return () => { if (settingsWriteTimerRef.current) window.clearTimeout(settingsWriteTimerRef.current) }
  }, [regularSettingsSignature, settingsReady])

  // Older builds used the same field for bulk clear and individual deletion.
  // Clear that legacy state once; new deletions are recreated by explicit
  // model extraction through mergeIncomingPeople.
  useEffect(() => {
    if (!intelHydrated || peopleDismissalMigrationRef.current || data.peopleDismissalVersion === PEOPLE_DISMISSAL_SEMANTICS_VERSION) return
    peopleDismissalMigrationRef.current = true
    if (data.dismissedPersonConversationIds.length) {
      appendPeopleDebug({
        at: new Date().toISOString(),
        event: 'people_legacy_dismissals_cleared',
        level: 'warn',
        recordCount: data.intel.length,
        candidateCount: data.dismissedPersonConversationIds.length,
        message: `已清理 ${data.dismissedPersonConversationIds.length} 条旧版人物屏蔽记录；明确提炼时可以重新建立人物卡。`,
      })
    }
    setData((current) => ({
      ...current,
      dismissedPersonConversationIds: [],
      peopleDismissalVersion: PEOPLE_DISMISSAL_SEMANTICS_VERSION,
    }))
  }, [data.dismissedPersonConversationIds, data.intel.length, data.peopleDismissalVersion, intelHydrated])

  useEffect(() => {
    let active = true
    void (async () => {
      let localSnapshot: Awaited<ReturnType<typeof loadIntelSnapshot>> = null
      let hydrationError = ''
      try {
        localSnapshot = await loadIntelSnapshot()
      } catch (error) {
        hydrationError = `浏览器原始聊天缓存读取失败：${error instanceof Error ? error.message : String(error)}`
      }
      let snapshot = localSnapshot?.items ?? []
      let sourceFingerprint = localSnapshot?.sourceFingerprint ?? null
      let selectedFromShared = false
      let snapshotAvailable = Boolean(localSnapshot)
      // Do not download a large archive when the current profile already has
      // the freshest local copy. The small metadata request lets browser and
      // desktop pick up a newer archive from the loopback shared store.
      let sharedMeta: Awaited<ReturnType<typeof loadSharedIntelMeta>> | null = null
      try {
        sharedMeta = await loadSharedIntelMeta()
      } catch (error) {
        if (!localSnapshot) hydrationError = `本机原始聊天归档状态读取失败：${error instanceof Error ? error.message : String(error)}`
      }
      sharedIntelUpdatedAtRef.current = sharedMeta?.updatedAt ?? null
      const expectedFingerprint = dataRef.current.archive.sourceFingerprint ?? null
      const shouldLoadShared = shouldLoadSharedIntelSnapshot(expectedFingerprint, localSnapshot, sharedMeta)
      if (shouldLoadShared) {
        let sharedSnapshot: Awaited<ReturnType<typeof loadSharedIntelSnapshot>> | null = null
        try {
          sharedSnapshot = await loadSharedIntelSnapshot()
        } catch (error) {
          hydrationError = `本机原始聊天归档读取失败：${error instanceof Error ? error.message : String(error)}`
        }
        if (sharedSnapshot?.updatedAt) {
          snapshot = sharedSnapshot.items
          sourceFingerprint = sharedSnapshot.sourceFingerprint
          sharedIntelUpdatedAtRef.current = sharedSnapshot.updatedAt
          selectedFromShared = true
          snapshotAvailable = true
        }
      }
      const storesAlreadyMatch = Boolean(localSnapshot
        && sharedMeta?.recordCount === localSnapshot.items.length
        && sharedMeta.sourceFingerprint === localSnapshot.sourceFingerprint
        && sharedMeta.updatedAt && localSnapshot.updatedAt && sharedMeta.updatedAt >= localSnapshot.updatedAt)
      hasAuthoritativeIntelSnapshotRef.current = snapshotAvailable
      skipInitialLocalIntelPersistRef.current = Boolean(snapshotAvailable && !selectedFromShared && storesAlreadyMatch)
      skipInitialSharedIntelPersistRef.current = Boolean(snapshotAvailable && (selectedFromShared || storesAlreadyMatch))
      initialLocalIntelUpdatedAtRef.current = selectedFromShared ? sharedMeta?.updatedAt ?? undefined : undefined
      if (active) setArchiveLoadError(hydrationError)
      if (active && snapshotAvailable) setData((current) => {
        const keepDirectoryMetadata = Boolean(sourceFingerprint && sourceFingerprint === current.archive.sourceFingerprint)
        const next = { ...current, intel: snapshot, archive: { ...summarizeArchive(snapshot, keepDirectoryMetadata ? current.archive.fileCount : undefined), ...(sourceFingerprint ? { sourceFingerprint } : {}), lastImport: current.archive.lastImport, lastAnalysis: current.archive.lastAnalysis } }
        return dismissInvalidAiCandidates(mergePeople(
          { ...next, people: enrichPeopleEvidence(next.people, snapshot) },
          buildDirectConversationFallbackPeople(snapshot),
        ))
      })
    })()
      .catch((error) => {
        if (active) setArchiveLoadError(`原始聊天归档初始化失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { if (active) setIntelHydrated(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!intelHydrated) return
    // An empty array is authoritative only after it came from an existing
    // local/shared snapshot or an explicit directory import. When startup
    // could not reach either store, keep polling instead of overwriting a
    // temporarily unavailable archive with an accidental empty value.
    if (!data.intel.length && !hasAuthoritativeIntelSnapshotRef.current) return
    if (skipInitialLocalIntelPersistRef.current) {
      skipInitialLocalIntelPersistRef.current = false
    } else {
      void saveIntelSnapshot(data.intel, data.archive.sourceFingerprint, initialLocalIntelUpdatedAtRef.current)
        .catch((error) => setArchiveLoadError(`浏览器原始聊天缓存保存失败：${error instanceof Error ? error.message : String(error)}`))
    }
    initialLocalIntelUpdatedAtRef.current = undefined
    if (skipInitialSharedIntelPersistRef.current) {
      skipInitialSharedIntelPersistRef.current = false
      lastSharedIntelWriteKeyRef.current = sharedIntelWriteKey
      return
    }
    // AI analysis updates local per-record markers but does not change the raw
    // archive. Avoid sending and gzip-compressing hundreds of thousands of
    // unchanged messages after every run; directory imports change this key.
    if (lastSharedIntelWriteKeyRef.current === sharedIntelWriteKey || pendingSharedIntelWriteKeyRef.current === sharedIntelWriteKey) return
    if (sharedIntelWriteTimerRef.current) window.clearTimeout(sharedIntelWriteTimerRef.current)
    const snapshot = data.intel
    const writeKey = sharedIntelWriteKey
    sharedIntelWriteTimerRef.current = window.setTimeout(() => {
      pendingSharedIntelWriteKeyRef.current = writeKey
      // This is a loopback-only archive write. It runs after import or task
      // processing, not while people cards are streaming into the UI.
      const persistArchive = async () => {
        try {
          const saved = await saveSharedIntelSnapshot(snapshot, data.archive.sourceFingerprint, () => sharedIntelUpdatedAtRef.current)
          sharedIntelUpdatedAtRef.current = saved.updatedAt
          return saved
        } catch (error) {
          if (Number((error as { status?: number })?.status) !== 409) throw error
          // Another renderer wrote while this request was uploading. Merge by
          // stable record ID, then retry against the version just read. This
          // preserves additions from both windows without silently replacing
          // the newer archive with a stale full-array upload.
          const remote = await loadSharedIntelSnapshot()
          sharedIntelUpdatedAtRef.current = remote.updatedAt
          const localFingerprint = data.archive.sourceFingerprint ?? null
          const remoteFingerprint = remote.sourceFingerprint ?? null
          if (localFingerprint !== remoteFingerprint) {
            // A connected directory is an authoritative snapshot. When the
            // fingerprints differ, merging by ID would reintroduce messages
            // removed from the directory. Prefer whichever snapshot was
            // imported most recently; otherwise keep the remote version as
            // the safer default.
            const localImportAt = Date.parse(data.archive.lastImport?.importedAt ?? '')
            const remoteVersionAt = Date.parse(remote.updatedAt ?? '')
            const localIsNewer = Boolean(
              localFingerprint
              && Number.isFinite(localImportAt)
              && (!Number.isFinite(remoteVersionAt) || localImportAt > remoteVersionAt),
            )
            if (localIsNewer) {
              const saved = await saveSharedIntelSnapshot(snapshot, localFingerprint ?? undefined, () => sharedIntelUpdatedAtRef.current)
              sharedIntelUpdatedAtRef.current = saved.updatedAt
              return saved
            }
            setData((current) => {
              if (current.intel !== snapshot) return current
              const keepDirectoryMetadata = Boolean(remoteFingerprint && remoteFingerprint === current.archive.sourceFingerprint)
              return {
                ...current,
                intel: remote.items,
                archive: {
                  ...summarizeArchive(remote.items, keepDirectoryMetadata ? current.archive.fileCount : undefined),
                  ...(remoteFingerprint ? { sourceFingerprint: remoteFingerprint } : {}),
                  lastAnalysis: current.archive.lastAnalysis,
                },
              }
            })
            return remote
          }
          const mergedById = new Map(remote.items.map((item) => [item.id, item]))
          snapshot.forEach((item) => mergedById.set(item.id, item))
          const mergedItems = [...mergedById.values()]
          const saved = await saveSharedIntelSnapshot(mergedItems, data.archive.sourceFingerprint, () => sharedIntelUpdatedAtRef.current)
          sharedIntelUpdatedAtRef.current = saved.updatedAt
          setData((current) => current.intel === snapshot
            ? { ...current, intel: mergedItems, archive: { ...summarizeArchive(mergedItems, current.archive.fileCount), sourceFingerprint: current.archive.sourceFingerprint, lastImport: current.archive.lastImport, lastAnalysis: current.archive.lastAnalysis } }
            : current)
          return saved
        }
      }
      void persistArchive()
        .then(() => {
          lastSharedIntelWriteKeyRef.current = writeKey
          setArchiveLoadError('')
        })
        .catch((error) => {
          setArchiveLoadError(`本机原始聊天归档保存失败：${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          if (pendingSharedIntelWriteKeyRef.current === writeKey) pendingSharedIntelWriteKeyRef.current = ''
        })
    }, 900)
    return () => { if (sharedIntelWriteTimerRef.current) window.clearTimeout(sharedIntelWriteTimerRef.current) }
  }, [data.archive.lastImport?.importedAt, data.archive.sourceFingerprint, data.intel, intelHydrated, sharedIntelWriteKey])

  useEffect(() => {
    if (!intelHydrated || data.intel.length || hasAuthoritativeIntelSnapshotRef.current) return
    let active = true
    const restoreSharedArchive = () => {
      void loadSharedIntelMeta().then(async (meta) => {
        if (!active || hasAuthoritativeIntelSnapshotRef.current || !meta.updatedAt || dataRef.current.intel.length) return
        const snapshot = await loadSharedIntelSnapshot()
        if (!active || !snapshot.updatedAt || dataRef.current.intel.length) return
        hasAuthoritativeIntelSnapshotRef.current = true
        sharedIntelUpdatedAtRef.current = snapshot.updatedAt
        setArchiveLoadError('')
        setData((current) => {
          if (current.intel.length) return current
          const keepDirectoryMetadata = Boolean(snapshot.sourceFingerprint && snapshot.sourceFingerprint === current.archive.sourceFingerprint)
          const next = { ...current, intel: snapshot.items, archive: { ...summarizeArchive(snapshot.items, keepDirectoryMetadata ? current.archive.fileCount : undefined), ...(snapshot.sourceFingerprint ? { sourceFingerprint: snapshot.sourceFingerprint } : {}), lastImport: current.archive.lastImport, lastAnalysis: current.archive.lastAnalysis } }
          return dismissInvalidAiCandidates(mergePeople(
            { ...next, people: enrichPeopleEvidence(next.people, snapshot.items) },
            buildDirectConversationFallbackPeople(snapshot.items),
          ))
        })
      }).catch((error) => {
        if (active) setArchiveLoadError(`本机原始聊天归档恢复失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
    restoreSharedArchive()
    const timer = window.setInterval(restoreSharedArchive, 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [data.intel.length, intelHydrated])

  useEffect(() => {
    if (!intelHydrated) return
    let active = true
    void loadSharedSnapshot().then((snapshot) => {
      if (!active) return
      if (snapshot.data && snapshot.updatedAt) {
        const snapshotData = snapshot.data
        const previousBase = sharedBaseDataRef.current
        sharedUpdatedAtRef.current = snapshot.updatedAt
        sharedBaseDataRef.current = snapshotData
        setData((current) => {
          // The first shared read can finish after the user has already edited
          // local state. Apply those edits on top of the remote snapshot just
          // like later polling does; direct replacement would silently lose
          // tasks or people created during startup.
          const mergedSnapshotData = mergeSharedChanges(previousBase, toSharedData(current), snapshotData)
          const hasLocalChanges = JSON.stringify(mergedSnapshotData) !== JSON.stringify(snapshotData)
          const keepPeople = mergedSnapshotData.peopleModelVersion === 5 && Array.isArray(mergedSnapshotData.people)
          skipSharedWriteRef.current = keepPeople && !hasLocalChanges
          // This renderer may have just repaired the legacy bulk-dismissal
          // state while the initial shared read was still in flight. Do not
          // let that older snapshot put the broken list back into memory.
          const keepLocalDismissals = current.peopleDismissalVersion === PEOPLE_DISMISSAL_SEMANTICS_VERSION
            && mergedSnapshotData.peopleDismissalVersion !== PEOPLE_DISMISSAL_SEMANTICS_VERSION
          const next: AppData = {
            ...current,
            ...mergedSnapshotData,
            dismissedPersonConversationIds: keepLocalDismissals
              ? current.dismissedPersonConversationIds
              : mergedSnapshotData.dismissedPersonConversationIds,
            peopleDismissalVersion: keepLocalDismissals
              ? current.peopleDismissalVersion
              : mergedSnapshotData.peopleDismissalVersion,
            people: keepPeople ? mergedSnapshotData.people : [],
            intel: current.intel,
            peopleModelVersion: 5,
          }
          return dismissInvalidAiCandidates(mergePeople(
            { ...next, people: enrichPeopleEvidence(next.people, current.intel) },
            buildDirectConversationFallbackPeople(current.intel),
          ))
        })
      } else {
        // Seed durable task data even before chat records are available. This
        // path intentionally omits raw intel so huge archives cannot block it.
        void persistSharedSnapshot(data).catch(() => undefined)
      }
    }).catch((error) => {
      if (active) setSyncErrors((current) => ({ ...current, shared: `共享状态读取失败：${error instanceof Error ? error.message : String(error)}` }))
    }).finally(() => {
      if (!active) return
      sharedReadyRef.current = true
      setSharedReady(true)
    })
    return () => { active = false }
    // The initial pull establishes the desktop/browser shared source of truth once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intelHydrated])

  useEffect(() => {
    if (!intelHydrated || !sharedReady) return
    if (skipSharedWriteRef.current) { skipSharedWriteRef.current = false; return }
    if (sharedWriteTimerRef.current) window.clearTimeout(sharedWriteTimerRef.current)
    const snapshot = data
    sharedWriteTimerRef.current = window.setTimeout(() => {
      // Task and people state is intentionally small and writes independently
      // of the raw archive. A failed bulk archive upload can no longer discard
      // new tasks or people cards.
      void persistSharedSnapshot(snapshot).catch(() => undefined)
    }, 250)
  }, [data, intelHydrated, persistSharedSnapshot, sharedReady])

  useEffect(() => {
    const flush = async () => {
      if (flushInFlightRef.current) return flushInFlightRef.current
      const operation = (async () => {
      if (sharedWriteTimerRef.current) {
        window.clearTimeout(sharedWriteTimerRef.current)
        sharedWriteTimerRef.current = undefined
      }
      if (settingsWriteTimerRef.current) {
        window.clearTimeout(settingsWriteTimerRef.current)
        settingsWriteTimerRef.current = undefined
      }
      if (checkpointWriteTimerRef.current) {
        window.clearTimeout(checkpointWriteTimerRef.current)
        checkpointWriteTimerRef.current = undefined
      }

      const current = dataRef.current
      const writes: Promise<unknown>[] = []
      if (sharedReadyRef.current) {
        // Always enqueue the local snapshot. persistSharedSnapshot compares
        // the expected version and performs a three-way merge on conflict;
        // skipping this write when a remote version is newer would silently
        // discard edits made locally just before shutdown.
        writes.push(persistSharedSnapshot(current))
      }
      if (settingsReadyRef.current) {
        writes.push(saveSharedSettings({
          profile: current.profile,
          appearance: current.appearance,
          aiSettings: { ...current.aiSettings, interruptedRun: pendingCheckpointRef.current },
        }))
      }
      await Promise.allSettled(writes)
      await sharedSaveQueueRef.current
      await waitForSharedSettingsWrites()
      })()
      flushInFlightRef.current = operation
      try {
        await operation
      } finally {
        if (flushInFlightRef.current === operation) flushInFlightRef.current = null
      }
    }
    window.theiaFlush = flush
    const handlePageHide = () => { void flush() }
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      void flush()
      delete window.theiaFlush
    }
  }, [persistSharedSnapshot])

  useEffect(() => {
    if (!intelHydrated) return
    const timer = window.setInterval(() => {
      void loadSharedMeta().then((meta) => {
        if (!meta.updatedAt || meta.updatedAt <= sharedUpdatedAtRef.current) return
        return loadSharedSnapshot().then((snapshot) => {
          const snapshotData = snapshot.data
          if (!snapshotData || !snapshot.updatedAt || snapshot.updatedAt <= sharedUpdatedAtRef.current) return
          const previousBase = sharedBaseDataRef.current
          sharedUpdatedAtRef.current = snapshot.updatedAt
          setData((current) => {
            const mergedSnapshotData = mergeSharedChanges(previousBase, toSharedData(current), snapshotData)
            const hasLocalChanges = JSON.stringify(mergedSnapshotData) !== JSON.stringify(snapshotData)
            sharedBaseDataRef.current = snapshotData
            const keepPeople = mergedSnapshotData.peopleModelVersion === 5 && Array.isArray(mergedSnapshotData.people)
            skipSharedWriteRef.current = keepPeople && !hasLocalChanges
            const keepLocalDismissals = current.peopleDismissalVersion === PEOPLE_DISMISSAL_SEMANTICS_VERSION
              && mergedSnapshotData.peopleDismissalVersion !== PEOPLE_DISMISSAL_SEMANTICS_VERSION
            const next: AppData = {
              ...current,
              ...mergedSnapshotData,
              dismissedPersonConversationIds: keepLocalDismissals
                ? current.dismissedPersonConversationIds
                : mergedSnapshotData.dismissedPersonConversationIds,
              peopleDismissalVersion: keepLocalDismissals
                ? current.peopleDismissalVersion
                : mergedSnapshotData.peopleDismissalVersion,
              people: keepPeople ? mergedSnapshotData.people : [],
              intel: current.intel,
              peopleModelVersion: 5,
            }
            return dismissInvalidAiCandidates(mergePeople(
              { ...next, people: enrichPeopleEvidence(next.people, current.intel) },
              buildDirectConversationFallbackPeople(current.intel),
            ))
          })
        })
      }).catch((error) => setSyncErrors((current) => ({ ...current, shared: `共享状态刷新失败：${error instanceof Error ? error.message : String(error)}` })))
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [intelHydrated])

  useEffect(() => {
    let active = true
    const createdUrls: string[] = []
    void Promise.all(Object.values(data.appearance.backgrounds).map(async (setting) => {
      if (!setting.imageId) return undefined
      const blob = await loadBackgroundAsset(setting.imageId)
      if (!blob) return undefined
      const url = URL.createObjectURL(blob)
      createdUrls.push(url)
      return [setting.imageId, url] as const
    })).then((pairs) => {
      if (!active) return
      setBackgroundUrls(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair))))
    }).catch(() => { if (active) setBackgroundUrls({}) })
    return () => {
      active = false
      createdUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [data.appearance.backgrounds])

  useEffect(() => {
    const shell = shellRef.current
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const coarsePointer = window.matchMedia('(pointer: coarse)')
    const memory = 'deviceMemory' in navigator ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) : 4
    if (!shell || !visualMotion || reducedMotion.matches) return

    // The setting now controls only lightweight cursor parallax. Decorative
    // animated overlays were removed to keep the background quiet and stable.
    if (coarsePointer.matches || memory < 4) {
      return
    }

    let frame = 0
    let x = 0
    let y = 0
    const applyMotion = () => {
      frame = 0
      shell.style.setProperty('--parallax-x', `${x}px`)
      shell.style.setProperty('--parallax-y', `${y}px`)
    }
    const move = (event: PointerEvent) => {
      x = ((event.clientX / window.innerWidth) - 0.5) * 16
      y = ((event.clientY / window.innerHeight) - 0.5) * 12
      if (!frame) frame = window.requestAnimationFrame(applyMotion)
    }
    const reset = () => {
      x = 0; y = 0
      if (!frame) frame = window.requestAnimationFrame(applyMotion)
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('blur', reset)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('blur', reset)
    }
  }, [visualMotion])

  useEffect(() => {
    const timer = window.setInterval(() => setTaskGuidanceRefreshTick((current) => current + 1), TASK_GUIDANCE_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => () => {
    taskGuidanceControllersRef.current.forEach(({ controller }) => controller.abort())
    taskGuidanceControllersRef.current.clear()
  }, [])

  useEffect(() => {
    if (!intelHydrated || !sharedReady) return
    const snapshot = dataRef.current
    const eligible = questsWithEvidence
      .filter((quest) => quest.status === 'available' || quest.status === 'active')
      .map((quest) => ({ quest, signature: taskGuidanceSignature(quest, snapshot.people, snapshot.places) }))
      .filter((item) => Boolean(item.signature))
    const eligibleSignatures = new Map(eligible.map(({ quest, signature }) => [quest.id, signature]))
    taskGuidanceControllersRef.current.forEach(({ controller, signature }, questId) => {
      if (eligibleSignatures.get(questId) !== signature) controller.abort()
    })

    // Existing tasks establish a baseline without immediately spending model
    // calls. Subsequent facts, preferences, time, place, or linked people will
    // change the signature and schedule exactly one refreshed suggestion.
    if (!taskGuidanceBootstrapRef.current) {
      taskGuidanceBootstrapRef.current = true
      const baseline = new Map(eligible.map(({ quest, signature }) => [quest.id, { signature, characterIds: quest.characterIds }]))
      if (!baseline.size) return
      setData((current) => {
        let changed = false
        const quests = current.quests.map((quest) => {
          const next = baseline.get(quest.id)
          if (!next || quest.guidanceEvidenceSignature) return quest
          changed = true
          return { ...quest, characterIds: next.characterIds, guidanceEvidenceSignature: next.signature }
        })
        return changed ? { ...current, quests } : current
      })
      return
    }

    const retryAfter = Date.now() - TASK_GUIDANCE_REFRESH_INTERVAL_MS
    const next = eligible.find(({ quest, signature }) => {
      const persisted = snapshot.quests.find((item) => item.id === quest.id)
      if (!persisted || persisted.guidanceEvidenceSignature === signature || taskGuidanceInFlightRef.current.has(quest.id)) return false
      const attemptedAt = new Date(persisted.guidanceRefreshAttemptedAt ?? 0).getTime()
      return !Number.isFinite(attemptedAt) || attemptedAt <= retryAfter
    })
    if (!next) return

    const controller = new AbortController()
    taskGuidanceInFlightRef.current.add(next.quest.id)
    taskGuidanceControllersRef.current.set(next.quest.id, { controller, signature: next.signature })
    void (async () => {
      const attemptedAt = new Date().toISOString()
      try {
        const status = await getAiStatus(controller.signal)
        if (!status.configured) {
          setData((current) => ({
            ...current,
            quests: current.quests.map((quest) => quest.id === next.quest.id
              ? { ...quest, guidanceRefreshAttemptedAt: attemptedAt }
              : quest),
          }))
          return
        }
        const latest = dataRef.current
        const persisted = latest.quests.find((quest) => quest.id === next.quest.id)
        if (!persisted) return
        const effectiveQuest = { ...persisted, characterIds: next.quest.characterIds }
        const signature = taskGuidanceSignature(effectiveQuest, latest.people, latest.places)
        if (!signature || signature !== next.signature) return
        const place = latest.places.find((item) => item.id === effectiveQuest.locationId)
        const people = latest.people.filter((person) => effectiveQuest.characterIds.includes(person.id))
        const weather = await fetchTaskWeather(place, effectiveQuest.startAt ?? effectiveQuest.dueAt, controller.signal)
        const result = await generateTaskGuidance({ quest: effectiveQuest, place, people, weather, settings: latest.aiSettings }, controller.signal)
        const updatedAt = new Date().toISOString()
        setData((current) => {
          const currentQuest = current.quests.find((quest) => quest.id === effectiveQuest.id)
          if (!taskGuidanceRequestIsCurrent(currentQuest, persisted, effectiveQuest.characterIds, current.people, current.places, signature)) return current
          return {
            ...current,
            quests: current.quests.map((quest) => quest.id === effectiveQuest.id
              ? {
                ...quest,
                characterIds: effectiveQuest.characterIds,
                ...(result.guidance.length ? { guidance: result.guidance, guidanceUpdatedAt: updatedAt } : {}),
                guidanceEvidenceSignature: signature,
                guidanceRefreshAttemptedAt: attemptedAt,
              }
              : quest),
          }
        })
      } catch {
        if (controller.signal.aborted) return
        // Record the attempt so temporary provider failures retry on the next
        // periodic pass rather than looping in the current render cycle.
        setData((current) => ({
          ...current,
          quests: current.quests.map((quest) => quest.id === next.quest.id
            ? { ...quest, guidanceRefreshAttemptedAt: attemptedAt }
            : quest),
        }))
      } finally {
        if (taskGuidanceControllersRef.current.get(next.quest.id)?.controller === controller) {
          taskGuidanceControllersRef.current.delete(next.quest.id)
        }
        taskGuidanceInFlightRef.current.delete(next.quest.id)
        setTaskGuidanceRefreshTick((current) => current + 1)
      }
    })()
  }, [data.aiSettings, data.people, data.places, intelHydrated, questsWithEvidence, sharedReady, taskGuidanceRefreshTick])

  const toggleQuest = (id: string) => {
    setData((current) => {
      const target = current.quests.find((quest) => quest.id === id)
      if (!target || target.status === 'locked') return current
      const willComplete = target.status !== 'done'
      const quests = current.quests.map((quest) => {
        if (quest.id === id) {
          return willComplete
            ? { ...quest, status: 'done', previousStatus: quest.status } as Quest
            : { ...quest, status: quest.previousStatus ?? 'available', previousStatus: undefined } as Quest
        }
        if (quest.parentId === id && quest.status === 'locked' && willComplete) return { ...quest, status: 'available', unlockedByParent: true } as Quest
        if (quest.parentId === id && quest.unlockedByParent && quest.status === 'available' && !willComplete) return { ...quest, status: 'locked', unlockedByParent: undefined } as Quest
        return quest
      })
      return {
        ...current,
        quests,
      }
    })
  }

  const createQuest = (quest: Quest) => {
    taskGuidanceControllersRef.current.get(quest.id)?.controller.abort()
    setData((current) => {
      const signature = quest.guidanceEvidenceSignature ?? taskGuidanceSignature(quest, current.people, current.places)
      const nextQuest = { ...quest, guidanceEvidenceSignature: signature }
      return { ...current, quests: current.quests.some((item) => item.id === quest.id) ? current.quests.map((item) => item.id === quest.id ? nextQuest : item) : [...current.quests, nextQuest] }
    })
    setEditingQuest(undefined)
    setView('quests')
  }

  const generateQuestGuidance = async (quest: Quest) => {
    const snapshot = dataRef.current
    const baselineQuest = snapshot.quests.find((item) => item.id === quest.id) ?? quest
    const expectedSignature = taskGuidanceSignature(quest, snapshot.people, snapshot.places)
    const place = snapshot.places.find((item) => item.id === quest.locationId)
    const people = snapshot.people.filter((person) => quest.characterIds.includes(person.id))
    const weather = await fetchTaskWeather(place, quest.startAt ?? quest.dueAt)
    const result = await generateTaskGuidance({
      quest,
      place,
      people,
      weather,
      settings: snapshot.aiSettings,
    })
    if (!result.guidance.length) throw new Error('模型未给出可用建议，请补充人物、时间或地点后重试。')
    const latest = dataRef.current
    if (!taskGuidanceRequestIsCurrent(latest.quests.find((item) => item.id === quest.id), baselineQuest, quest.characterIds, latest.people, latest.places, expectedSignature)) {
      throw new Error('任务内容在建议生成期间发生了变化，请基于最新内容重新生成。')
    }
    setData((current) => {
      const currentQuest = current.quests.find((item) => item.id === quest.id)
      if (!taskGuidanceRequestIsCurrent(currentQuest, baselineQuest, quest.characterIds, current.people, current.places, expectedSignature)) return current
      return {
        ...current,
        quests: current.quests.map((item) => item.id === quest.id
          ? {
            ...item,
            characterIds: quest.characterIds,
            guidance: result.guidance,
            guidanceEvidenceSignature: expectedSignature,
            guidanceUpdatedAt: new Date().toISOString(),
          }
          : item),
      }
    })
  }

  const deleteQuest = (id: string) => {
    taskGuidanceControllersRef.current.get(id)?.controller.abort()
    const candidateId = id.startsWith('q-ai-') ? id.slice(5) : undefined
    setData((current) => ({
      ...current,
      quests: removeQuestAndDetachChildren(current.quests, id),
      aiCandidates: current.aiCandidates.map((candidate) => candidateId && candidate.id === candidateId ? { ...candidate, status: 'dismissed' } : candidate),
    }))
    setEditingQuest((current) => current?.id === id ? undefined : current)
    setSourceQuest((current) => current?.id === id ? undefined : current)
  }

  const arrangeTaskAtlas = (arrangement: TaskAtlasArrangement) => {
    setData((current) => {
      const sourceOrders = new Map(arrangement.sourceOrder.map((id, index) => [id, index]))
      const targetOrders = new Map(arrangement.targetOrder.map((id, index) => [id, index]))
      return {
        ...current,
        quests: current.quests.map((quest) => {
          const targetOrder = targetOrders.get(quest.id)
          if (targetOrder !== undefined) return { ...quest, atlasCategory: arrangement.targetCategory, atlasOrder: targetOrder }
          const sourceOrder = sourceOrders.get(quest.id)
          if (sourceOrder !== undefined) return { ...quest, atlasCategory: arrangement.sourceCategory, atlasOrder: sourceOrder }
          return quest
        }),
      }
    })
  }

  const moveTaskAtlasCategory = (category: TaskAtlasCategory, position: TaskAtlasPosition) => {
    setData((current) => ({
      ...current,
      atlas: {
        categoryPositions: {
          ...(current.atlas?.categoryPositions ?? {}),
          [category]: position,
        },
      },
    }))
  }

  const importIntel = (items: IntelItem[], options: { replace?: boolean; replaceFiles?: string[]; fileCount?: number; sourceFingerprint?: string } = {}): IntelImportResult => {
    hasAuthoritativeIntelSnapshotRef.current = true
    let result: IntelImportResult = { added: 0, updated: 0, duplicates: items.length, archiveMessageCount: dataRef.current.intel.length, conversationCount: dataRef.current.archive.conversationCount }
    setData((current) => {
      const messageBody = (item: IntelItem) => (item.content || item.summary).replace(/^[^:]{1,64}:\s+/, '').trim()
      const exactKey = (item: IntelItem) => `${item.source}|${item.conversationId ?? ''}|${item.capturedAt}|${item.speaker ?? ''}|${messageBody(item)}`
      if (options.replaceFiles) {
        const replacedFiles = new Set(options.replaceFiles)
        const previousById = new Map(current.intel.map((item) => [item.id, item]))
        const seenIds = new Set<string>()
        const replacements: IntelItem[] = []
        let added = 0
        let updated = 0
        let duplicates = 0
        for (const item of items) {
          if (seenIds.has(item.id)) {
            duplicates += 1
            continue
          }
          seenIds.add(item.id)
          const previous = previousById.get(item.id)
          if (!previous) {
            added += 1
            replacements.push(item)
            continue
          }
          const changed = previous.content !== item.content
            || previous.summary !== item.summary
            || previous.capturedAt !== item.capturedAt
            || previous.speaker !== item.speaker
            || previous.messageType !== item.messageType
            || previous.speakerRole !== item.speakerRole
          if (changed) updated += 1
          replacements.push(changed ? item : { ...item, status: previous.status, aiAnalyzedAt: previous.aiAnalyzedAt })
        }
        const retained = current.intel.filter((item) => !item.sourceFile || !replacedFiles.has(item.sourceFile))
        const snapshotItems = [...replacements, ...retained]
        const baseArchive = summarizeArchive(snapshotItems, options.fileCount)
        const archive = archiveSummaryWithImport({ ...baseArchive, ...(options.sourceFingerprint ? { sourceFingerprint: options.sourceFingerprint } : {}), lastAnalysis: current.archive.lastAnalysis }, {
          importedAt: new Date().toISOString(),
          parsedMessageCount: items.length,
          addedMessageCount: added,
          updatedMessageCount: updated,
          duplicateMessageCount: duplicates,
          archiveMessageCount: snapshotItems.length,
          conversationCount: baseArchive.conversationCount,
        })
        result = { added, updated, duplicates, archiveMessageCount: snapshotItems.length, conversationCount: baseArchive.conversationCount }
        const base = {
          ...current,
          intel: snapshotItems,
          archive,
          people: enrichPeopleEvidence(current.people, snapshotItems),
        }
        return dismissInvalidAiCandidates(mergePeople(base, buildDirectConversationFallbackPeople(snapshotItems)))
      }
      if (options.replace) {
        // A connected directory is authoritative. Keep every parsed row from
        // the current files, including repeated messages with identical text;
        // only the same stable file/index ID is considered a duplicate.
        const previousById = new Map(current.intel.map((item) => [item.id, item]))
        const seenIds = new Set<string>()
        const snapshotItems: IntelItem[] = []
        let added = 0
        let updated = 0
        let duplicates = 0
        for (const item of items) {
          if (seenIds.has(item.id)) {
            duplicates += 1
            continue
          }
          seenIds.add(item.id)
          const previous = previousById.get(item.id)
          if (!previous) {
            added += 1
            snapshotItems.push(item)
            continue
          }
          const changed = previous.content !== item.content
            || previous.summary !== item.summary
            || previous.capturedAt !== item.capturedAt
            || previous.speaker !== item.speaker
            || previous.messageType !== item.messageType
            || previous.speakerRole !== item.speakerRole
          if (changed) updated += 1
          snapshotItems.push(changed ? item : { ...item, status: previous.status, aiAnalyzedAt: previous.aiAnalyzedAt })
        }
        const baseArchive = summarizeArchive(snapshotItems, options.fileCount)
        const archive = archiveSummaryWithImport({ ...baseArchive, ...(options.sourceFingerprint ? { sourceFingerprint: options.sourceFingerprint } : {}), lastAnalysis: current.archive.lastAnalysis }, {
          importedAt: new Date().toISOString(),
          parsedMessageCount: items.length,
          addedMessageCount: added,
          updatedMessageCount: updated,
          duplicateMessageCount: duplicates,
          archiveMessageCount: snapshotItems.length,
          conversationCount: baseArchive.conversationCount,
        })
        result = { added, updated, duplicates, archiveMessageCount: snapshotItems.length, conversationCount: baseArchive.conversationCount }
        const base = {
          ...current,
          intel: snapshotItems,
          archive,
          people: enrichPeopleEvidence(current.people, snapshotItems),
        }
        return dismissInvalidAiCandidates(mergePeople(base, buildDirectConversationFallbackPeople(snapshotItems)))
      }
      const legacyKey = (item: IntelItem) => item.capturedAt ? `${item.source}|${item.capturedAt}|${item.speaker ?? ''}|${messageBody(item)}` : ''
      const existingById = new Map(current.intel.map((item) => [item.id, item]))
      const existing = new Map(current.intel.map((item) => [exactKey(item), item]))
      const legacy = new Map<string, IntelItem[]>()
      current.intel.forEach((item) => {
        const key = legacyKey(item)
        if (!key) return
        const matches = legacy.get(key)
        if (matches) matches.push(item)
        else legacy.set(key, [item])
      })
      const upgrades = new Map<string, IntelItem>()
      const consumedLegacyIds = new Set<string>()
      const additions: IntelItem[] = []
      let updated = 0
      let duplicates = 0
      for (const item of items) {
        const matched = existingById.get(item.id)
          ?? existing.get(exactKey(item))
          // This only upgrades an old record which lacked the folder-derived
          // conversation ID. Never de-duplicate repeated untimed messages by text.
          ?? (item.capturedAt ? legacy.get(legacyKey(item))?.find((candidate) => !candidate.conversationId && !consumedLegacyIds.has(candidate.id)) : undefined)
        if (matched) {
          const conversationChanged = Boolean(item.conversationId && (matched.conversationId !== item.conversationId || matched.conversationName !== item.conversationName || matched.conversationKind !== item.conversationKind))
          const speakerChanged = Boolean(item.speaker && item.speaker !== matched.speaker)
          const avatarChanged = Boolean(item.avatarUrl && item.avatarUrl !== matched.avatarUrl)
          const contentChanged = Boolean(item.content && item.content !== matched.content)
          const messageTypeChanged = Boolean(item.messageType && item.messageType !== matched.messageType)
          const capturedAtChanged = Boolean(item.capturedAt && item.capturedAt !== matched.capturedAt)
          const directionChanged = Boolean(item.speakerRole && item.speakerRole !== 'unknown' && item.speakerRole !== matched.speakerRole)
          // Avatar metadata enriches person cards only. It must not reopen
          // already-reviewed messages or cause task extraction to run again.
          const analysisInputChanged = speakerChanged || contentChanged || messageTypeChanged || capturedAtChanged || directionChanged
          const recordMetadataChanged = conversationChanged || avatarChanged
          if (recordMetadataChanged || analysisInputChanged) {
            consumedLegacyIds.add(matched.id)
            updated += 1
            upgrades.set(matched.id, {
              ...matched,
              ...(conversationChanged ? { conversationId: item.conversationId, conversationName: item.conversationName, conversationKind: item.conversationKind } : {}),
              ...(speakerChanged ? { speaker: item.speaker } : {}),
              ...(avatarChanged ? { avatarUrl: item.avatarUrl } : {}),
              ...(contentChanged ? { content: item.content } : {}),
              ...(messageTypeChanged ? { messageType: item.messageType } : {}),
              ...(capturedAtChanged ? { capturedAt: item.capturedAt } : {}),
              ...(directionChanged ? { speakerRole: item.speakerRole } : {}),
              ...(analysisInputChanged ? { aiAnalyzedAt: undefined, status: 'new' as const } : {}),
            })
          } else duplicates += 1
          continue
        }
        existing.set(exactKey(item), item)
        existingById.set(item.id, item)
        additions.push(item)
      }
      const intel = [...additions, ...current.intel.map((item) => upgrades.get(item.id) ?? item)]
      const baseArchive = summarizeArchive(intel, current.archive.fileCount)
      const archive = archiveSummaryWithImport({ ...baseArchive, ...(current.archive.sourceFingerprint ? { sourceFingerprint: current.archive.sourceFingerprint } : {}), lastAnalysis: current.archive.lastAnalysis }, {
        importedAt: new Date().toISOString(),
        parsedMessageCount: items.length,
        addedMessageCount: additions.length,
        updatedMessageCount: updated,
        duplicateMessageCount: duplicates,
        archiveMessageCount: intel.length,
        conversationCount: baseArchive.conversationCount,
      })
      result = { added: additions.length, updated, duplicates, archiveMessageCount: intel.length, conversationCount: baseArchive.conversationCount }
      const base = {
        ...current,
        intel,
        archive,
        people: enrichPeopleEvidence(current.people, intel),
      }
      // Private-conversation directories create cards locally on import; task
      // extraction and model availability are not prerequisites for this.
      return dismissInvalidAiCandidates(mergePeople(base, buildDirectConversationFallbackPeople(intel)))
    })
    return result
  }

  const updatePlace = (place: Place) => {
    setData((current) => ({
      ...current,
      places: current.places.map((item) => item.id === place.id ? place : item),
    }))
  }

  const createPlace = (place: Place) => {
    setData((current) => ({ ...current, places: [...current.places.filter((item) => item.id !== place.id), place] }))
    setSelectedPlaceId(place.id)
  }

  const deletePlace = (id: string) => {
    setData((current) => {
      if (current.places.length <= 1 || !current.places.some((place) => place.id === id)) return current
      const places = current.places.filter((place) => place.id !== id)
      const fallbackId = places[0]?.id ?? ''
      return {
        ...current,
        places,
        quests: current.quests.map((quest) => quest.locationId === id ? { ...quest, locationId: fallbackId } : quest),
      }
    })
    setSelectedPlaceId((current) => current === id ? '' : current)
  }

  const consolidatePeopleIfNeeded = (source: Person[] = dataRef.current.people) => {
    if (peopleConsolidationPausedRef.current) {
      if (!pendingPersonConsolidationsRef.current.size && !peopleAnalysisAbortRef.current) {
        setAnalysisWork((current) => current?.stage === 'people' ? null : current)
      }
      return
    }
    const updatePortraitProgress = () => {
      const profilePeople = dataRef.current.people.filter((person) => Boolean(portraitEvidenceSignature(person)))
      const completed = profilePeople.filter((person) => person.portraitEvidenceSignature === portraitEvidenceSignature(person)).length
      const pending = pendingPersonConsolidationsRef.current.size
      const retryCountFor = (person: Person) => Math.max(
        personConsolidationRetriesRef.current.get(person.id) ?? 0,
        Number(person.portraitRetryCount) || 0,
      )
      const retryable = profilePeople.some((person) => person.portraitEvidenceSignature !== portraitEvidenceSignature(person)
        && retryCountFor(person) < 3)
      const failed = profilePeople.filter((person) => person.portraitStatus === 'failed' && retryCountFor(person) >= 3).length
      if (!pending && !retryable) {
        if (!peopleAnalysisAbortRef.current) setAnalysisWork((current) => current?.stage === 'people' ? null : current)
        return
      }
      setAnalysisWork({
        stage: 'people',
        completed,
        total: profilePeople.length,
        completedConversations: completed,
        totalConversations: profilePeople.length,
        candidates: profilePeople.length,
        message: `正在归并人物画像：已完成 ${completed}/${profilePeople.length} 张人物卡，${pending} 个模型请求正在运行。${failed ? ` ${failed} 张已达到重试上限，可在人物卡中手动重试。` : ''}`,
      })
    }
    const availableSlots = Math.max(0, Math.min(
      PERSON_CONSOLIDATION_MAX_CONCURRENT,
      normalizeAiConcurrency(dataRef.current.aiSettings.concurrency),
    ) - pendingPersonConsolidationsRef.current.size)
    if (!availableSlots) {
      updatePortraitProgress()
      return
    }
    const queue = source.filter((person) => {
      const signature = portraitEvidenceSignature(person)
      return Boolean(signature)
        && person.portraitEvidenceSignature !== signature
        && completedPersonConsolidationSignaturesRef.current.get(person.id) !== signature
        && !pendingPersonConsolidationsRef.current.has(person.id)
        && Math.max(personConsolidationRetriesRef.current.get(person.id) ?? 0, Number(person.portraitRetryCount) || 0) < 3
    }).slice(0, availableSlots)
    if (!queue.length) {
      updatePortraitProgress()
      return
    }
    queue.forEach((person) => {
      const signature = portraitEvidenceSignature(person)
      const retryCount = Math.max(personConsolidationRetriesRef.current.get(person.id) ?? 0, Number(person.portraitRetryCount) || 0)
      const attempt = retryCount + 1
      const controller = new AbortController()
      pendingPersonConsolidationsRef.current.add(person.id)
      personConsolidationControllersRef.current.set(person.id, controller)
      personConsolidationRetriesRef.current.set(person.id, attempt)
      setData((current) => {
        const index = current.people.findIndex((candidate) => candidate.id === person.id)
        if (index < 0 || portraitEvidenceSignature(current.people[index]) !== signature) return current
        const nextPeople = [...current.people]
        nextPeople[index] = {
          ...nextPeople[index],
          portraitStatus: 'processing',
          portraitFailure: undefined,
          portraitRetryCount: attempt,
        }
        return { ...current, people: nextPeople }
      })
      let failed = false
      let aborted = false
      const markFailure = (message: string) => {
        setData((current) => {
          const index = current.people.findIndex((candidate) => candidate.id === person.id)
          if (index < 0 || portraitEvidenceSignature(current.people[index]) !== signature) return current
          const nextPeople = [...current.people]
          nextPeople[index] = {
            ...nextPeople[index],
            portraitStatus: 'failed',
            portraitFailure: message.slice(0, 360),
            portraitRetryCount: attempt,
            portraitEvidenceSignature: undefined,
          }
          return { ...current, people: nextPeople }
        })
      }
      void consolidatePerson(person, dataRef.current.aiSettings, controller.signal).then((consolidated) => {
        if (!consolidated) {
          failed = true
          markFailure('模型未返回通过证据校验的人物刻画。')
          return
        }
        setData((current) => {
          const index = current.people.findIndex((candidate) => candidate.id === person.id)
          if (index < 0) return current
          const existing = current.people[index]
          // New segment evidence arrived while this request was in flight. It
          // must get a fresh, whole-evidence profile rather than be mixed into
          // a portrait based on an earlier subset.
          if (portraitEvidenceSignature(existing) !== signature) return current
          completedPersonConsolidationSignaturesRef.current.set(person.id, signature)
          const nextPerson: Person = {
            ...existing,
            facts: consolidated.facts,
            preferences: consolidated.preferences,
            advice: consolidated.advice,
            portrait: consolidated.portrait,
            portraitBlocks: consolidated.portraitBlocks,
            portraitCoverage: consolidated.portraitCoverage,
            portraitSchemaVersion: consolidated.portraitSchemaVersion,
            portraitSourceIds: consolidated.portraitSourceIds,
            profileNotesUsed: consolidated.profileNotesUsed,
            portraitEvidenceSignature: signature,
            portraitStatus: 'ready',
            portraitFailure: undefined,
            portraitRetryCount: 0,
            model: consolidated.model,
          }
          if (JSON.stringify(existing) === JSON.stringify(nextPerson)) return current
          const people = [...current.people]
          people[index] = nextPerson
          return { ...current, people }
        })
      }).catch((error) => {
        aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        failed = !aborted
        if (failed) markFailure(error instanceof Error ? error.message : '人物刻画请求失败。')
      }).finally(() => {
        if (personConsolidationControllersRef.current.get(person.id) === controller) {
          personConsolidationControllersRef.current.delete(person.id)
        }
        pendingPersonConsolidationsRef.current.delete(person.id)
        if (!failed || aborted) personConsolidationRetriesRef.current.delete(person.id)
        // Drain a small bounded queue so long archives do not create hundreds
        // of simultaneous profile requests after their evidence pass finishes.
        window.setTimeout(() => {
          updatePortraitProgress()
          consolidatePeopleIfNeeded()
        }, 0)
      })
    })
    updatePortraitProgress()
  }

  const retryPersonPortrait = (id: string) => {
    personConsolidationRetriesRef.current.delete(id)
    completedPersonConsolidationSignaturesRef.current.delete(id)
    setData((current) => {
      const index = current.people.findIndex((person) => person.id === id)
      if (index < 0) return current
      const nextPeople = [...current.people]
      nextPeople[index] = {
        ...nextPeople[index],
        portrait: undefined,
        portraitBlocks: [],
        portraitCoverage: undefined,
        portraitSourceIds: [],
        profileNotesUsed: undefined,
        portraitEvidenceSignature: undefined,
        portraitStatus: 'processing',
        portraitFailure: undefined,
        portraitRetryCount: 0,
      }
      return { ...current, people: nextPeople }
    })
    window.setTimeout(() => consolidatePeopleIfNeeded(), 0)
  }

  const mergeIncomingPeople = (additions: Person[], explicitExtraction = false) => {
    if (!additions.length) return
    const incomingNames = new Set(additions.map((person) => canonicalPersonName(person.name)))
    const incomingConversationIds = new Set(additions.flatMap((person) => person.conversationIds ?? []))
    additions.forEach((person) => {
      personConsolidationControllersRef.current.get(person.id)?.abort()
      personConsolidationRetriesRef.current.delete(person.id)
      completedPersonConsolidationSignaturesRef.current.delete(person.id)
    })
    dataRef.current.people.forEach((person) => {
      if (incomingNames.has(canonicalPersonName(person.name))
        || (person.conversationIds ?? []).some((id) => incomingConversationIds.has(id))) {
        personConsolidationRetriesRef.current.delete(person.id)
      }
    })
    setData((current) => mergePeople(current, additions, { restoreDismissedConversations: explicitExtraction }))
  }

  const runPeopleAnalysis = async (source: IntelItem[], settings: AiSettings, onProgress?: (progress: AiProgress) => void) => {
    if (peopleAnalysisAbortRef.current) throw new Error('已有一项人物提炼正在运行，请先等待完成或停止它。')
    const directRecords = source.filter((item) => inferConversationKind(item) === 'direct' && Boolean(item.conversationId))
    const conversationCount = new Set(directRecords.map((item) => item.conversationId)).size
    if (!directRecords.length) return { started: false, people: [], reason: '当前范围内没有带可靠会话身份的私聊记录。' }

    // Let the verified local import immediately supply names, avatars, and
    // interaction ranges while the more expensive evidence pass is running.
    mergeIncomingPeople(buildDirectConversationFallbackPeople(directRecords))
    peopleConsolidationPausedRef.current = false
    const controller = new AbortController()
    let bufferedPeople: Person[] = []
    let peopleFlushTimer: number | undefined
    const flushPeople = () => {
      if (peopleFlushTimer !== undefined) {
        window.clearTimeout(peopleFlushTimer)
        peopleFlushTimer = undefined
      }
      if (!bufferedPeople.length) return
      const additions = bufferedPeople
      bufferedPeople = []
      mergeIncomingPeople(additions, true)
    }
    const queuePeople = (additions: Person[]) => {
      bufferedPeople.push(...additions)
      if (peopleFlushTimer !== undefined) return
      // Provider results can arrive in bursts. Coalescing a single paint's
      // worth avoids hundreds of full App renders without risking progress.
      peopleFlushTimer = window.setTimeout(flushPeople, 80)
    }
    peopleAnalysisAbortRef.current = controller
    setAnalysisWork({
      stage: 'people',
      completed: 0,
      total: 0,
      completedConversations: 0,
      totalConversations: conversationCount,
      candidates: 0,
      message: `正在准备人物提炼：将处理 ${conversationCount} 个私聊对话。`,
    })
    const updateProgress = (progress: AiProgress) => {
      const segment = progress.totalSegmentsInConversation
        ? `“${progress.currentConversation ?? '当前私聊'}” ${progress.currentSegment}/${progress.totalSegmentsInConversation}`
        : progress.currentConversation ?? '正在准备下一个私聊'
      const progressMessage = `人物总进度：${progress.completedConversations ?? 0}/${progress.totalConversations ?? conversationCount} 个对话；片段 ${progress.completed}/${progress.total}。当前 ${segment}；已保留 ${progress.candidates} 张人物卡。`
      setAnalysisWork({
        stage: 'people',
        completed: progress.completed,
        total: progress.total,
        completedConversations: progress.completedConversations,
        totalConversations: progress.totalConversations ?? conversationCount,
        candidates: progress.candidates,
        message: progressMessage,
      })
      onProgress?.(progress)
    }
    try {
      const result = await analyzePeople(directRecords, updateProgress, queuePeople, appendPeopleDebug, settings, {
        signal: controller.signal,
        concurrency: normalizeAiConcurrency(settings.concurrency),
      })
      flushPeople()
      window.setTimeout(() => consolidatePeopleIfNeeded(), 0)
      return { started: true, ...result }
    } finally {
      flushPeople()
      if (peopleAnalysisAbortRef.current === controller) {
        peopleAnalysisAbortRef.current = null
        setAnalysisWork((current) => current?.stage === 'people' ? null : current)
      }
    }
  }

  const saveAiAnalysis = (candidates: AiTaskCandidate[], analyzedIds: string[], settings: AiSettings, analysis: Omit<ArchiveAnalysisSummary, 'analyzedAt'>, completedSuccessfully: boolean, watermarkEligible = false) => {
    const analyzedAt = new Date().toISOString()
    setData((current) => {
      const existing = new Set(current.aiCandidates.map((candidate) => `${candidate.title}|${candidate.description}`))
      const unique = candidates.filter((candidate) => !existing.has(`${candidate.title}|${candidate.description}`))
      const taskWatermarks = watermarkEligible ? completedConversationWatermarks(current.intel, analyzedIds) : {}
      const previousWatermarks = current.aiSettings.analysisWatermarks?.tasks ?? {}
      return {
        ...current,
        aiCandidates: [...unique, ...current.aiCandidates],
        aiSettings: {
          ...current.aiSettings,
          ...(completedSuccessfully ? { lastRunAt: analyzedAt } : {}),
          intervalHours: Math.max(24, current.aiSettings.intervalHours, settings.intervalHours),
          ...(Object.keys(taskWatermarks).length ? {
            analysisWatermarks: {
              ...current.aiSettings.analysisWatermarks,
              tasks: { ...previousWatermarks, ...taskWatermarks },
            },
          } : {}),
        },
        archive: archiveSummaryWithAnalysis(current.archive, { ...analysis, analyzedAt }),
      }
    })
  }

  const savePeopleAnalysisWatermark = (analyzedIds: string[], eligible: boolean) => {
    if (!eligible || !analyzedIds.length) return
    setData((current) => {
      const peopleWatermarks = completedConversationWatermarks(current.intel, analyzedIds)
      if (!Object.keys(peopleWatermarks).length) return current
      return {
        ...current,
        aiSettings: {
          ...current.aiSettings,
          lastPeopleFollowupAt: new Date().toISOString(),
          analysisWatermarks: {
            ...current.aiSettings.analysisWatermarks,
            people: { ...(current.aiSettings.analysisWatermarks?.people ?? {}), ...peopleWatermarks },
          },
        },
      }
    })
  }

  const saveAnalysisCheckpoint = useCallback((checkpoint?: AiExtractionCheckpoint) => {
    pendingCheckpointRef.current = checkpoint
    setData((current) => ({
      ...current,
      aiSettings: { ...current.aiSettings, interruptedRun: checkpoint },
    }))

    const persist = () => {
      checkpointWriteTimerRef.current = undefined
      const current = dataRef.current
      void saveSharedSettings({
        profile: current.profile,
        appearance: current.appearance,
        aiSettings: { ...current.aiSettings, interruptedRun: pendingCheckpointRef.current },
      }).then(() => setSyncErrors((errors) => errors.settings ? { ...errors, settings: undefined } : errors))
        .catch((error) => setSyncErrors((errors) => ({ ...errors, settings: `提炼恢复进度保存失败：${error instanceof Error ? error.message : String(error)}` })))
    }
    const immediate = !checkpoint || Boolean(checkpoint.pausedAt)
    if (immediate) {
      if (checkpointWriteTimerRef.current) window.clearTimeout(checkpointWriteTimerRef.current)
      persist()
      return
    }
    if (!checkpointWriteTimerRef.current) {
      checkpointWriteTimerRef.current = window.setTimeout(persist, 1_000)
    }
  }, [])

  const stopPeopleAnalysis = () => {
    const controller = peopleAnalysisAbortRef.current
    const portraitControllers = [...personConsolidationControllersRef.current.values()]
    if (!controller && !portraitControllers.length) return
    peopleConsolidationPausedRef.current = true
    setAnalysisWork((current) => current?.stage === 'people'
      ? { ...current, message: '正在停止人物提炼；已写入本地的人物卡会保留。' }
      : current)
    appendPeopleDebug({ at: new Date().toISOString(), event: 'people_run_cancelled', level: 'warn', message: '用户停止人物提炼；已经写入本地的人物卡会保留。' })
    controller?.abort()
    portraitControllers.forEach((pending) => pending.abort())
  }

  const clearAllPeople = () => {
    stopPeopleAnalysis()
    pendingPersonConsolidationsRef.current.clear()
    personConsolidationControllersRef.current.forEach((controller) => controller.abort())
    personConsolidationControllersRef.current.clear()
    personConsolidationRetriesRef.current.clear()
    completedPersonConsolidationSignaturesRef.current.clear()
    setData((current) => removePeopleCards(
      current,
      current.people.map((person) => person.id),
      PEOPLE_DISMISSAL_SEMANTICS_VERSION,
    ))
    setSelectedPersonId('')
  }

  const clearAllQuests = () => {
    taskGuidanceControllersRef.current.forEach(({ controller }) => controller.abort())
    setData((current) => ({
      ...current,
      quests: [],
      aiCandidates: current.aiCandidates.map((candidate) => candidate.status === 'created' ? { ...candidate, status: 'dismissed' } : candidate),
    }))
    setEditingQuest(undefined)
    setSourceQuest(undefined)
  }

  const resolveGeneratedQuestPlaces = async (created: Quest[], candidates: AiTaskCandidate[]) => {
    const candidatesByQuestId = new Map(candidates.map((candidate) => [`q-ai-${candidate.id}`, candidate]))
    const searchCache = new Map<string, Awaited<ReturnType<typeof searchMapPlaces>>>()
    const resolved = new Map<string, { placeId: string; place?: Place }>()
    for (const quest of created) {
      if (quest.locationId) continue
      const candidate = candidatesByQuestId.get(quest.id)
      const query = candidate?.place?.trim()
      if (!candidate || !query || /^(?:未指定|不明确|未知|无)$/i.test(query)) continue
      const existing = dataRef.current.places.find((place) => place.name.toLocaleLowerCase('zh-CN').includes(query.toLocaleLowerCase('zh-CN')) || query.toLocaleLowerCase('zh-CN').includes(place.name.toLocaleLowerCase('zh-CN')))
      if (existing) {
        resolved.set(quest.id, { placeId: existing.id })
        continue
      }
      try {
        let results = searchCache.get(query)
        if (!results) {
          results = await searchMapPlaces(query)
          searchCache.set(query, results)
        }
        const result = results[0]
        if (!result) continue
        const precision = candidate.locationPrecision === 'exact' || candidate.locationPrecision === 'approximate'
          ? candidate.locationPrecision
          : mapSearchPrecision(result)
        const searchedRadius = mapSearchRadius(result)
        const requestedRadius = Number(candidate.locationRadiusMeters)
        const radiusMeters = precision === 'approximate'
          ? Math.round(Math.min(100_000, Math.max(50, Number.isFinite(requestedRadius) && requestedRadius > 0 ? requestedRadius : searchedRadius ?? 800)))
          : undefined
        const placeId = `ai-place-${stableId(query.toLocaleLowerCase('zh-CN'))}`
        resolved.set(quest.id, {
          placeId,
          place: {
            id: placeId,
            name: query.slice(0, 80),
            category: placeCategoryForCandidate(candidate),
            lat: Number(Number(result.lat).toFixed(6)),
            lng: Number(Number(result.lon).toFixed(6)),
            note: `由任务地点自动定位：${result.display_name}`.slice(0, 500),
            precision,
            radiusMeters,
          },
        })
      } catch {
        // A failed public geocoder must not prevent task creation.
      }
    }
    if (!resolved.size) return
    setData((current) => {
      const places = [...current.places]
      resolved.forEach(({ place }) => {
        if (place && !places.some((item) => item.id === place.id)) places.push(place)
      })
      return {
        ...current,
        places,
        quests: current.quests.map((quest) => {
          const resolution = resolved.get(quest.id)
          return resolution && !quest.locationId ? { ...quest, locationId: resolution.placeId } : quest
        }),
      }
    })
  }

  const createQuestsFromAi = (candidates: AiTaskCandidate[]) => {
    if (!candidates.length) return 0
    const snapshot = dataRef.current
    const sourceIds = new Set(candidates.flatMap((candidate) => candidate.sourceIds))
    const snapshotIntelById = snapshot.intel === data.intel ? intelById : (() => {
      const indexed = new Map<string, IntelItem>()
      for (const item of snapshot.intel) if (sourceIds.has(item.id)) indexed.set(item.id, item)
      return indexed
    })()
    const locationFor = (candidate: AiTaskCandidate) => {
      const target = candidate.place?.toLowerCase()
      return snapshot.places.find((place) => target && (place.name.toLowerCase().includes(target) || target.includes(place.name.toLowerCase())))?.id ?? ''
    }
    const personIdsFor = (candidate: AiTaskCandidate) => snapshot.people.filter((person) => candidate.people.some((name) => person.name.includes(name) || name.includes(person.name))).map((person) => person.id)
    const usedIds = new Set(snapshot.quests.map((quest) => quest.id))
    const created = candidates
      .filter((candidate) => candidate.status === 'pending' && !usedIds.has(`q-ai-${candidate.id}`))
      .map((candidate): Quest => {
        const sourceItems = candidate.sourceIds.map((id) => snapshotIntelById.get(id)).filter((item): item is IntelItem => Boolean(item))
        const details = sourceDetails(sourceItems)
        return {
          id: `q-ai-${candidate.id}`,
          title: candidate.title,
          description: candidate.description,
          status: 'available',
          locationId: locationFor(candidate),
          characterIds: personIdsFor(candidate),
          startAt: candidate.startAt,
          dueAt: candidate.dueAt,
          sourceCapturedAt: candidate.sourceCapturedAt ?? candidate.createdAt,
          source: details.platforms.join(' · ') || `模型分析 · ${candidate.model}`,
          sourceIds: candidate.sourceIds,
          sourcePlatforms: details.platforms,
          providers: details.providers,
          tags: ['模型候选', ...candidate.tags].slice(0, 8),
          guidance: candidate.guidance,
        }
      })
    if (!created.length) return 0
    setData((current) => {
      // The AI call and place lookup can overlap with another confirmation
      // action. Re-check IDs against the latest state at commit time so a
      // stale render cannot append the same generated quest twice.
      const existingIds = new Set(current.quests.map((quest) => quest.id))
      const actualCreated = created.filter((quest) => !existingIds.has(quest.id))
      if (!actualCreated.length) return current
      const actualCandidateIds = new Set(actualCreated.map((quest) => quest.id.slice('q-ai-'.length)))
      const actualCandidates = candidates.filter((candidate) => actualCandidateIds.has(candidate.id))
      const reviewedSourceIds = new Set(actualCandidates.flatMap((candidate) => candidate.sourceIds))
      return {
        ...current,
        quests: [...current.quests, ...actualCreated],
        // Do not keep a second "created" archive entry. The quest retains its
        // source IDs and the original intel archive remains available.
        aiCandidates: current.aiCandidates.filter((candidate) => !actualCandidateIds.has(candidate.id)),
        intel: current.intel.map((item) => reviewedSourceIds.has(item.id) ? { ...item, status: 'reviewed' } : item),
        aiSettings: appendTaskFeedback(current.aiSettings, actualCandidates.map((candidate) => feedbackEntry(candidate, 'accepted', 'useful'))),
      }
    })
    void resolveGeneratedQuestPlaces(created, candidates)
    setView('quests')
    return created.length
  }

  const dismissAiCandidates = (ids: string[], reason: AiFeedbackReason = 'other') => {
    if (!ids.length) return
    const dismissed = new Set(ids)
    setData((current) => {
      const rejected = current.aiCandidates.filter((candidate) => dismissed.has(candidate.id))
      return {
        ...current,
        aiCandidates: current.aiCandidates.map((candidate) => dismissed.has(candidate.id) ? { ...candidate, status: 'dismissed' } : candidate),
        aiSettings: appendTaskFeedback(current.aiSettings, rejected.map((candidate) => feedbackEntry(candidate, 'dismissed', reason))),
      }
    })
  }

  const dismissPeople = (ids: string[]) => {
    if (!ids.length) return
    const dismissed = new Set(ids)
    ids.forEach((id) => {
      personConsolidationControllersRef.current.get(id)?.abort()
      personConsolidationControllersRef.current.delete(id)
      pendingPersonConsolidationsRef.current.delete(id)
      personConsolidationRetriesRef.current.delete(id)
      completedPersonConsolidationSignaturesRef.current.delete(id)
    })
    setData((current) => removePeopleCards(current, dismissed, PEOPLE_DISMISSAL_SEMANTICS_VERSION))
    if (dismissed.has(selectedPersonId)) setSelectedPersonId('')
  }

  const updatePersonProfileNotes = (id: string, notes: string) => {
    personConsolidationControllersRef.current.get(id)?.abort()
    completedPersonConsolidationSignaturesRef.current.delete(id)
    peopleConsolidationPausedRef.current = false
    const normalized = notes.trim().slice(0, 6_000)
    setData((current) => {
      const index = current.people.findIndex((person) => person.id === id)
      if (index < 0) return current
      const existing = current.people[index]
      if ((existing.profileNotes ?? '').trim() === normalized) return current
      const people = [...current.people]
      people[index] = {
        ...existing,
        profileNotes: normalized || undefined,
        // A changed bottom layer invalidates the generated narrative. Keep
        // the verified claims, then let the bounded merge queue rebuild it.
        portrait: undefined,
        portraitSourceIds: [],
        profileNotesUsed: undefined,
        portraitEvidenceSignature: undefined,
        portraitStatus: 'processing',
        portraitFailure: undefined,
        portraitRetryCount: 0,
        advice: [],
      }
      return { ...current, people }
    })
    // State updater execution may be deferred by React batching, so scheduling
    // must not depend on a variable mutated inside that updater.
    window.setTimeout(() => consolidatePeopleIfNeeded(), 0)
  }

  const resetDemoData = () => {
    resetData()
    const freshData = createSeedData()
    setData(freshData)
    setSelectedPlaceId(freshData.places[0]?.id ?? '')
    setSelectedPersonId(freshData.people[0]?.id ?? '')
    setView('quests')
  }

  const backgroundStyle = (): CSSProperties => {
    const setting = effectiveAppearance.backgrounds.app
    const url = setting.imageId ? backgroundUrls[setting.imageId] : setting.url
    return {
      '--view-background': backgroundCss(url),
      '--view-background-size': `${setting.scale}%`,
      '--view-background-blur': `${setting.blur}px`,
    } as CSSProperties
  }

  return (
    <div ref={shellRef} className={`app-shell theme--${effectiveAppearance.theme} ${visualMotion ? '' : 'motion-off'}`} style={backgroundStyle()}>
      <Sidebar profile={effectiveProfile} active={view} open={sidebarOpen} onChange={setView} onClose={() => setSidebarOpen(false)} onReset={resetDemoData} newIntelCount={newIntelCount} />
      <main className="main-shell">
        <Topbar view={view} profile={effectiveProfile} onMenu={() => setSidebarOpen(true)} onNewQuest={() => { setEditingQuest(undefined); setQuestModalOpen(true) }} />
        <div className={`view-container view-container--${view}`}>
          {view === 'quests' && <TaskMapView profile={effectiveProfile} quests={questsWithEvidence} places={data.places} people={data.people} intelById={intelById} atlas={data.atlas} onToggle={toggleQuest} onEdit={(quest) => { setEditingQuest(quest); setQuestModalOpen(true) }} onViewSource={setSourceQuest} onDelete={deleteQuest} onGenerateGuidance={generateQuestGuidance} onArrange={arrangeTaskAtlas} onMoveCategory={moveTaskAtlasCategory} />}
          <Suspense fallback={<div className="page-width empty-note" role="status">正在载入界面…</div>}>
            {view === 'timeline' && <TimelineView quests={questsWithEvidence} places={data.places} intel={data.intel} onToggle={toggleQuest} onEdit={(quest) => { setEditingQuest(quest); setQuestModalOpen(true) }} onViewSource={setSourceQuest} onDelete={deleteQuest} />}
            {view === 'map' && <MapView places={data.places} quests={questsWithEvidence} selectedPlaceId={effectiveSelectedPlaceId} onSelect={setSelectedPlaceId} onUpdatePlace={updatePlace} onCreatePlace={createPlace} onDeletePlace={deletePlace} />}
            {view === 'people' && <PeopleView people={data.people} quests={questsWithEvidence} selectedId={selectedPersonId} onSelect={setSelectedPersonId} onGoIntel={() => setView('intel')} onDismiss={dismissPeople} onUpdateProfileNotes={updatePersonProfileNotes} onRetryPortrait={retryPersonPortrait} intelCount={data.intel.length} intel={data.intel} />}
            {view === 'settings' && <OptionsView settings={data.aiSettings} onSettingsChange={(aiSettings) => setData((current) => {
              if (current.intel === data.intel && current.aiCandidates === data.aiCandidates) {
                return dismissInvalidAiCandidates({ ...current, aiSettings }, intelById)
              }
              const sourceIds = new Set(current.aiCandidates.flatMap((candidate) => candidate.sourceIds))
              const currentIntelById = new Map<string, IntelItem>()
              for (const item of current.intel) {
                if (sourceIds.has(item.id)) currentIntelById.set(item.id, item)
              }
              return dismissInvalidAiCandidates({ ...current, aiSettings }, currentIntelById)
            })} onAppearance={() => setAppearanceModalOpen(true)} personCount={data.people.length} questCount={data.quests.length} onClearPeople={clearAllPeople} onClearQuests={clearAllQuests} />}
          </Suspense>
          <div className={`persistent-intel-view ${view === 'intel' ? 'is-active' : ''}`} aria-hidden={view !== 'intel'}>
            <IntelView active={view === 'intel'} items={data.intel} intelHydrated={intelHydrated} archiveLoadError={archiveLoadError} archive={data.archive} candidates={data.aiCandidates} aiSettings={data.aiSettings} onImport={importIntel} onAiAnalysis={saveAiAnalysis} onDirectPeopleDetected={mergeIncomingPeople} onPeopleAnalysis={runPeopleAnalysis} onAnalysisWatermark={savePeopleAnalysisWatermark} onStopPeopleAnalysis={stopPeopleAnalysis} onAnalysisCheckpoint={saveAnalysisCheckpoint} onCreateAiQuests={createQuestsFromAi} onDismissAiCandidates={dismissAiCandidates} onAnalysisWorkChange={(next) => setAnalysisWork((current) => next === null && current?.stage === 'people' ? current : next)} />
          </div>
        </div>
      </main>
      {(syncErrors.shared || syncErrors.settings) && <div className={`shared-sync-alert ${analysisWork ? 'has-analysis' : ''}`} role="alert">
        <AlertTriangle size={17} />
        <span>{[syncErrors.shared, syncErrors.settings].filter(Boolean).join(' ')} 本地浏览器缓存仍会保留当前会话内容；请确认 THEIA 本机代理正在运行。</span>
        <button type="button" className="icon-button" title="关闭提示" aria-label="关闭持久化错误提示" onClick={() => setSyncErrors({})}><X size={15} /></button>
      </div>}
      {analysisWork && (view !== 'intel' || analysisWork.stage === 'people') && <div className="analysis-float-wrap"><button type="button" className="analysis-float" onClick={() => setView('intel')}>
        <Sparkles size={18} />
        <span><strong>{analysisWork.stage === 'people' ? '正在提炼人物' : '正在按对话提炼'}</strong>{typeof analysisWork.totalConversations === 'number' && analysisWork.totalConversations > 0 && <em className="analysis-float-progress">总进度 {analysisWork.completedConversations ?? 0}/{analysisWork.totalConversations} 个对话{analysisWork.total ? ` · ${analysisWork.completed}/${analysisWork.total} 个片段` : ''}</em>}<small title={analysisWork.message}>{analysisWork.message}</small></span>
      </button>{analysisWork.stage === 'people' && <button type="button" className="analysis-float-stop" title="停止人物提炼并保留已有卡片" aria-label="停止人物提炼并保留已有卡片" onClick={stopPeopleAnalysis}><CircleStop size={16} /></button>}</div>}
      <QuestModal key={`quest-${editingQuest?.id ?? 'new'}-${questModalOpen ? 'open' : 'closed'}`} open={questModalOpen} places={data.places} people={data.people} quest={editingQuest} onClose={() => { setQuestModalOpen(false); setEditingQuest(undefined) }} onSave={createQuest} />
      <QuestSourceModal quest={sourceQuest} intel={data.intel} onClose={() => setSourceQuest(undefined)} />
      <AppearanceModal key={`appearance-${appearanceModalOpen ? 'open' : 'closed'}`} open={appearanceModalOpen} name={data.profile.name} avatarUrl={data.profile.avatarUrl} appearance={effectiveAppearance} onClose={() => { setAppearancePreview(null); setAppearanceModalOpen(false) }} onPreview={({ name, avatarUrl, appearance }) => setAppearancePreview({ profile: { name, avatarUrl }, appearance })} onSave={({ name, avatarUrl, appearance }) => { setAppearancePreview(null); setData((current) => ({ ...current, profile: { ...current.profile, name, avatarUrl }, appearance })) }} />
    </div>
  )
}

export default App

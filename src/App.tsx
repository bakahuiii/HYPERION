import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CircleStop, Sparkles } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { QuestModal } from './components/QuestModal'
import { QuestSourceModal } from './components/QuestSourceModal'
import { AppearanceModal } from './components/AppearanceModal'
import { TaskMapView, type TaskAtlasArrangement } from './views/TaskMapView'
import { TimelineView } from './views/TimelineView'
import { MapView } from './views/MapView'
import { PeopleView } from './views/PeopleView'
import { IntelView, type AnalysisWorkState } from './views/IntelView'
import { OptionsView } from './views/OptionsView'
import { loadData, resetData, saveData } from './lib/storage'
import { normalizeAppearance } from './lib/appearance'
import { loadIntelSnapshot, saveIntelSnapshot } from './lib/intelStore'
import { seedData } from './seed'
import type { AiFeedbackReason, AiSettings, AiTaskCandidate, AiTaskFeedback, AppData, ArchiveAnalysisSummary, AppearanceSettings, IntelItem, Person, Place, Profile, Quest, TaskAtlasCategory, TaskAtlasPosition, ViewId } from './types'
import { loadBackgroundAsset } from './lib/appearanceAssets'
import { sourceProvider } from './lib/people'
import { analyzePeople, buildDirectConversationFallbackPeople, candidateRejectionReason, consolidatePerson, generateTaskGuidance, getAiStatus, type AiDebugEntry } from './lib/aiClient'
import { loadSharedMeta, loadSharedSnapshot, saveSharedSnapshot } from './lib/sharedSync'
import { loadSharedSettings, saveSharedSettings } from './lib/settingsClient'
import { mapSearchPrecision, mapSearchRadius, searchMapPlaces } from './lib/mapSearch'
import { archiveSummaryWithAnalysis, archiveSummaryWithImport, summarizeArchive } from './lib/archiveSummary'
import { fetchTaskWeather } from './lib/weather'
import { avatarImageUrl } from './lib/mediaProxy'

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

interface IntelImportResult {
  added: number
  updated: number
  duplicates: number
  archiveMessageCount: number
  conversationCount: number
}

function dismissInvalidAiCandidates(current: AppData) {
  const recordsById = new Map(current.intel.map((item) => [item.id, item]))
  const dismissed = current.aiCandidates.flatMap((candidate) => {
    if (candidate.status !== 'pending') return []
    const evidence = candidate.sourceIds.map((id) => recordsById.get(id)).filter((item): item is IntelItem => Boolean(item))
    const reason = candidateRejectionReason(candidate, evidence, current.aiSettings)
    return reason ? [{ candidate, reason }] : []
  })
  if (!dismissed.length) return current
  const dismissedIds = new Set(dismissed.map(({ candidate }) => candidate.id))
  return {
    ...current,
    aiCandidates: current.aiCandidates.map((candidate) => dismissedIds.has(candidate.id) ? { ...candidate, status: 'dismissed' as const } : candidate),
    aiSettings: appendTaskFeedback(current.aiSettings, dismissed.map(({ candidate, reason }) => feedbackEntry(candidate, 'dismissed', reason))),
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

function enrichQuestCharacters(quests: Quest[], candidates: AiTaskCandidate[], people: Person[], items: IntelItem[]) {
  if (!people.length) return quests
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const itemsById = new Map(items.map((item) => [item.id, item]))
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
    evidence.filter((item) => item.conversationKind === 'direct' && item.conversationId).forEach((item) => {
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

function isLocalExportVerifiedPerson(person: Person) {
  return person.model.includes('local-export-verified') || person.model.includes('\u5bfc\u51fa\u8bb0\u5f55\u6838\u9a8c')
}

const PERSON_FACT_DISPLAY_LIMIT = 12
const PERSON_FACT_BUFFER_LIMIT = 48
const TASK_GUIDANCE_REFRESH_INTERVAL_MS = 10 * 60 * 1000

function taskGuidanceSignature(quest: Quest, people: Person[]) {
  const linkedPeople = people
    .filter((person) => quest.characterIds.includes(person.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((person) => ({
      id: person.id,
      facts: person.facts,
      preferences: person.preferences ?? [],
      portrait: person.portrait ?? '',
      sourceIds: person.sourceIds,
    }))
  if (!linkedPeople.length) return ''
  return stableId(JSON.stringify({
    quest: [quest.id, quest.title, quest.description, quest.startAt ?? '', quest.dueAt ?? '', quest.locationId],
    people: linkedPeople,
  }))
}

function selectPeopleEvidence(items: IntelItem[], coveredConversationIds: Set<string>) {
  // The people pass receives every record in each eligible direct conversation.
  // Sampling this path makes a long conversation look like several unrelated
  // excerpts and can lose the sender's earliest verified interaction.
  return items.filter((item) => item.conversationKind === 'direct'
    && Boolean(item.conversationId)
    && !coveredConversationIds.has(item.conversationId!))
}

function enrichPeopleEvidence(people: Person[], items: IntelItem[]) {
  const itemsById = new Map(items.map((item) => [item.id, item]))
  const avatarByName = new Map<string, string>()
  const avatarByConversation = new Map<string, string>()
  items.forEach((item) => {
    if (!item.avatarUrl) return
    if (item.speaker?.trim()) avatarByName.set(canonicalPersonName(item.speaker), item.avatarUrl)
    if (item.conversationKind === 'direct' && item.conversationId && !avatarByConversation.has(item.conversationId)) avatarByConversation.set(item.conversationId, item.avatarUrl)
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

function mergePeople(current: AppData, additions: Person[]) {
  const dismissedConversationIds = new Set(current.dismissedPersonConversationIds ?? [])
  const allowedAdditions = additions.filter((person) => !(person.conversationIds ?? []).some((id) => dismissedConversationIds.has(id)))
  if (!allowedAdditions.length) return current
  const people = [...current.people]
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
    const merged: Person = {
      ...existing,
      avatarUrl: incoming.avatarUrl ?? existing.avatarUrl,
      // Facts are kept as an internal, evidence-backed buffer. The People UI
      // renders the consolidated description instead of exposing this list.
      facts: [...new Set([...existing.facts, ...incoming.facts])].slice(0, PERSON_FACT_BUFFER_LIMIT),
      preferences: [...new Set([...(existing.preferences ?? []), ...(incoming.preferences ?? [])])].slice(0, 18),
      advice: [...new Set([...(existing.advice ?? []), ...(incoming.advice ?? [])])].slice(0, 9),
      sourceIds: [...new Set([...existing.sourceIds, ...incoming.sourceIds])].slice(0, 60),
      conversationIds: [...new Set([...(existing.conversationIds ?? []), ...(incoming.conversationIds ?? [])])].slice(0, 30),
      firstObservedAt: earliestObserved([existing.firstObservedAt, incoming.firstObservedAt]),
      lastObservedAt: latestObserved([existing.lastObservedAt, incoming.lastObservedAt]),
      portrait: incoming.portrait ?? existing.portrait,
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
  return changed ? { ...current, people } : current
}

function App() {
  const [data, setData] = useState<AppData>(loadData)
  const [intelHydrated, setIntelHydrated] = useState(false)
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
  const shellRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef(data)
  const sharedReadyRef = useRef(false)
  const sharedUpdatedAtRef = useRef('')
  const skipSharedWriteRef = useRef(false)
  const sharedWriteTimerRef = useRef<number | undefined>(undefined)
  const settingsReadyRef = useRef(false)
  const settingsWriteTimerRef = useRef<number | undefined>(undefined)
  const pendingPersonConsolidationsRef = useRef(new Set<string>())
  const personConsolidationRetriesRef = useRef(new Map<string, number>())
  const peopleAnalysisAbortRef = useRef<AbortController | null>(null)
  const prefetchedAvatarUrlsRef = useRef(new Set<string>())
  const taskGuidanceBootstrapRef = useRef(false)
  const taskGuidanceInFlightRef = useRef(new Set<string>())
  const [taskGuidanceRefreshTick, setTaskGuidanceRefreshTick] = useState(0)
  const effectiveProfile = appearancePreview?.profile ?? data.profile
  const effectiveAppearance = normalizeAppearance(appearancePreview?.appearance ?? data.appearance)
  const visualMotion = effectiveAppearance.performanceVersion === 1 && effectiveAppearance.motionEnabled
  const questsWithEvidence = useMemo(() => enrichQuestCharacters(restoreQuestEvidence(data.quests, data.aiCandidates), data.aiCandidates, data.people, data.intel), [data.aiCandidates, data.intel, data.people, data.quests])

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
    void loadSharedSettings().then((settings) => {
      if (!active) return
      if (settings.initialized) {
        setData((current) => ({
          ...current,
          profile: settings.profile,
          appearance: settings.appearance,
          aiSettings: settings.aiSettings,
        }))
      } else {
        void saveSharedSettings({ profile: data.profile, appearance: data.appearance, aiSettings: data.aiSettings }).catch(() => undefined)
      }
    }).catch(() => {
      // The browser cache remains usable when the optional local proxy is offline.
    }).finally(() => { if (active) settingsReadyRef.current = true })
    return () => { active = false }
    // This seeds a new INI from the current browser state exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!settingsReadyRef.current) return
    if (settingsWriteTimerRef.current) window.clearTimeout(settingsWriteTimerRef.current)
    settingsWriteTimerRef.current = window.setTimeout(() => {
      void saveSharedSettings({ profile: data.profile, appearance: data.appearance, aiSettings: data.aiSettings }).catch(() => undefined)
    }, 350)
    return () => { if (settingsWriteTimerRef.current) window.clearTimeout(settingsWriteTimerRef.current) }
  }, [data.aiSettings, data.appearance, data.profile])

  useEffect(() => {
    let active = true
    void loadIntelSnapshot()
      .then((snapshot) => {
        if (active && snapshot) setData((current) => {
          const next = { ...current, intel: snapshot, archive: { ...summarizeArchive(snapshot), lastImport: current.archive.lastImport, lastAnalysis: current.archive.lastAnalysis } }
          return dismissInvalidAiCandidates(mergePeople(
            { ...next, people: enrichPeopleEvidence(next.people, snapshot) },
            buildDirectConversationFallbackPeople(snapshot),
          ))
        })
      })
      .catch(() => {
        // IndexedDB is an enhancement; the in-memory queue remains usable.
      })
      .finally(() => { if (active) setIntelHydrated(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (intelHydrated) void saveIntelSnapshot(data.intel)
  }, [data.intel, intelHydrated])

  useEffect(() => {
    if (!intelHydrated) return
    let active = true
    void loadSharedSnapshot().then((snapshot) => {
      if (!active) return
      if (snapshot.data && snapshot.updatedAt) {
        const snapshotData = snapshot.data
        sharedUpdatedAtRef.current = snapshot.updatedAt
        const keepPeople = snapshotData.peopleModelVersion === 3 && Array.isArray(snapshotData.people)
        skipSharedWriteRef.current = keepPeople
        setData((current) => {
          const next: AppData = { ...current, ...snapshotData, people: keepPeople ? snapshotData.people : [], intel: current.intel, peopleModelVersion: 3 }
          return dismissInvalidAiCandidates(mergePeople(
            { ...next, people: enrichPeopleEvidence(next.people, current.intel) },
            buildDirectConversationFallbackPeople(current.intel),
          ))
        })
      } else {
        // Seed durable task data even before chat records are available. This
        // path intentionally omits raw intel so huge archives cannot block it.
        void saveSharedSnapshot(data).then((saved) => { sharedUpdatedAtRef.current = saved.updatedAt ?? '' }).catch(() => undefined)
      }
    }).catch(() => undefined).finally(() => {
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
      void saveSharedSnapshot(snapshot).then((saved) => { sharedUpdatedAtRef.current = saved.updatedAt ?? '' }).catch(() => undefined)
    }, 250)
  }, [data, intelHydrated, sharedReady])

  useEffect(() => () => {
    if (sharedWriteTimerRef.current) window.clearTimeout(sharedWriteTimerRef.current)
    if (!sharedReadyRef.current) return
    // A renderer can close after another browser/desktop instance has already
    // written newer data. Compare the shared version before flushing so a stale
    // page cannot resurrect an old snapshot during unmount.
    void loadSharedMeta().then((meta) => {
      if (meta.updatedAt && meta.updatedAt > sharedUpdatedAtRef.current) return
      return saveSharedSnapshot(dataRef.current).then((saved) => {
        sharedUpdatedAtRef.current = saved.updatedAt ?? sharedUpdatedAtRef.current
      })
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!intelHydrated) return
    const timer = window.setInterval(() => {
      void loadSharedMeta().then((meta) => {
        if (!meta.updatedAt || meta.updatedAt <= sharedUpdatedAtRef.current) return
        return loadSharedSnapshot().then((snapshot) => {
          const snapshotData = snapshot.data
          if (!snapshotData || !snapshot.updatedAt || snapshot.updatedAt <= sharedUpdatedAtRef.current) return
          sharedUpdatedAtRef.current = snapshot.updatedAt
          const keepPeople = snapshotData.peopleModelVersion === 3 && Array.isArray(snapshotData.people)
          skipSharedWriteRef.current = keepPeople
          setData((current) => {
            const next: AppData = { ...current, ...snapshotData, people: keepPeople ? snapshotData.people : [], intel: current.intel, peopleModelVersion: 3 }
            return dismissInvalidAiCandidates(mergePeople(
              { ...next, people: enrichPeopleEvidence(next.people, current.intel) },
              buildDirectConversationFallbackPeople(current.intel),
            ))
          })
        })
      }).catch(() => undefined)
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

  useEffect(() => {
    if (!intelHydrated || !sharedReady) return
    const snapshot = dataRef.current
    const eligible = questsWithEvidence
      .filter((quest) => quest.status === 'available' || quest.status === 'active')
      .map((quest) => ({ quest, signature: taskGuidanceSignature(quest, snapshot.people) }))
      .filter((item) => Boolean(item.signature))

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

    taskGuidanceInFlightRef.current.add(next.quest.id)
    void (async () => {
      const attemptedAt = new Date().toISOString()
      try {
        const status = await getAiStatus()
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
        const signature = taskGuidanceSignature(effectiveQuest, latest.people)
        if (!signature || signature !== next.signature) return
        const place = latest.places.find((item) => item.id === effectiveQuest.locationId)
        const people = latest.people.filter((person) => effectiveQuest.characterIds.includes(person.id))
        const weather = await fetchTaskWeather(place, effectiveQuest.startAt ?? effectiveQuest.dueAt)
        const result = await generateTaskGuidance({ quest: effectiveQuest, place, people, weather, settings: latest.aiSettings })
        const updatedAt = new Date().toISOString()
        setData((current) => ({
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
        }))
      } catch {
        // Record the attempt so temporary provider failures retry on the next
        // periodic pass rather than looping in the current render cycle.
        setData((current) => ({
          ...current,
          quests: current.quests.map((quest) => quest.id === next.quest.id
            ? { ...quest, guidanceRefreshAttemptedAt: attemptedAt }
            : quest),
        }))
      } finally {
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
    setData((current) => {
      const signature = quest.guidanceEvidenceSignature ?? (taskGuidanceSignature(quest, current.people) || undefined)
      const nextQuest = { ...quest, guidanceEvidenceSignature: signature }
      return { ...current, quests: current.quests.some((item) => item.id === quest.id) ? current.quests.map((item) => item.id === quest.id ? nextQuest : item) : [...current.quests, nextQuest] }
    })
    setEditingQuest(undefined)
    setView('quests')
  }

  const generateQuestGuidance = async (quest: Quest) => {
    const snapshot = dataRef.current
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
    setData((current) => ({
      ...current,
      quests: current.quests.map((item) => item.id === quest.id
        ? {
          ...item,
          characterIds: quest.characterIds,
          guidance: result.guidance,
          guidanceEvidenceSignature: taskGuidanceSignature(quest, current.people),
          guidanceUpdatedAt: new Date().toISOString(),
        }
        : item),
    }))
  }

  const deleteQuest = (id: string) => {
    const candidateId = id.startsWith('q-ai-') ? id.slice(5) : undefined
    setData((current) => ({
      ...current,
      quests: current.quests.filter((quest) => quest.id !== id),
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

  const importIntel = (items: IntelItem[]): IntelImportResult => {
    let result: IntelImportResult = { added: 0, updated: 0, duplicates: items.length, archiveMessageCount: dataRef.current.intel.length, conversationCount: dataRef.current.archive.conversationCount }
    setData((current) => {
      const messageBody = (item: IntelItem) => (item.content || item.summary).replace(/^[^:]{1,64}:\s+/, '').trim()
      const exactKey = (item: IntelItem) => `${item.source}|${item.conversationId ?? ''}|${item.capturedAt}|${item.speaker ?? ''}|${messageBody(item)}`
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
      const baseArchive = summarizeArchive(intel)
      const archive = archiveSummaryWithImport({ ...baseArchive, lastAnalysis: current.archive.lastAnalysis }, {
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
    if (data.places.length <= 1) return
    const remaining = data.places.filter((place) => place.id !== id)
    const fallbackId = remaining[0]?.id ?? ''
    setData((current) => ({
      ...current,
      places: current.places.filter((place) => place.id !== id),
      quests: current.quests.map((quest) => quest.locationId === id ? { ...quest, locationId: fallbackId } : quest),
    }))
    setSelectedPlaceId((current) => current === id ? fallbackId : current)
  }

  const consolidatePeopleIfNeeded = (source: Person[] = dataRef.current.people) => {
    source.filter((person) => person.facts.length > PERSON_FACT_DISPLAY_LIMIT).forEach((person) => {
      if (pendingPersonConsolidationsRef.current.has(person.id)) return
      const retryCount = personConsolidationRetriesRef.current.get(person.id) ?? 0
      if (retryCount >= 3) return
      pendingPersonConsolidationsRef.current.add(person.id)
      personConsolidationRetriesRef.current.set(person.id, retryCount + 1)
      const submittedFacts = new Set(person.facts)
      let needsAnotherPass = false
      let failed = false
      void consolidatePerson(person, dataRef.current.aiSettings).then((consolidated) => {
        if (!consolidated) return
        setData((current) => {
          const index = current.people.findIndex((candidate) => candidate.id === person.id)
          if (index < 0) return current
          const existing = current.people[index]
          // Keep facts added while the model request was in flight, then run a
          // second compacting pass if the buffer is still over the limit.
          const factsAddedDuringRequest = existing.facts.filter((fact) => !submittedFacts.has(fact))
          const mergedFacts = [...new Set([...consolidated.facts, ...factsAddedDuringRequest])].slice(0, PERSON_FACT_BUFFER_LIMIT)
          needsAnotherPass = mergedFacts.length > PERSON_FACT_DISPLAY_LIMIT
          const nextPerson: Person = {
            ...existing,
            facts: mergedFacts,
            preferences: consolidated.preferences.length ? consolidated.preferences : existing.preferences,
            advice: consolidated.advice.length ? consolidated.advice : existing.advice,
            portrait: consolidated.portrait ?? existing.portrait,
            model: consolidated.model,
          }
          if (JSON.stringify(existing) === JSON.stringify(nextPerson)) return current
          const people = [...current.people]
          people[index] = nextPerson
          return { ...current, people }
        })
      }).catch(() => {
        // Keeping cited statements is safer than replacing them after a
        // transient provider failure. The next new fact can retry later.
        failed = true
      }).finally(() => {
        pendingPersonConsolidationsRef.current.delete(person.id)
        if (failed || !needsAnotherPass) {
          personConsolidationRetriesRef.current.delete(person.id)
          return
        }
        if ((personConsolidationRetriesRef.current.get(person.id) ?? 0) < 3) window.setTimeout(() => consolidatePeopleIfNeeded(), 0)
      })
    })
  }

  const mergeIncomingPeople = (additions: Person[]) => {
    if (!additions.length) return
    additions.forEach((person) => personConsolidationRetriesRef.current.delete(person.id))
    setData((current) => mergePeople(current, additions))
    window.setTimeout(() => consolidatePeopleIfNeeded(), 0)
  }

  const appendPeopleDebug = (entry: AiDebugEntry) => {
    window.dispatchEvent(new CustomEvent<AiDebugEntry>('theia:ai-debug', { detail: entry }))
  }

  const saveAiAnalysis = (candidates: AiTaskCandidate[], analyzedIds: string[], settings: AiSettings, analysis: Omit<ArchiveAnalysisSummary, 'analyzedAt'>) => {
    setData((current) => {
      const existing = new Set(current.aiCandidates.map((candidate) => `${candidate.title}|${candidate.description}`))
      const unique = candidates.filter((candidate) => !existing.has(`${candidate.title}|${candidate.description}`))
      const analyzed = new Set(analyzedIds)
      return {
        ...current,
        aiCandidates: [...unique, ...current.aiCandidates],
        aiSettings: { ...settings, lastRunAt: new Date().toISOString(), intervalHours: Math.max(24, settings.intervalHours) },
        archive: archiveSummaryWithAnalysis(current.archive, { ...analysis, analyzedAt: new Date().toISOString() }),
        intel: current.intel.map((item) => analyzed.has(item.id) ? { ...item, aiAnalyzedAt: new Date().toISOString() } : item),
      }
    })
    // Only completed task conversations enter the people pass. This keeps a
    // stopped extraction from quietly continuing through unrelated chats.
    // Local export-verified cards only establish that a direct conversation
    // exists. They must not suppress the model pass that provides the actual
    // portrait, preference signals, and evidence-backed interaction advice.
    const snapshot = dataRef.current
    const coveredConversationIds = new Set([
      ...snapshot.dismissedPersonConversationIds,
      ...snapshot.people
      .filter((person) => !isLocalExportVerifiedPerson(person))
      .flatMap((person) => person.conversationIds ?? []),
    ])
    const analyzed = new Set(analyzedIds)
    const sourceRecords = selectPeopleEvidence(snapshot.intel.filter((item) => analyzed.has(item.id)), coveredConversationIds)
    if (!sourceRecords.length) return
    peopleAnalysisAbortRef.current?.abort()
    const controller = new AbortController()
    peopleAnalysisAbortRef.current = controller
    setAnalysisWork({
      stage: 'people',
      completed: 0,
      total: 0,
      candidates: 0,
      message: `正在准备人物提炼：将处理 ${new Set(sourceRecords.map((item) => item.conversationId)).size} 个私聊对话。`,
    })
    void analyzePeople(sourceRecords, (progress) => {
      const segment = progress.totalSegmentsInConversation
        ? `“${progress.currentConversation ?? '当前私聊'}” ${progress.currentSegment}/${progress.totalSegmentsInConversation}`
        : progress.currentConversation ?? '当前私聊'
      setAnalysisWork({
        stage: 'people',
        completed: progress.completed,
        total: progress.total,
        candidates: progress.candidates,
        message: `正在提炼人物：${segment}；已保留 ${progress.candidates} 张人物卡。`,
      })
    }, mergeIncomingPeople, appendPeopleDebug, dataRef.current.aiSettings, { signal: controller.signal, concurrency: 2 }).then(() => {
      window.setTimeout(() => consolidatePeopleIfNeeded(), 0)
    }).catch(() => {
      // A failed person pass does not invalidate the task candidates already produced.
    }).finally(() => {
      if (peopleAnalysisAbortRef.current !== controller) return
      peopleAnalysisAbortRef.current = null
      setAnalysisWork((current) => current?.stage === 'people' ? null : current)
    })
  }

  const stopPeopleAnalysis = () => {
    const controller = peopleAnalysisAbortRef.current
    if (!controller) return
    setAnalysisWork((current) => current?.stage === 'people'
      ? { ...current, message: '正在停止人物提炼；已写入本地的人物卡会保留。' }
      : current)
    appendPeopleDebug({ at: new Date().toISOString(), event: 'people_run_cancelled', level: 'warn', message: '用户停止人物提炼；已经写入本地的人物卡会保留。' })
    controller.abort()
  }

  const clearAllPeople = () => {
    stopPeopleAnalysis()
    setData((current) => ({
      ...current,
      people: [],
      dismissedPersonConversationIds: [...new Set([
        ...current.dismissedPersonConversationIds,
        ...current.intel
          .filter((item) => item.conversationKind === 'direct' && item.conversationId)
          .map((item) => item.conversationId as string),
      ])],
    }))
    setSelectedPersonId('')
  }

  const clearAllQuests = () => {
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
    const locationFor = (candidate: AiTaskCandidate) => {
      const target = candidate.place?.toLowerCase()
      return snapshot.places.find((place) => target && (place.name.toLowerCase().includes(target) || target.includes(place.name.toLowerCase())))?.id ?? ''
    }
    const personIdsFor = (candidate: AiTaskCandidate) => snapshot.people.filter((person) => candidate.people.some((name) => person.name.includes(name) || name.includes(person.name))).map((person) => person.id)
    const usedIds = new Set(snapshot.quests.map((quest) => quest.id))
    const created = candidates
      .filter((candidate) => candidate.status === 'pending' && !usedIds.has(`q-ai-${candidate.id}`))
      .map((candidate): Quest => {
        const sourceItems = snapshot.intel.filter((item) => candidate.sourceIds.includes(item.id))
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
    const createdIds = new Set(created.map((quest) => quest.id.replace(/^q-ai-/, '')))
    setData((current) => ({
      ...current,
      quests: [...current.quests, ...created],
      aiCandidates: current.aiCandidates.map((candidate) => createdIds.has(candidate.id) ? { ...candidate, status: 'created' } : candidate),
      intel: current.intel.map((item) => candidates.some((candidate) => candidate.sourceIds.includes(item.id)) ? { ...item, status: 'reviewed' } : item),
      aiSettings: appendTaskFeedback(current.aiSettings, candidates.filter((candidate) => createdIds.has(candidate.id)).map((candidate) => feedbackEntry(candidate, 'accepted', 'useful'))),
    }))
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
    setData((current) => {
      const removed = current.people.filter((person) => dismissed.has(person.id))
      return {
        ...current,
        people: current.people.filter((person) => !dismissed.has(person.id)),
        dismissedPersonConversationIds: [...new Set([
          ...current.dismissedPersonConversationIds,
          ...removed.flatMap((person) => person.conversationIds ?? []),
        ])],
      }
    })
    if (dismissed.has(selectedPersonId)) setSelectedPersonId('')
  }

  const resetDemoData = () => {
    resetData()
    setData(seedData)
    setSelectedPlaceId(seedData.places[0]?.id ?? '')
    setSelectedPersonId(seedData.people[0]?.id ?? '')
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
      <Sidebar profile={effectiveProfile} active={view} open={sidebarOpen} onChange={setView} onClose={() => setSidebarOpen(false)} onReset={resetDemoData} newIntelCount={data.intel.filter((item) => item.status === 'new').length} />
      <main className="main-shell">
        <Topbar view={view} profile={effectiveProfile} onMenu={() => setSidebarOpen(true)} onNewQuest={() => { setEditingQuest(undefined); setQuestModalOpen(true) }} />
        <div className={`view-container view-container--${view}`}>
          {view === 'quests' && <TaskMapView profile={effectiveProfile} quests={questsWithEvidence} places={data.places} people={data.people} intel={data.intel} atlas={data.atlas} onToggle={toggleQuest} onEdit={(quest) => { setEditingQuest(quest); setQuestModalOpen(true) }} onViewSource={setSourceQuest} onDelete={deleteQuest} onGenerateGuidance={generateQuestGuidance} onArrange={arrangeTaskAtlas} onMoveCategory={moveTaskAtlasCategory} />}
          {view === 'timeline' && <TimelineView quests={questsWithEvidence} places={data.places} intel={data.intel} onToggle={toggleQuest} onEdit={(quest) => { setEditingQuest(quest); setQuestModalOpen(true) }} onViewSource={setSourceQuest} onDelete={deleteQuest} />}
          {view === 'map' && <MapView places={data.places} quests={questsWithEvidence} selectedPlaceId={selectedPlaceId} onSelect={setSelectedPlaceId} onUpdatePlace={updatePlace} onCreatePlace={createPlace} onDeletePlace={deletePlace} />}
          {view === 'people' && <PeopleView people={data.people} quests={questsWithEvidence} selectedId={selectedPersonId} onSelect={setSelectedPersonId} onGoIntel={() => setView('intel')} onDismiss={dismissPeople} intelCount={data.intel.length} intel={data.intel} />}
          {view === 'settings' && <OptionsView settings={data.aiSettings} onSettingsChange={(aiSettings) => setData((current) => dismissInvalidAiCandidates({ ...current, aiSettings }))} onAppearance={() => setAppearanceModalOpen(true)} personCount={data.people.length} questCount={data.quests.length} onClearPeople={clearAllPeople} onClearQuests={clearAllQuests} />}
          <div className={`persistent-intel-view ${view === 'intel' ? 'is-active' : ''}`} aria-hidden={view !== 'intel'}>
            <IntelView items={data.intel} archive={data.archive} candidates={data.aiCandidates} aiSettings={data.aiSettings} onImport={importIntel} onAiAnalysis={saveAiAnalysis} onDirectPeopleDetected={mergeIncomingPeople} onCreateAiQuests={createQuestsFromAi} onDismissAiCandidates={dismissAiCandidates} onAnalysisWorkChange={(next) => setAnalysisWork((current) => next === null && current?.stage === 'people' ? current : next)} />
          </div>
        </div>
      </main>
      {analysisWork && (view !== 'intel' || analysisWork.stage === 'people') && <div className="analysis-float-wrap"><button type="button" className="analysis-float" onClick={() => setView('intel')}>
        <Sparkles size={18} />
        <span><strong>{analysisWork.stage === 'people' ? '正在提炼人物' : '正在按对话提炼'}</strong><small title={analysisWork.message}>{analysisWork.message}</small></span>
      </button>{analysisWork.stage === 'people' && <button type="button" className="analysis-float-stop" title="停止人物提炼并保留已有卡片" aria-label="停止人物提炼并保留已有卡片" onClick={stopPeopleAnalysis}><CircleStop size={16} /></button>}</div>}
      <QuestModal key={`quest-${editingQuest?.id ?? 'new'}-${questModalOpen ? 'open' : 'closed'}`} open={questModalOpen} places={data.places} people={data.people} quest={editingQuest} onClose={() => { setQuestModalOpen(false); setEditingQuest(undefined) }} onSave={createQuest} />
      <QuestSourceModal quest={sourceQuest} intel={data.intel} onClose={() => setSourceQuest(undefined)} />
      <AppearanceModal key={`appearance-${appearanceModalOpen ? 'open' : 'closed'}`} open={appearanceModalOpen} name={data.profile.name} avatarUrl={data.profile.avatarUrl} appearance={effectiveAppearance} onClose={() => { setAppearancePreview(null); setAppearanceModalOpen(false) }} onPreview={({ name, avatarUrl, appearance }) => setAppearancePreview({ profile: { name, avatarUrl }, appearance })} onSave={({ name, avatarUrl, appearance }) => { setAppearancePreview(null); setData((current) => ({ ...current, profile: { ...current.profile, name, avatarUrl }, appearance })) }} />
    </div>
  )
}

export default App

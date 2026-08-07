import { createSeedData, seedData } from '../seed.ts'
import type { AiAnalysisWatermarks, AiExtractionCheckpoint, AiPromptInstructions, AiSettings, AppData } from '../types.ts'
import { normalizeAppearance } from './appearance.ts'
import { summarizeArchive } from './archiveSummary.ts'
import { DEFAULT_AI_CONCURRENCY, normalizeAiConcurrency } from './aiConcurrency.ts'
import { defaultMultiModelSettings, normalizeMultiModelSettings } from './multiModel.ts'
import { PERSON_PORTRAIT_PIPELINE_VERSION } from './personTemporal.ts'
import { recoverArray } from './storageRecovery.ts'
import { APP_STORAGE_SCHEMA, unwrapAppStorage, wrapAppStorage } from './storageSchema.ts'
import { normalizeDailyCheckIns } from './selfJournal.ts'
import { normalizeContextEvents } from './contextEvents.ts'

const STORAGE_KEY = 'hyperion:v1'
const STORAGE_ROLLBACK_KEY = 'hyperion:v1:rollback'
const LEGACY_STORAGE_KEY = 'theia:v1'

export const defaultPromptInstructions: AiPromptInstructions = {
  task: '优先保留仍需你处理、具体可执行的安排。约见、返校、报名、缴费、回复、预约、截止事项优先；闲聊、历史通知、已过期事项不输出。',
  people: '只提取对方自己明确说过的信息。优先保留能帮助你更好相处的明确边界、沟通方式、重复偏好和长期变化。偏好要保留证据强度：单次表达只是“曾有正向评价”，不是稳定习惯或性格。',
  peopleMerge: '把已核验事实与关键互动事件整理成自然、有人味但克制的人物理解：优先写对方如何沟通、明确在意或拒绝什么、重复出现的偏好、重要的一次性事件、互动方式和有证据的变化或延续；不要写关系分数、心理诊断或武断性格标签。建议必须帮助你尊重对方选择、先确认再行动、留出拒绝空间，并且每条都能回到证据。允许使用人物底稿与日期明确的时间线注记，但必须与聊天事实分开。证据覆盖不到的方面直接省略。',
  taskGuidance: '建议要具体、尊重边界，优先给出可执行的准备、确认、倾听和备选方案。涉及他人时先保护对方选择权，避免催促、试探和操控。不足时建议优先补充时间、地点或对方当前偏好。',
  selfObservation: 'Only extract self-authored statements that can be traced to an exact source. Preserve events, actions, expressed feelings, decisions, routines, stressors, coping, and changes without turning one moment into a stable trait or diagnosis.',
  selfMerge: 'Write a detailed, chronological, non-diagnostic self analysis from verified observations only. Explain what happened, what I did, what I expressed, and what changed. Professional terms are optional explanatory context, never medical conclusions, and must stay tied to evidence.',
}

export const defaultAiSettings: AiSettings = {
  mode: 'balanced',
  instructions: '只把明确可执行、对现实生活有帮助的事项整理成任务；不要臆测隐私或制造压力。',
  autoEnabled: false,
  intervalHours: 24,
  autoTriggerMode: 'either',
  incrementalMessageCount: 50,
  recencyPolicy: 'balanced',
  concurrency: DEFAULT_AI_CONCURRENCY,
  feedback: [],
  promptInstructions: defaultPromptInstructions,
  multiModel: defaultMultiModelSettings,
}

function normalizeWatermarkGroup(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const entries: Array<[string, string]> = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => entry[0].length > 0 && entry[0].length <= 240 && typeof entry[1] === 'string' && entry[1].length <= 160)
    .slice(-20_000)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function normalizeAnalysisWatermarks(value: unknown): AiAnalysisWatermarks | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<AiAnalysisWatermarks>
  const tasks = normalizeWatermarkGroup(input.tasks)
  const people = normalizeWatermarkGroup(input.people)
  return tasks || people ? { ...(tasks ? { tasks } : {}), ...(people ? { people } : {}) } : undefined
}

function normalizeInterruptedRun(value: unknown): AiExtractionCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const checkpoint = value as Partial<AiExtractionCheckpoint>
  if (checkpoint.version !== 1 || !['tasks', 'people', 'self'].includes(String(checkpoint.stage))) return undefined
  const targets = {
    tasks: checkpoint.targets?.tasks === true,
    people: checkpoint.targets?.people === true,
    self: checkpoint.targets?.self === true,
  }
  if (!targets.tasks && !targets.people && !targets.self) return undefined
  const conversationIds = Array.isArray(checkpoint.conversationIds)
    ? [...new Set(checkpoint.conversationIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(-10_000))]
    : []
  if (!conversationIds.length) return undefined
  const allowedIds = new Set(conversationIds)
  const completedConversationIds = Array.isArray(checkpoint.completedConversationIds)
    ? [...new Set(checkpoint.completedConversationIds.filter((id): id is string => typeof id === 'string' && allowedIds.has(id)).slice(-10_000))]
    : []
  const scope = ['unprocessed', 'new', 'all'].includes(String(checkpoint.scope)) ? checkpoint.scope as AiExtractionCheckpoint['scope'] : 'all'
  const timelineMode = ['last-chat', 'strict-window'].includes(String(checkpoint.timelineMode)) ? checkpoint.timelineMode as AiExtractionCheckpoint['timelineMode'] : 'last-chat'
  const date = (candidate: unknown) => typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : undefined
  return {
    version: 1,
    stage: checkpoint.stage as AiExtractionCheckpoint['stage'],
    targets,
    scope,
    timelineMode,
    ...(date(checkpoint.timelineStart) ? { timelineStart: date(checkpoint.timelineStart) } : {}),
    ...(date(checkpoint.timelineEnd) ? { timelineEnd: date(checkpoint.timelineEnd) } : {}),
    ...(typeof checkpoint.conversationId === 'string' && allowedIds.has(checkpoint.conversationId) ? { conversationId: checkpoint.conversationId } : {}),
    conversationIds,
    completedConversationIds,
    startedAt: typeof checkpoint.startedAt === 'string' ? checkpoint.startedAt.slice(0, 80) : new Date().toISOString(),
    ...(typeof checkpoint.pausedAt === 'string' ? { pausedAt: checkpoint.pausedAt.slice(0, 80) } : {}),
  }
}

export function loadData(): AppData {
  try {
    const currentSaved = localStorage.getItem(STORAGE_KEY)
    const legacySaved = currentSaved ? null : localStorage.getItem(LEGACY_STORAGE_KEY)
    const saved = currentSaved ?? legacySaved
    if (!saved) return createSeedData()
    if (legacySaved) {
      // Keep the old key untouched until a later save succeeds. This makes a
      // brand migration recoverable even if browser storage is quota-limited.
      try { localStorage.setItem(STORAGE_KEY, legacySaved) } catch { /* The legacy key remains available. */ }
    }
    const decoded = JSON.parse(saved) as unknown
    const unwrapped = unwrapAppStorage<Omit<AppData, 'peopleModelVersion'> & { peopleModelVersion?: number }>(decoded)
    if (unwrapped.migratedFrom === 0 && !localStorage.getItem(STORAGE_ROLLBACK_KEY)) {
      // Keep one untouched copy of the pre-schema payload. It is deliberately
      // not rewritten on every save and can be restored by support tooling.
      try { localStorage.setItem(STORAGE_ROLLBACK_KEY, saved) } catch { /* Optional rollback copy. */ }
    }
    const parsed = unwrapped.data
    // Version 5 invalidates free-form portraits. Only structured paragraphs
    // with claim IDs survive; verified claims, avatars, and profile notes stay.
    const isModelPeople = [3, 4, 5].includes(Number(parsed.peopleModelVersion))
    const people = isModelPeople && Array.isArray(parsed.people)
      ? parsed.people.map((person) => {
        const portraitSchemaVersion = Number(person?.portraitSchemaVersion)
        const hasStructuredPortrait = portraitSchemaVersion >= 1
          && portraitSchemaVersion <= PERSON_PORTRAIT_PIPELINE_VERSION
          && Array.isArray(person?.portraitBlocks)
          && person.portraitBlocks.length > 0
        const hasProfileBasis = hasStructuredPortrait && Boolean(person?.profileNotes?.trim()) && person?.profileNotesUsed === true && Boolean(person?.portrait?.trim())
        const hasChatBasis = Array.isArray(person?.evidence) && person.evidence.length > 0
        // Preserve only the new structured portrait; old prose is regenerated.
        if (hasProfileBasis) return person
        if (hasStructuredPortrait && hasChatBasis && person.portrait && Array.isArray(person.portraitSourceIds) && person.portraitSourceIds.length >= 2) return person
        return { ...person, portrait: undefined, portraitBlocks: [], portraitCoverage: undefined, portraitSchemaVersion: undefined, portraitSourceIds: [], profileNotesUsed: undefined, advice: [], portraitEvidenceSignature: undefined }
      })
      : []
    const peopleIds = new Set(people.map((person) => person.id))
    const quests = Array.isArray(parsed.quests)
      ? parsed.quests.map((quest) => {
        const existingIds = Array.isArray(quest.characterIds) ? quest.characterIds : []
        const characterIds = existingIds
          .filter((id): id is string => typeof id === 'string' && peopleIds.has(id))
        return Array.isArray(quest.characterIds) && characterIds.length === existingIds.length ? quest : { ...quest, characterIds }
      })
      : []
    const interruptedRun = normalizeInterruptedRun(parsed.aiSettings?.interruptedRun)
    const analysisWatermarks = normalizeAnalysisWatermarks(parsed.aiSettings?.analysisWatermarks)
    const promptInstructions = {
      ...defaultPromptInstructions,
      ...(parsed.aiSettings?.promptInstructions ?? {}),
    }
    if (promptInstructions.people === '只提取对方自己明确说过的信息。偏好要保留证据强度：单次表达只是“曾有正向评价”，不是稳定习惯或性格。'
      || promptInstructions.people === '只提取对方自己明确说过的信息。单次表达只能写成“曾表示”或“有过单次评价”，不能升级为稳定习惯或性格。') {
      promptInstructions.people = defaultPromptInstructions.people
    }
    if (promptInstructions.peopleMerge === '仅根据已核验事实收敛人物刻画。结论不足时明确说需要更多信息，不要用套话补齐。'
      || promptInstructions.peopleMerge === '只根据已核验事实收敛人物刻画。信息不足时明确说明需要更多信息源，不要用套话补齐。') {
      promptInstructions.peopleMerge = defaultPromptInstructions.peopleMerge
    }
    if (promptInstructions.taskGuidance === '建议要具体、尊重边界，优先给出可执行的准备、确认和备选方案。不足时建议优先补充时间、地点或对方偏好。'
      || promptInstructions.taskGuidance === '建议应具体、尊重边界，优先给出准备、确认和备选方案。信息不足时先建议补充时间、地点或对方偏好。') {
      promptInstructions.taskGuidance = defaultPromptInstructions.taskGuidance
    }
    return {
      ...parsed,
      // Historical builds kept every raw chat row in localStorage. That makes
      // the initial React state enormous even though IndexedDB/the local
      // archive store are now authoritative. Preserve the derived archive
      // summary below, but never revive those message bodies into the UI.
      intel: [],
      // Old versions derived a person card from every sender/alias while importing.
      // This can be both misleading and prohibitively expensive for large exports.
      people,
      // Repair tasks that still point at cards deleted by an older build.
      quests,
      dismissedPersonConversationIds: Array.isArray(parsed.dismissedPersonConversationIds)
        ? parsed.dismissedPersonConversationIds.filter((id): id is string => typeof id === 'string').slice(-10_000)
        : [],
      // Version 5 removes legacy person-card suppression state. Keep the
      // stored marker so the one-time migration does not run on every launch.
      peopleDismissalVersion: Number(parsed.peopleDismissalVersion) >= 5
        ? 5
        : Number(parsed.peopleDismissalVersion) >= 3 ? Number(parsed.peopleDismissalVersion) : undefined,
      peopleModelVersion: 5,
      dailyCheckins: normalizeDailyCheckIns(parsed.dailyCheckins),
      contextEvents: normalizeContextEvents(parsed.contextEvents),
      archive: parsed.archive?.version === 1 ? parsed.archive : summarizeArchive(Array.isArray(parsed.intel) ? parsed.intel : []),
      // Created candidates are a temporary review archive. Their source IDs
      // are already stored on the quest, so do not restore this duplicate list.
      aiCandidates: Array.isArray(parsed.aiCandidates) ? parsed.aiCandidates.filter((candidate) => candidate?.status !== 'created') : [],
      aiSettings: {
        ...defaultAiSettings,
        ...(parsed.aiSettings ?? {}),
        intervalHours: Math.min(720, Math.max(1, Number(parsed.aiSettings?.intervalHours ?? defaultAiSettings.intervalHours) || defaultAiSettings.intervalHours)),
        autoTriggerMode: ['time', 'message-count', 'either'].includes(String(parsed.aiSettings?.autoTriggerMode))
          ? parsed.aiSettings?.autoTriggerMode as AiSettings['autoTriggerMode']
          : defaultAiSettings.autoTriggerMode,
        incrementalMessageCount: Math.min(10_000, Math.max(1, Math.round(Number(parsed.aiSettings?.incrementalMessageCount ?? defaultAiSettings.incrementalMessageCount) || defaultAiSettings.incrementalMessageCount))),
        recencyPolicy: ['strict', 'balanced', 'broad'].includes(parsed.aiSettings?.recencyPolicy) ? parsed.aiSettings.recencyPolicy : 'balanced',
        concurrency: normalizeAiConcurrency(parsed.aiSettings?.concurrency),
        feedback: Array.isArray(parsed.aiSettings?.feedback) ? parsed.aiSettings.feedback.slice(-80) : [],
        promptInstructions,
        multiModel: normalizeMultiModelSettings(parsed.aiSettings?.multiModel),
        ...(analysisWatermarks ? { analysisWatermarks } : {}),
        ...(interruptedRun ? { interruptedRun } : {}),
      },
      appearance: normalizeAppearance(parsed.appearance),
      atlas: {
        categoryPositions: Object.fromEntries(Object.entries(parsed.atlas?.categoryPositions ?? {}).flatMap(([category, position]) => {
          if (!['campus', 'romance', 'friends', 'study', 'wellbeing', 'life'].includes(category)) return []
          const x = Number(position?.x)
          const y = Number(position?.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return []
          return [[category, { x: Math.min(93, Math.max(7, x)), y: Math.min(92, Math.max(8, y)) }]]
        })),
      },
      // A partially written or very old browser cache may not have a places
      // array. Recover the remaining task/person state instead of throwing and
      // replacing the entire workspace with demo data.
      places: recoverArray(parsed.places, seedData.places).map((place) => {
        const fallback = seedData.places.find((item) => item.id === place.id) ?? seedData.places[0]
        return {
          ...place,
          lat: typeof place.lat === 'number' ? place.lat : fallback.lat,
          lng: typeof place.lng === 'number' ? place.lng : fallback.lng,
          precision: place.precision === 'approximate' ? 'approximate' : 'exact',
          radiusMeters: place.precision === 'approximate' && Number.isFinite(Number(place.radiusMeters)) ? Math.min(100_000, Math.max(50, Number(place.radiusMeters))) : undefined,
        }
      }),
    }
  } catch {
    return createSeedData()
  }
}

function compactPeopleForQuota(data: AppData): AppData {
  const compactPeople = data.people.map((person) => {
    const evidence = Array.isArray(person.evidence)
      ? person.evidence.map((claim) => ({
        ...claim,
        text: claim.text.trim().slice(0, 360),
        quote: claim.quote.trim().slice(0, 140),
        sourceIds: [...new Set(Array.isArray(claim.sourceIds) ? claim.sourceIds : [])].slice(0, 12),
      }))
      : []
    const portraitBlocks = Array.isArray(person.portraitBlocks)
      ? person.portraitBlocks.slice(0, 8).map((block) => ({
        ...block,
        text: block.text.trim().slice(0, 1800),
        claimIds: [...new Set(block.claimIds)].slice(0, 12),
        sourceIds: [...new Set(block.sourceIds)].slice(0, 12),
      }))
      : []
    return {
      ...person,
      evidence,
      facts: Array.isArray(person.facts) ? person.facts : [],
      preferences: person.preferences ?? [],
      advice: (person.advice ?? []).slice(0, 9),
      sourceIds: [...new Set([...(Array.isArray(person.sourceIds) ? person.sourceIds : []), ...evidence.flatMap((claim) => Array.isArray(claim.sourceIds) ? claim.sourceIds : [])])],
      portraitBlocks,
      portrait: person.portrait?.trim().slice(0, 3_600),
      portraitFailure: person.portraitFailure?.trim().slice(0, 360),
      profileNotes: person.profileNotes?.trim().slice(0, 6_000),
    }
  })
  return { ...data, people: compactPeople }
}

export function saveData(data: AppData) {
  const payload = { ...data, intel: [] }
  try {
    // Chat exports can be thousands of records long. Keep the lightweight
    // dashboard state in localStorage; the raw intel queue lives in IndexedDB.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wrapAppStorage(payload)))
  } catch {
    // Browser quotas are commonly 5 MB. Retry once with compact claim text,
    // while preserving the complete fact/preference/evidence arrays; the
    // server snapshot remains the authoritative large-data store.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wrapAppStorage({ ...compactPeopleForQuota(data), intel: [] })))
    } catch {
      console.warn('本地存储空间不足，本次会话数据仍可使用，但刷新后可能无法完整恢复。')
    }
  }
}

export function resetData() {
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(STORAGE_ROLLBACK_KEY)
}

export function restoreRollbackData(): boolean {
  const backup = localStorage.getItem(STORAGE_ROLLBACK_KEY)
  if (!backup) return false
  // Refuse a backup that is already a current envelope; this key is reserved
  // for the untouched pre-migration representation.
  try {
    const parsed = JSON.parse(backup) as Record<string, unknown>
    if (parsed?.schema === APP_STORAGE_SCHEMA) return false
  } catch {
    return false
  }
  localStorage.setItem(STORAGE_KEY, backup)
  return true
}

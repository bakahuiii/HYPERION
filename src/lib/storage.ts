import { seedData } from '../seed'
import type { AiSettings, AppData } from '../types'
import { normalizeAppearance } from './appearance'
import { summarizeArchive } from './archiveSummary'
import { DEFAULT_AI_CONCURRENCY, normalizeAiConcurrency } from './aiConcurrency'

const STORAGE_KEY = 'theia:v1'

export const defaultPromptInstructions = {
  task: '优先保留仍需你处理、具体可执行的安排。约见、返校、报名、缴费、回复、预约、截止事项优先；闲聊、历史通知、已过期事项不输出。',
  people: '只提取对方自己明确说过的信息。偏好要保留证据强度：单次表达只是“曾有正向评价”，不是稳定习惯或性格。',
  peopleMerge: '仅根据已核验事实收敛人物刻画。结论不足时明确说需要更多信息，不要用套话补齐。',
  taskGuidance: '建议要具体、尊重边界，优先给出可执行的准备、确认和备选方案。不足时建议优先补充时间、地点或对方偏好。',
}

export const defaultAiSettings: AiSettings = {
  mode: 'balanced',
  instructions: '只把明确可执行、对现实生活有帮助的事项整理成任务；不要臆测隐私或制造压力。',
  autoEnabled: false,
  intervalHours: 24,
  recencyPolicy: 'balanced',
  concurrency: DEFAULT_AI_CONCURRENCY,
  feedback: [],
  promptInstructions: defaultPromptInstructions,
}

export function loadData(): AppData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return seedData
    const parsed = JSON.parse(saved) as AppData
    // Version 3 intentionally discards prior model cards. They did not retain
    // per-claim original quotes, so their wording cannot be verified safely.
    const isModelPeople = parsed.peopleModelVersion === 3
    return {
      ...parsed,
      // Old versions derived a person card from every sender/alias while importing.
      // This can be both misleading and prohibitively expensive for large exports.
      people: isModelPeople && Array.isArray(parsed.people) ? parsed.people : [],
      dismissedPersonConversationIds: Array.isArray(parsed.dismissedPersonConversationIds)
        ? parsed.dismissedPersonConversationIds.filter((id): id is string => typeof id === 'string').slice(-10_000)
        : [],
      peopleModelVersion: 3,
      archive: parsed.archive?.version === 1 ? parsed.archive : summarizeArchive(Array.isArray(parsed.intel) ? parsed.intel : []),
      aiCandidates: Array.isArray(parsed.aiCandidates) ? parsed.aiCandidates : [],
      aiSettings: {
        ...defaultAiSettings,
        ...(parsed.aiSettings ?? {}),
        intervalHours: Math.max(24, Number(parsed.aiSettings?.intervalHours ?? defaultAiSettings.intervalHours)),
        recencyPolicy: ['strict', 'balanced', 'broad'].includes(parsed.aiSettings?.recencyPolicy) ? parsed.aiSettings.recencyPolicy : 'balanced',
        concurrency: normalizeAiConcurrency(parsed.aiSettings?.concurrency),
        feedback: Array.isArray(parsed.aiSettings?.feedback) ? parsed.aiSettings.feedback.slice(-80) : [],
        promptInstructions: {
          ...defaultPromptInstructions,
          ...(parsed.aiSettings?.promptInstructions ?? {}),
        },
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
      places: parsed.places.map((place) => {
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
    return seedData
  }
}

export function saveData(data: AppData) {
  try {
    // Chat exports can be thousands of records long. Keep the lightweight
    // dashboard state in localStorage; the raw intel queue lives in IndexedDB.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, intel: [] }))
  } catch {
    console.warn('本地存储空间不足，本次会话数据仍可使用，但刷新后可能无法完整恢复。')
  }
}

export function resetData() {
  localStorage.removeItem(STORAGE_KEY)
}

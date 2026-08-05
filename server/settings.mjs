import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { runtimePaths } from './runtimePaths.mjs'
import { credentialStoreAvailable, deleteCredential, loadCredential, saveCredential } from './credentialStore.mjs'

const { settingsPath, legacyProviderPath, backgroundDirectoryPath: backgroundDirectory } = runtimePaths
let settingsWriteQueue = Promise.resolve()
const supportedModes = new Set(['auto', 'responses', 'chat-completions'])
const themes = new Set(['verdant', 'nocturne', 'paper', 'sakura'])
const analysisModes = new Set(['balanced', 'action', 'planning', 'review'])
const mapTileProviders = new Set(['osm-de', 'osm-standard', 'osm-hot'])
const mapSearchProviders = new Set(['balanced', 'nominatim', 'photon'])
const backgroundTargets = ['app']
const imageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
])
const defaultPromptInstructions = {
  task: '优先保留仍需你处理、具体可执行的安排。约见、返校、报名、缴费、回复、预约、截止事项优先；闲聊、历史通知、已过期事项不输出。',
  people: '只提取对方自己明确说过的信息。偏好要保留证据强度：单次表达只是“曾有正向评价”，不是稳定习惯或性格。',
  peopleMerge: '将已核验聊天事实与关键互动事件按时间线收敛成简洁的人物志：只写原文能支持的经历、明确偏好、重复互动模式、重要的一次性事件和有证据的变化或延续；单次表达保留单次强度。人物底稿也可包含你确认过的日期与时间线注记，用于解释聊天无法证明的删好友、重新添加或其他偶然节点，但必须与聊天事实分开，不能补写未知背景。证据不足时明确说明边界。',
  taskGuidance: '建议要具体、尊重边界，优先给出可执行的准备、确认和备选方案。不足时建议优先补充时间、地点或对方偏好。',
}
const multiModelWorkflows = new Set(['tasks', 'people'])
const multiModelRoles = new Set(['task-extractor', 'task-judge', 'people-claim-extractor', 'people-judge', 'extractor', 'reviewer'])
const multiModelBuiltInProfiles = [
  { id: 'task-standard', maxCoreRecords: 48, maxCoreChars: 4_000, overlapRecords: 6, overlapChars: 1_000, maxOutputTokens: 3_000 },
  { id: 'people-context', maxCoreRecords: 320, maxCoreChars: 24_000, overlapRecords: 16, overlapChars: 3_000, maxOutputTokens: 5_500 },
]
const multiModelBuiltInProfileIds = new Set(multiModelBuiltInProfiles.map((profile) => profile.id))
const maxMultiModelParticipants = 24
const maxMultiModelExtractors = 8
const maxMultiModelProfiles = 16

function defaultMultiModelSettings() {
  return {
    version: 1,
    mode: 'single',
    maxExtractorsPerConversation: 2,
    segmentProfiles: multiModelBuiltInProfiles.map((profile) => ({ ...profile })),
    participants: [],
  }
}

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function normalizedInteger(value, min, max, fallback) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function normalizeMultiModelProfileId(value, index) {
  return text(value, 80).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `segment-profile-${index + 1}`
}

function normalizeMultiModelSegmentProfile(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const maxCoreRecords = normalizedInteger(value.maxCoreRecords, 1, 2_000, 0)
  const maxCoreChars = normalizedInteger(value.maxCoreChars, 256, 160_000, 0)
  if (!maxCoreRecords || !maxCoreChars) return null
  return {
    id: normalizeMultiModelProfileId(value.id, index),
    maxCoreRecords,
    maxCoreChars,
    overlapRecords: normalizedInteger(value.overlapRecords, 0, maxCoreRecords, 0),
    overlapChars: normalizedInteger(value.overlapChars, 0, maxCoreChars, 0),
    ...(Number.isFinite(Number(value.maxOutputTokens)) ? { maxOutputTokens: normalizedInteger(value.maxOutputTokens, 128, 64_000, 3_000) } : {}),
  }
}

function normalizeMultiModelProfiles(value) {
  const profiles = multiModelBuiltInProfiles.map((profile) => ({ ...profile }))
  const seen = new Set(profiles.map((profile) => profile.id))
  for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
    const profile = normalizeMultiModelSegmentProfile(item, index)
    // Built-in profiles protect the existing, proven single-model envelope.
    if (!profile || seen.has(profile.id) || multiModelBuiltInProfileIds.has(profile.id)) continue
    seen.add(profile.id)
    profiles.push(profile)
    if (profiles.length >= maxMultiModelProfiles) break
  }
  return profiles
}

function multiModelRoleWorkflow(role) {
  return role.startsWith('task-') ? 'tasks' : 'people'
}

function normalizeMultiModelRole(value, workflow) {
  if (!multiModelRoles.has(value)) return ''
  if (['task-extractor', 'task-judge', 'people-claim-extractor', 'people-judge'].includes(value)) {
    return !multiModelWorkflows.has(workflow) || workflow === multiModelRoleWorkflow(value) ? value : ''
  }
  if (value === 'extractor') return workflow === 'tasks' ? 'task-extractor' : workflow === 'people' ? 'people-claim-extractor' : ''
  if (value === 'reviewer') return workflow === 'tasks' ? 'task-judge' : workflow === 'people' ? 'people-judge' : ''
  return ''
}

function defaultMultiModelProfileId(workflow) {
  return workflow === 'people' ? 'people-context' : 'task-standard'
}

function defaultBackgrounds() {
  return Object.fromEntries(backgroundTargets.map((target) => [target, { scale: 100, blur: 0 }]))
}

function defaultSettings() {
  const provider = environmentProvider()
  return {
    appSettingsInitialized: false,
    profile: { name: '访客' },
    appearance: { theme: 'verdant', motionEnabled: false, performanceVersion: 1, backgrounds: defaultBackgrounds(), dynamicBackground: { preset: 'none', intensity: 35, speed: 40 } },
    aiSettings: {
      mode: 'balanced',
      instructions: '只把明确可执行、对现实生活有帮助的事项整理成任务；不要臆测隐私或制造压力。',
      autoEnabled: false,
      intervalHours: 24,
      recencyPolicy: 'balanced',
      // Client-side parallelism; provider channel capacity is independent.
      concurrency: 4,
      feedback: [],
      multiModel: defaultMultiModelSettings(),
    },
    mapSettings: { tileProvider: 'osm-de', searchProvider: 'balanced', cacheMaxMb: 128 },
    provider,
    providers: [provider],
    primaryProviderId: provider.id,
  }
}

export function normalizeMapSettings(input, fallback = { tileProvider: 'osm-de', searchProvider: 'balanced', cacheMaxMb: 128 }) {
  return {
    tileProvider: mapTileProviders.has(input?.tileProvider) ? input.tileProvider : fallback.tileProvider,
    searchProvider: mapSearchProviders.has(input?.searchProvider) ? input.searchProvider : fallback.searchProvider,
    cacheMaxMb: Math.round(clamp(input?.cacheMaxMb, 32, 1024, fallback.cacheMaxMb)),
  }
}

function environmentProvider() {
  // Desktop and IDE processes often inherit unrelated host credentials.
  // Treat environment-provider configuration as an explicit compatibility
  // mode so an ambient OPENAI_API_KEY can never enter the user's settings.
  const environmentEnabled = process.env.THEIA_USE_ENV_PROVIDER === '1'
  return {
    id: 'primary',
    name: '主通道',
    enabled: true,
    apiKey: environmentEnabled ? text(process.env.OPENAI_API_KEY, 1000) : '',
    baseURL: environmentEnabled ? text(process.env.OPENAI_BASE_URL, 1000) || 'https://api.openai.com/v1' : 'https://api.openai.com/v1',
    model: environmentEnabled ? text(process.env.OPENAI_MODEL, 200) || 'gpt-5-mini' : 'gpt-5-mini',
    apiMode: environmentEnabled && supportedModes.has(process.env.OPENAI_API_MODE) ? process.env.OPENAI_API_MODE : 'auto',
    models: [],
    maxConcurrency: environmentEnabled ? clamp(process.env.OPENAI_MAX_CONCURRENCY, 1, 8, 4) : 4,
  }
}

function decode(value) {
  try { return decodeURIComponent(value) } catch { return '' }
}

function parseIni(raw) {
  const sections = new Map()
  let current = ''
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue
    const section = trimmed.match(/^\[([^\]]+)]$/)
    if (section) {
      current = section[1].trim().toLowerCase()
      if (!sections.has(current)) sections.set(current, new Map())
      continue
    }
    const splitAt = line.indexOf('=')
    if (splitAt < 1 || !current) continue
    const key = line.slice(0, splitAt).trim()
    if (!key) continue
    if (!sections.has(current)) sections.set(current, new Map())
    sections.get(current).set(key, decode(line.slice(splitAt + 1).trim()))
  }
  return sections
}

function value(sections, section, key, fallback = '') {
  return sections.get(section)?.get(key) ?? fallback
}

function jsonValue(sections, section, key, fallback) {
  try {
    const parsed = JSON.parse(value(sections, section, key, ''))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch { return fallback }
}

function safeBackgroundUrl(value) {
  const candidate = text(value, 3000)
  if (!candidate) return undefined
  if (/^\/api\/settings\/background\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp|gif|avif)$/.test(candidate)) return candidate
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch { return undefined }
}

function normalizeAppearance(input, fallback) {
  const backgrounds = Object.fromEntries(backgroundTargets.map((target) => {
    const saved = input?.backgrounds?.[target] ?? fallback.backgrounds[target]
    return [target, {
      imageId: text(saved?.imageId, 180) || undefined,
      url: safeBackgroundUrl(saved?.url),
      scale: clamp(saved?.scale, 60, 180, 100),
      blur: clamp(saved?.blur, 0, 24, 0),
    }]
  }))
  return {
    theme: themes.has(input?.theme) ? input.theme : fallback.theme,
    motionEnabled: input?.motionEnabled === true,
    performanceVersion: 1,
    backgrounds,
    dynamicBackground: {
      preset: ['ribbons', 'rain', 'scanlines', 'constellation'].includes(input?.dynamicBackground?.preset) ? input.dynamicBackground.preset : 'none',
      intensity: clamp(input?.dynamicBackground?.intensity, 0, 100, fallback.dynamicBackground.intensity),
      speed: clamp(input?.dynamicBackground?.speed, 10, 100, fallback.dynamicBackground.speed),
    },
  }
}

function normalizeAiCheckpoint(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return undefined
  if (!['tasks', 'people'].includes(value.stage)) return undefined
  const targets = { tasks: value.targets?.tasks === true, people: value.targets?.people === true }
  if (!targets.tasks && !targets.people) return undefined
  const conversationIds = [...new Set((Array.isArray(value.conversationIds) ? value.conversationIds : [])
    .filter((id) => typeof id === 'string' && id.length > 0).slice(-10_000))]
  if (!conversationIds.length) return undefined
  const allowed = new Set(conversationIds)
  const completedConversationIds = [...new Set((Array.isArray(value.completedConversationIds) ? value.completedConversationIds : [])
    .filter((id) => typeof id === 'string' && allowed.has(id)).slice(-10_000))]
  const date = (candidate) => typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : undefined
  return {
    version: 1,
    stage: value.stage,
    targets,
    scope: ['unprocessed', 'new', 'all'].includes(value.scope) ? value.scope : 'all',
    timelineMode: ['last-chat', 'strict-window'].includes(value.timelineMode) ? value.timelineMode : 'last-chat',
    ...(date(value.timelineStart) ? { timelineStart: date(value.timelineStart) } : {}),
    ...(date(value.timelineEnd) ? { timelineEnd: date(value.timelineEnd) } : {}),
    ...(typeof value.conversationId === 'string' && allowed.has(value.conversationId) ? { conversationId: value.conversationId } : {}),
    conversationIds,
    completedConversationIds,
    startedAt: text(value.startedAt, 80) || new Date().toISOString(),
    ...(text(value.pausedAt, 80) ? { pausedAt: text(value.pausedAt, 80) } : {}),
  }
}

export function normalizeMultiModelSettings(value) {
  const segmentProfiles = normalizeMultiModelProfiles(value?.segmentProfiles)
  const profiles = new Map(segmentProfiles.map((profile) => [profile.id, profile]))
  const seen = new Set()
  const participants = (Array.isArray(value?.participants) ? value.participants : []).flatMap((item, index) => {
    const role = normalizeMultiModelRole(item?.role, item?.workflow)
    const channelId = text(item?.channelId, 80)
    const model = text(item?.model, 200)
    if (!role || !channelId || !model) return []
    const workflow = multiModelRoleWorkflow(role)
    const requestedProfileId = text(item?.segmentProfileId, 80)
    const segmentProfileId = role.endsWith('extractor')
      ? profiles.has(requestedProfileId) ? requestedProfileId : defaultMultiModelProfileId(workflow)
      : ''
    const identity = `${role}\u0000${channelId}\u0000${model}`
    if (seen.has(identity)) return []
    seen.add(identity)
    const id = text(item?.id, 80).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `model-pass-${index + 1}`
    return [{ id, workflow, role, channelId, model, ...(segmentProfileId ? { segmentProfileId } : {}), enabled: item?.enabled !== false }]
  }).slice(0, maxMultiModelParticipants)
  return {
    version: 1,
    mode: value?.mode === 'ensemble' ? 'ensemble' : 'single',
    maxExtractorsPerConversation: normalizedInteger(value?.maxExtractorsPerConversation, 1, maxMultiModelExtractors, 2),
    segmentProfiles,
    participants,
  }
}

function normalizeAiSettings(input, fallback) {
  // Keep the local review history useful to the user. Request builders apply
  // their own much smaller model-context limit.
  const feedback = Array.isArray(input?.feedback) ? input.feedback.slice(-80).flatMap((item, index) => {
    const title = text(item?.title, 120)
    const description = text(item?.description, 1000)
    const decision = item?.decision === 'accepted' ? 'accepted' : item?.decision === 'dismissed' ? 'dismissed' : ''
    const reason = ['useful', 'expired', 'ownership', 'completed', 'not-actionable', 'incorrect', 'other'].includes(item?.reason) ? item.reason : 'other'
    if (!title || !description || !decision) return []
    return [{
      id: text(item?.id, 180) || `feedback-${index}`,
      title,
      description,
      decision,
      reason,
      ...(text(item?.sourceCapturedAt, 80) ? { sourceCapturedAt: text(item.sourceCapturedAt, 80) } : {}),
      createdAt: text(item?.createdAt, 80) || new Date().toISOString(),
    }]
  }) : []
  const promptInstructions = Object.fromEntries(Object.entries(defaultPromptInstructions).map(([key, fallbackValue]) => [key, text(input?.promptInstructions?.[key], 6000) || fallbackValue]))
  const normalizeWatermarkGroup = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value)
      .filter(([key, item]) => key.length > 0 && key.length <= 240 && typeof item === 'string' && item.length <= 160)
      .slice(-20_000)
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  const tasksWatermarks = normalizeWatermarkGroup(input?.analysisWatermarks?.tasks)
  const peopleWatermarks = normalizeWatermarkGroup(input?.analysisWatermarks?.people)
  // Migrate only the exact previous built-in value. A genuinely edited prompt
  // is user data and must remain untouched.
  if (promptInstructions.peopleMerge === '仅根据已核验事实收敛人物刻画。结论不足时明确说需要更多信息，不要用套话补齐。') promptInstructions.peopleMerge = defaultPromptInstructions.peopleMerge
  return {
    mode: analysisModes.has(input?.mode) ? input.mode : fallback.mode,
    instructions: text(input?.instructions, 4000) || fallback.instructions,
    autoEnabled: input?.autoEnabled === true,
    intervalHours: clamp(input?.intervalHours, 24, 24 * 30, fallback.intervalHours),
    recencyPolicy: ['strict', 'balanced', 'broad'].includes(input?.recencyPolicy) ? input.recencyPolicy : fallback.recencyPolicy,
    concurrency: Math.round(clamp(input?.concurrency, 1, 64, Math.round(clamp(fallback?.concurrency, 1, 64, 4)))),
    feedback,
    promptInstructions,
    multiModel: normalizeMultiModelSettings(input?.multiModel),
    ...(tasksWatermarks || peopleWatermarks ? {
      analysisWatermarks: {
        ...(tasksWatermarks ? { tasks: tasksWatermarks } : {}),
        ...(peopleWatermarks ? { people: peopleWatermarks } : {}),
      },
    } : {}),
    ...(text(input?.lastRunAt, 80) ? { lastRunAt: text(input.lastRunAt, 80) } : {}),
    ...(text(input?.lastPeopleFollowupAt, 80) ? { lastPeopleFollowupAt: text(input.lastPeopleFollowupAt, 80) } : {}),
    ...(normalizeAiCheckpoint(input?.interruptedRun) ? { interruptedRun: normalizeAiCheckpoint(input.interruptedRun) } : {}),
  }
}

function normalizeProviderId(value, fallback = 'primary') {
  const normalized = text(value, 80).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function normalizeProvider(input, fallback, index = 0) {
  const hasKey = typeof input?.apiKey === 'string' || typeof input?.key === 'string'
  const hasBaseUrl = typeof input?.baseURL === 'string' || typeof input?.url === 'string'
  const hasModel = typeof input?.model === 'string'
  const hasModels = Array.isArray(input?.models)
  const fallbackId = normalizeProviderId(fallback?.id, index === 0 ? 'primary' : `channel-${index + 1}`)
  return {
    id: normalizeProviderId(input?.id, fallbackId),
    name: text(input?.name, 80) || text(fallback?.name, 80) || `通道 ${index + 1}`,
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : fallback?.enabled !== false,
    apiKey: hasKey ? text(input?.apiKey ?? input?.key, 1000) : text(fallback?.apiKey, 1000),
    credentialRef: text(input?.credentialRef, 160) || text(fallback?.credentialRef, 160) || undefined,
    baseURL: hasBaseUrl ? text(input?.baseURL ?? input?.url, 1000) || fallback?.baseURL : fallback?.baseURL,
    model: hasModel ? text(input?.model, 200) || fallback?.model : fallback?.model,
    apiMode: supportedModes.has(input?.apiMode) ? input.apiMode : supportedModes.has(fallback?.apiMode) ? fallback.apiMode : 'auto',
    models: hasModels ? [...new Set(input.models.map((item) => text(item, 200)).filter(Boolean))].slice(0, 300) : Array.isArray(fallback?.models) ? fallback.models : [],
    maxConcurrency: Math.round(clamp(input?.maxConcurrency, 1, 8, clamp(fallback?.maxConcurrency, 1, 8, 4))),
  }
}

export function normalizeProviderRecords(input, fallbackProvider) {
  const records = Array.isArray(input) && input.length ? input.slice(0, 32) : [fallbackProvider]
  const usedIds = new Set()
  return records.map((record, index) => {
    // Protected channels omit apiKey and retain only credentialRef. Never
    // inherit the process-wide OPENAI_API_KEY for channel 2+.
    const channelFallback = index === 0
      ? fallbackProvider
      : { ...environmentProvider(), apiKey: '', id: `channel-${index + 1}`, name: `通道 ${index + 1}` }
    const normalized = normalizeProvider(record, channelFallback, index)
    const baseId = normalized.id
    let id = baseId
    let suffix = 2
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`
    usedIds.add(id)
    return { ...normalized, id }
  })
}

function normalizeSettings(input, fallback = defaultSettings()) {
  const requestedPrimary = normalizeProvider(input?.provider, fallback.provider)
  const providers = normalizeProviderRecords(input?.providers, requestedPrimary)
  const requestedPrimaryId = normalizeProviderId(input?.primaryProviderId, requestedPrimary.id)
  const provider = providers.find((channel) => channel.id === requestedPrimaryId) ?? providers[0]
  return {
    appSettingsInitialized: input?.appSettingsInitialized === true,
    profile: { name: text(input?.profile?.name, 32) || fallback.profile.name, avatarUrl: safeBackgroundUrl(input?.profile?.avatarUrl) },
    appearance: normalizeAppearance(input?.appearance, fallback.appearance),
    aiSettings: normalizeAiSettings(input?.aiSettings, fallback.aiSettings),
    mapSettings: normalizeMapSettings(input?.mapSettings, fallback.mapSettings),
    provider,
    providers,
    primaryProviderId: provider.id,
  }
}

function credentialReference(channel) {
  return text(channel?.credentialRef, 160) || `theia/provider/${normalizeProviderId(channel?.id, 'primary')}`
}

async function protectProviderCredentials(settings) {
  if (!(await credentialStoreAvailable())) return { settings, protected: false }
  const providers = []
  for (const channel of settings.providers) {
    const credentialRef = credentialReference(channel)
    if (channel.apiKey) await saveCredential(credentialRef, channel.apiKey)
    else await deleteCredential(credentialRef)
    providers.push({ ...channel, credentialRef })
  }
  const provider = providers.find((channel) => channel.id === settings.primaryProviderId) ?? providers[0]
  return { settings: { ...settings, providers, provider }, protected: true }
}

async function hydrateProviderCredentials(settings) {
  if (!(await credentialStoreAvailable())) return { settings, migratedPlaintext: false }
  let migratedPlaintext = false
  const providers = []
  for (const channel of settings.providers) {
    const credentialRef = credentialReference(channel)
    // An existing encrypted credential belongs to this channel and wins over
    // any fallback value produced while parsing the INI. Otherwise an ambient
    // OPENAI_API_KEY can silently replace every per-channel secret.
    const storedCredential = await loadCredential(credentialRef)
    const apiKey = storedCredential || channel.apiKey
    if (!storedCredential && channel.apiKey) {
      await saveCredential(credentialRef, channel.apiKey)
      migratedPlaintext = true
    }
    providers.push({ ...channel, apiKey, credentialRef })
  }
  const provider = providers.find((channel) => channel.id === settings.primaryProviderId) ?? providers[0]
  return { settings: { ...settings, providers, provider }, migratedPlaintext }
}

function serializeSettings(settings, protectedCredentials = false) {
  const encode = (item) => encodeURIComponent(String(item ?? ''))
  const serializedProviders = settings.providers.map((channel) => protectedCredentials
    ? { ...channel, apiKey: undefined, key: undefined, credentialRef: credentialReference(channel) }
    : channel)
  const lines = [
    '; THEIA local shared settings. Values are URL-encoded to preserve newlines and = characters.',
    '[meta]',
    'version=4',
    `appSettingsInitialized=${encode(settings.appSettingsInitialized)}`,
    '',
    '[profile]',
    `name=${encode(settings.profile.name)}`,
    `avatarUrl=${encode(settings.profile.avatarUrl ?? '')}`,
    '',
    '[appearance]',
    `theme=${encode(settings.appearance.theme)}`,
    `motionEnabled=${encode(settings.appearance.motionEnabled)}`,
    `backgrounds=${encode(JSON.stringify(settings.appearance.backgrounds))}`,
    `dynamicBackground=${encode(JSON.stringify(settings.appearance.dynamicBackground))}`,
    '',
    '[ai]',
    `mode=${encode(settings.aiSettings.mode)}`,
    `instructions=${encode(settings.aiSettings.instructions)}`,
    `autoEnabled=${encode(settings.aiSettings.autoEnabled)}`,
    `intervalHours=${encode(settings.aiSettings.intervalHours)}`,
    `recencyPolicy=${encode(settings.aiSettings.recencyPolicy)}`,
    `concurrency=${encode(settings.aiSettings.concurrency)}`,
    `feedback=${encode(JSON.stringify(settings.aiSettings.feedback))}`,
    `promptInstructions=${encode(JSON.stringify(settings.aiSettings.promptInstructions))}`,
    `multiModel=${encode(JSON.stringify(settings.aiSettings.multiModel ?? defaultMultiModelSettings()))}`,
    `analysisWatermarks=${encode(JSON.stringify(settings.aiSettings.analysisWatermarks ?? null))}`,
    `lastRunAt=${encode(settings.aiSettings.lastRunAt ?? '')}`,
    `lastPeopleFollowupAt=${encode(settings.aiSettings.lastPeopleFollowupAt ?? '')}`,
    `interruptedRun=${encode(JSON.stringify(settings.aiSettings.interruptedRun ?? null))}`,
    '',
    '[map]',
    `tileProvider=${encode(settings.mapSettings.tileProvider)}`,
    `searchProvider=${encode(settings.mapSettings.searchProvider)}`,
    `cacheMaxMb=${encode(settings.mapSettings.cacheMaxMb)}`,
    '',
    '[provider]',
    `id=${encode(settings.provider.id)}`,
    `name=${encode(settings.provider.name)}`,
    `enabled=${encode(settings.provider.enabled)}`,
    `url=${encode(settings.provider.baseURL)}`,
    `key=${encode(protectedCredentials ? '' : settings.provider.apiKey)}`,
    `credentialRef=${encode(protectedCredentials ? credentialReference(settings.provider) : settings.provider.credentialRef ?? '')}`,
    `model=${encode(settings.provider.model)}`,
    `apiMode=${encode(settings.provider.apiMode)}`,
    `models=${encode(JSON.stringify(settings.provider.models))}`,
    `maxConcurrency=${encode(settings.provider.maxConcurrency)}`,
    '',
    '[providers]',
    `primaryId=${encode(settings.primaryProviderId)}`,
    `channels=${encode(JSON.stringify(serializedProviders))}`,
    '',
  ]
  return lines.join('\n')
}

function fromIni(raw) {
  const parsed = parseIni(raw)
  const defaults = defaultSettings()
  return normalizeSettings({
    appSettingsInitialized: value(parsed, 'meta', 'appSettingsInitialized') === 'true',
    profile: { name: value(parsed, 'profile', 'name'), avatarUrl: value(parsed, 'profile', 'avatarUrl') },
    appearance: {
      theme: value(parsed, 'appearance', 'theme'),
      motionEnabled: value(parsed, 'appearance', 'motionEnabled') === 'true',
      backgrounds: jsonValue(parsed, 'appearance', 'backgrounds', {}),
      dynamicBackground: jsonValue(parsed, 'appearance', 'dynamicBackground', {}),
    },
    aiSettings: {
      mode: value(parsed, 'ai', 'mode'),
      instructions: value(parsed, 'ai', 'instructions'),
      autoEnabled: value(parsed, 'ai', 'autoEnabled') === 'true',
      intervalHours: value(parsed, 'ai', 'intervalHours'),
      recencyPolicy: value(parsed, 'ai', 'recencyPolicy'),
      concurrency: value(parsed, 'ai', 'concurrency'),
      feedback: jsonValue(parsed, 'ai', 'feedback', []),
      promptInstructions: jsonValue(parsed, 'ai', 'promptInstructions', {}),
      multiModel: jsonValue(parsed, 'ai', 'multiModel', {}),
      analysisWatermarks: jsonValue(parsed, 'ai', 'analysisWatermarks', undefined),
      lastRunAt: value(parsed, 'ai', 'lastRunAt'),
      lastPeopleFollowupAt: value(parsed, 'ai', 'lastPeopleFollowupAt'),
      interruptedRun: jsonValue(parsed, 'ai', 'interruptedRun', undefined),
    },
    mapSettings: {
      tileProvider: value(parsed, 'map', 'tileProvider'),
      searchProvider: value(parsed, 'map', 'searchProvider'),
      cacheMaxMb: value(parsed, 'map', 'cacheMaxMb'),
    },
    provider: {
      id: value(parsed, 'provider', 'id'),
      name: value(parsed, 'provider', 'name'),
      enabled: value(parsed, 'provider', 'enabled', '') === '' ? undefined : value(parsed, 'provider', 'enabled') === 'true',
      url: value(parsed, 'provider', 'url'),
      key: value(parsed, 'provider', 'key'),
      credentialRef: value(parsed, 'provider', 'credentialRef'),
      model: value(parsed, 'provider', 'model'),
      apiMode: value(parsed, 'provider', 'apiMode'),
      models: jsonValue(parsed, 'provider', 'models', []),
      maxConcurrency: value(parsed, 'provider', 'maxConcurrency'),
    },
    providers: jsonValue(parsed, 'providers', 'channels', []),
    primaryProviderId: value(parsed, 'providers', 'primaryId'),
  }, defaults)
}

async function migrateLegacyProvider() {
  try {
    const legacy = JSON.parse(await readFile(legacyProviderPath, 'utf8'))
    if (!text(legacy?.key, 1000)) return null
    const next = defaultSettings()
    next.provider = normalizeProvider({
      key: legacy.key,
      url: legacy.url,
      model: legacy.model,
      apiMode: legacy.apiMode,
      models: legacy.models,
    }, next.provider)
    next.providers = [next.provider]
    next.primaryProviderId = next.provider.id
    return next
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    console.warn('Legacy provider configuration could not be migrated.')
    return null
  }
}

export async function loadSettings() {
  try {
    const hydrated = await hydrateProviderCredentials(fromIni(await readFile(settingsPath, 'utf8')))
    if (hydrated.migratedPlaintext) return { settings: await writeSettingsFile(hydrated.settings), initialized: true }
    return { settings: hydrated.settings, initialized: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const migrated = await migrateLegacyProvider()
    if (migrated) {
      await writeSettingsFile(migrated)
      return { settings: migrated, initialized: true }
    }
    return { settings: defaultSettings(), initialized: false }
  }
}

async function writeSettingsFile(input) {
  const normalized = normalizeSettings(input)
  const protectedResult = await protectProviderCredentials(normalized)
  const settings = protectedResult.settings
  const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
  await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporaryPath, serializeSettings(settings, protectedResult.protected), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, settingsPath)
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
  return settings
}

function enqueueSettingsWrite(work) {
  const write = settingsWriteQueue.then(work)
  settingsWriteQueue = write.catch(() => undefined)
  return write
}

export function writeSettings(input) {
  return enqueueSettingsWrite(() => writeSettingsFile(input))
}

export function saveAppSettings(input) {
  return enqueueSettingsWrite(async () => {
    const { settings } = await loadSettings()
    return writeSettingsFile({
      ...settings,
      appSettingsInitialized: true,
      profile: input?.profile ?? settings.profile,
      appearance: input?.appearance ?? settings.appearance,
      aiSettings: input?.aiSettings ?? settings.aiSettings,
      mapSettings: input?.mapSettings ?? settings.mapSettings,
    })
  })
}

export function saveMapSettings(input) {
  return enqueueSettingsWrite(async () => {
    const { settings } = await loadSettings()
    const next = await writeSettingsFile({ ...settings, mapSettings: normalizeMapSettings(input, settings.mapSettings) })
    return next.mapSettings
  })
}

export async function loadProviderSettings() {
  const { settings, initialized } = await loadSettings()
  return { ...settings.provider, source: initialized ? 'settings-ini' : 'environment' }
}

export async function loadProviderChannelSettings() {
  const { settings, initialized } = await loadSettings()
  const source = initialized ? 'settings-ini' : 'environment'
  return {
    primaryProviderId: settings.primaryProviderId,
    channels: settings.providers.map((channel) => ({ ...channel, source })),
    source,
  }
}

export function saveProviderSettings(provider) {
  return enqueueSettingsWrite(async () => {
    const { settings } = await loadSettings()
    const merged = { ...settings.provider, ...provider, id: settings.primaryProviderId }
    const providers = settings.providers.map((channel) => channel.id === settings.primaryProviderId ? merged : channel)
    const next = await writeSettingsFile({ ...settings, provider: merged, providers, primaryProviderId: settings.primaryProviderId })
    return { ...next.provider, source: 'settings-ini' }
  })
}

export function saveProviderChannelSettings(input) {
  return enqueueSettingsWrite(async () => {
    const { settings } = await loadSettings()
    const channels = Array.isArray(input?.channels) && input.channels.length ? input.channels : settings.providers
    const primaryProviderId = text(input?.primaryProviderId, 80) || settings.primaryProviderId
    const provider = channels.find((channel) => channel?.id === primaryProviderId) ?? channels[0]
    const next = await writeSettingsFile({ ...settings, provider, providers: channels, primaryProviderId: provider?.id })
    return {
      primaryProviderId: next.primaryProviderId,
      channels: next.providers.map((channel) => ({ ...channel, source: 'settings-ini' })),
      source: 'settings-ini',
    }
  })
}

export async function saveBackgroundAsset({ mimeType, data }) {
  const extension = imageTypes.get(text(mimeType, 120).toLowerCase())
  const match = typeof data === 'string' && data.match(/^data:([^;]+);base64,([a-zA-Z0-9+/=]+)$/)
  if (!extension || !match || match[1].toLowerCase() !== mimeType.toLowerCase()) throw new Error('请选择 PNG、JPG、WebP、GIF 或 AVIF 图片。')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('背景图片需小于 20MB。')
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${extension}`
  await mkdir(backgroundDirectory, { recursive: true })
  await writeFile(resolve(backgroundDirectory, id), bytes, { mode: 0o600 })
  return { id, url: `/api/settings/background/${id}`, mimeType: mimeType.toLowerCase() }
}

export function backgroundAssetPath(id) {
  const safeId = text(id, 120)
  if (!/^[a-z0-9_-]+\.(?:jpg|png|webp|gif|avif)$/i.test(safeId)) return null
  return resolve(backgroundDirectory, safeId)
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { runtimePaths } from './runtimePaths.mjs'

const { settingsPath, legacyProviderPath, backgroundDirectoryPath: backgroundDirectory } = runtimePaths
const supportedModes = new Set(['auto', 'responses', 'chat-completions'])
const themes = new Set(['verdant', 'nocturne', 'paper', 'sakura'])
const analysisModes = new Set(['balanced', 'action', 'planning', 'review'])
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
  peopleMerge: '仅根据已核验事实收敛人物刻画。结论不足时明确说需要更多信息，不要用套话补齐。',
  taskGuidance: '建议要具体、尊重边界，优先给出可执行的准备、确认和备选方案。不足时建议优先补充时间、地点或对方偏好。',
}

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function defaultBackgrounds() {
  return Object.fromEntries(backgroundTargets.map((target) => [target, { scale: 100, blur: 0 }]))
}

function defaultSettings() {
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
      feedback: [],
    },
    provider: environmentProvider(),
  }
}

function environmentProvider() {
  return {
    apiKey: text(process.env.OPENAI_API_KEY, 1000),
    baseURL: text(process.env.OPENAI_BASE_URL, 1000) || 'https://api.openai.com/v1',
    model: text(process.env.OPENAI_MODEL, 200) || 'gpt-5-mini',
    apiMode: supportedModes.has(process.env.OPENAI_API_MODE) ? process.env.OPENAI_API_MODE : 'auto',
    models: [],
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

function normalizeAiSettings(input, fallback) {
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
  return {
    mode: analysisModes.has(input?.mode) ? input.mode : fallback.mode,
    instructions: text(input?.instructions, 4000) || fallback.instructions,
    autoEnabled: input?.autoEnabled === true,
    intervalHours: clamp(input?.intervalHours, 24, 24 * 30, fallback.intervalHours),
    recencyPolicy: ['strict', 'balanced', 'broad'].includes(input?.recencyPolicy) ? input.recencyPolicy : fallback.recencyPolicy,
    feedback,
    promptInstructions: Object.fromEntries(Object.entries(defaultPromptInstructions).map(([key, fallbackValue]) => [key, text(input?.promptInstructions?.[key], 6000) || fallbackValue])),
    ...(text(input?.lastRunAt, 80) ? { lastRunAt: text(input.lastRunAt, 80) } : {}),
  }
}

function normalizeProvider(input, fallback) {
  const hasKey = typeof input?.apiKey === 'string' || typeof input?.key === 'string'
  const hasBaseUrl = typeof input?.baseURL === 'string' || typeof input?.url === 'string'
  const hasModel = typeof input?.model === 'string'
  const hasModels = Array.isArray(input?.models)
  return {
    apiKey: hasKey ? text(input?.apiKey ?? input?.key, 1000) : fallback.apiKey,
    baseURL: hasBaseUrl ? text(input?.baseURL ?? input?.url, 1000) || fallback.baseURL : fallback.baseURL,
    model: hasModel ? text(input?.model, 200) || fallback.model : fallback.model,
    apiMode: supportedModes.has(input?.apiMode) ? input.apiMode : fallback.apiMode,
    models: hasModels ? [...new Set(input.models.map((item) => text(item, 200)).filter(Boolean))].slice(0, 300) : fallback.models,
  }
}

function normalizeSettings(input, fallback = defaultSettings()) {
  return {
    appSettingsInitialized: input?.appSettingsInitialized === true,
    profile: { name: text(input?.profile?.name, 32) || fallback.profile.name, avatarUrl: safeBackgroundUrl(input?.profile?.avatarUrl) },
    appearance: normalizeAppearance(input?.appearance, fallback.appearance),
    aiSettings: normalizeAiSettings(input?.aiSettings, fallback.aiSettings),
    provider: normalizeProvider(input?.provider, fallback.provider),
  }
}

function serializeSettings(settings) {
  const encode = (item) => encodeURIComponent(String(item ?? ''))
  const lines = [
    '; THEIA local shared settings. Values are URL-encoded to preserve newlines and = characters.',
    '[meta]',
    'version=2',
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
    `feedback=${encode(JSON.stringify(settings.aiSettings.feedback))}`,
    `promptInstructions=${encode(JSON.stringify(settings.aiSettings.promptInstructions))}`,
    `lastRunAt=${encode(settings.aiSettings.lastRunAt ?? '')}`,
    '',
    '[provider]',
    `url=${encode(settings.provider.baseURL)}`,
    `key=${encode(settings.provider.apiKey)}`,
    `model=${encode(settings.provider.model)}`,
    `apiMode=${encode(settings.provider.apiMode)}`,
    `models=${encode(JSON.stringify(settings.provider.models))}`,
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
      feedback: jsonValue(parsed, 'ai', 'feedback', []),
      promptInstructions: jsonValue(parsed, 'ai', 'promptInstructions', {}),
      lastRunAt: value(parsed, 'ai', 'lastRunAt'),
    },
    provider: {
      url: value(parsed, 'provider', 'url'),
      key: value(parsed, 'provider', 'key'),
      model: value(parsed, 'provider', 'model'),
      apiMode: value(parsed, 'provider', 'apiMode'),
      models: jsonValue(parsed, 'provider', 'models', []),
    },
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
    return next
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    console.warn('Legacy provider configuration could not be migrated.')
    return null
  }
}

export async function loadSettings() {
  try {
    return { settings: fromIni(await readFile(settingsPath, 'utf8')), initialized: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const migrated = await migrateLegacyProvider()
    if (migrated) {
      await writeSettings(migrated)
      return { settings: migrated, initialized: true }
    }
    return { settings: defaultSettings(), initialized: false }
  }
}

export async function writeSettings(input) {
  const settings = normalizeSettings(input)
  const temporaryPath = `${settingsPath}.tmp`
  await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 })
  await writeFile(temporaryPath, serializeSettings(settings), { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, settingsPath)
  return settings
}

export async function saveAppSettings(input) {
  const { settings } = await loadSettings()
  return writeSettings({
    ...settings,
    appSettingsInitialized: true,
    profile: input?.profile ?? settings.profile,
    appearance: input?.appearance ?? settings.appearance,
    aiSettings: input?.aiSettings ?? settings.aiSettings,
  })
}

export async function loadProviderSettings() {
  const { settings, initialized } = await loadSettings()
  return { ...settings.provider, source: initialized ? 'settings-ini' : 'environment' }
}

export async function saveProviderSettings(provider) {
  const { settings } = await loadSettings()
  const next = await writeSettings({ ...settings, provider: { ...settings.provider, ...provider } })
  return { ...next.provider, source: 'settings-ini' }
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

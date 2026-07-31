import { randomUUID } from 'node:crypto'
import {
  loadProviderChannelSettings,
  loadProviderSettings,
  saveProviderChannelSettings,
  saveProviderSettings,
} from './settings.mjs'

const supportedModes = new Set(['auto', 'responses', 'chat-completions'])
const modelDiscoveryTimeoutMs = 15_000

function text(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function integer(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(Math.max(min, Math.min(max, number))) : fallback
}

function providerId(value, fallback = 'primary') {
  return text(value, 80).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback
}

function providerError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

export function normalizeBaseUrl(value) {
  const raw = text(value, 1000)
  if (!raw) return 'https://api.openai.com/v1'
  const parsed = new URL(raw)
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) throw new Error('中转地址必须使用 HTTPS；仅本机地址允许 HTTP')
  parsed.search = ''
  parsed.hash = ''
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/v1'
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

function normalizeMode(value) {
  return supportedModes.has(value) ? value : 'auto'
}

function providerName(baseURL) {
  try { return new URL(baseURL).hostname === 'api.openai.com' ? 'OpenAI' : new URL(baseURL).hostname } catch { return '自定义通道' }
}

function pickModel(models, requested) {
  if (requested && (!models.length || models.includes(requested))) return requested
  const preferred = ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini', 'deepseek-chat']
  for (const candidate of preferred) if (models.includes(candidate)) return candidate
  const suitable = models.find((id) => !/(embedding|audio|transcri|tts|image|moderation|realtime)/i.test(id))
  return suitable || requested || 'gpt-5-mini'
}

function normalizeStoredProvider(stored, index = 0) {
  const rawBaseURL = text(stored?.baseURL ?? stored?.url, 1000) || 'https://api.openai.com/v1'
  let baseURL = rawBaseURL
  let configurationError = ''
  try {
    baseURL = normalizeBaseUrl(rawBaseURL)
  } catch (error) {
    configurationError = error instanceof Error ? error.message : '通道地址无效'
  }
  const id = providerId(stored?.id, index === 0 ? 'primary' : `channel-${index + 1}`)
  return {
    id,
    name: text(stored?.name, 80) || (index === 0 ? '主通道' : `通道 ${index + 1}`),
    enabled: stored?.enabled !== false,
    apiKey: text(stored?.apiKey ?? stored?.key, 1000),
    baseURL,
    model: text(stored?.model, 200) || 'gpt-5-mini',
    apiMode: normalizeMode(stored?.apiMode),
    models: Array.isArray(stored?.models) ? [...new Set(stored.models.map((item) => text(item, 200)).filter(Boolean))].slice(0, 300) : [],
    maxConcurrency: integer(stored?.maxConcurrency, 1, 8, 4),
    source: stored?.source,
    ...(configurationError ? { configurationError } : {}),
  }
}

function normalizeStoredPool(stored) {
  const channels = Array.isArray(stored?.channels) && stored.channels.length
    ? stored.channels.map((channel, index) => normalizeStoredProvider(channel, index))
    : [normalizeStoredProvider(stored, 0)]
  const requestedPrimaryId = providerId(stored?.primaryProviderId, channels[0].id)
  const primary = channels.find((channel) => channel.id === requestedPrimaryId) ?? channels[0]
  return { primaryProviderId: primary.id, channels, source: stored?.source }
}

export async function loadProviderConfigs() {
  return normalizeStoredPool(await loadProviderChannelSettings())
}

export async function loadProviderConfig() {
  const pool = await loadProviderConfigs()
  return pool.channels.find((channel) => channel.id === pool.primaryProviderId) ?? pool.channels[0]
}

export function publicProviderConfig(config) {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    configured: Boolean(config.apiKey) && !config.configurationError,
    model: config.model,
    apiMode: config.apiMode,
    baseUrl: config.baseURL,
    provider: providerName(config.baseURL),
    keyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
    source: config.source,
    models: config.models,
    maxConcurrency: config.maxConcurrency,
    ...(config.configurationError ? { configurationError: config.configurationError } : {}),
  }
}

export function editableProviderConfig(config) {
  return { ...publicProviderConfig(config), key: config.apiKey }
}

export function publicProviderPoolConfig(pool) {
  const primary = pool.channels.find((channel) => channel.id === pool.primaryProviderId) ?? pool.channels[0]
  const channels = pool.channels.map(publicProviderConfig)
  return {
    ...publicProviderConfig(primary),
    primaryProviderId: primary.id,
    channels,
    configuredChannelCount: channels.filter((channel) => channel.enabled && channel.configured).length,
    totalMaxConcurrency: channels.filter((channel) => channel.enabled && channel.configured).reduce((total, channel) => total + channel.maxConcurrency, 0),
  }
}

export function editableProviderPoolConfig(pool) {
  const primary = pool.channels.find((channel) => channel.id === pool.primaryProviderId) ?? pool.channels[0]
  return { ...publicProviderPoolConfig(pool), ...editableProviderConfig(primary), channels: pool.channels.map(editableProviderConfig) }
}

export async function discoverModels(config) {
  try {
    const endpoint = new URL('models', `${config.baseURL.replace(/\/+$/, '')}/`)
    const response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(modelDiscoveryTimeoutMs),
    })
    if (!response.ok) {
      const detail = text(await response.text(), 600)
      const failure = new Error(detail || `模型接口请求失败 (${response.status})`)
      Object.assign(failure, { status: response.status })
      throw failure
    }
    const payload = await response.json()
    const records = Array.isArray(payload?.data) ? payload.data : []
    const models = [...new Set(records.map((model) => text(model?.id, 200)).filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, 300)
    if (!models.length) throw new Error('模型接口返回了空列表，请确认服务地址、API Key 和 /v1/models 权限。')
    return models
  } catch (error) {
    const status = Number(error?.status)
    if (status === 401) throw new Error('模型服务拒绝了 API Key（401）。请确认 Key 有效且属于该服务地址。')
    if (status === 403 || /\b403\b/.test(error instanceof Error ? error.message : '')) throw new Error('模型服务拒绝了 /v1/models 请求（403）。请使用平台提供的 API 地址而不是网站首页，并确认该 Key 有读取模型列表的权限。')
    throw error
  }
}

async function prepareChannel(input, current, options = {}) {
  if (input?._type && input._type !== 'newapi_channel_conn') throw new Error('不支持的连接配置类型')
  const hasKey = Object.hasOwn(input ?? {}, 'key') || Object.hasOwn(input ?? {}, 'apiKey')
  const hasUrl = Object.hasOwn(input ?? {}, 'url') || Object.hasOwn(input ?? {}, 'baseURL')
  const apiKey = hasKey ? text(input?.key ?? input?.apiKey, 1000) : current.apiKey
  if (!apiKey && options.requireKey !== false) throw new Error('请填写 API Key')
  const baseURL = normalizeBaseUrl(hasUrl ? input?.url ?? input?.baseURL : current.baseURL)
  const apiMode = normalizeMode(input?.apiMode ?? current.apiMode)
  const requestedModel = Object.hasOwn(input ?? {}, 'model') ? text(input?.model, 200) : current.model
  let models = Array.isArray(input?.models)
    ? [...new Set(input.models.map((item) => text(item, 200)).filter(Boolean))].slice(0, 300)
    : current.models
  let discoveryWarning = ''
  const connectionChanged = apiKey !== current.apiKey || baseURL !== current.baseURL
  if (apiKey && (options.discoverModels === true || input?.refreshModels === true || connectionChanged)) {
    try {
      models = await discoverModels({ apiKey, baseURL })
    } catch (error) {
      if (!requestedModel) throw new Error(`无法自动获取模型列表：${error instanceof Error ? error.message : '连接失败'}。也可以填写明确的模型 ID 后保存。`)
      discoveryWarning = '模型列表不可用，已按手动模型 ID 保存。'
    }
  }
  return {
    ...current,
    name: text(input?.name, 80) || current.name || providerName(baseURL),
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : current.enabled !== false,
    apiKey,
    baseURL,
    model: pickModel(models, requestedModel),
    apiMode,
    models,
    maxConcurrency: integer(input?.maxConcurrency, 1, 8, current.maxConcurrency || 4),
    configurationError: undefined,
    warning: discoveryWarning,
  }
}

export async function saveProviderConfig(input) {
  const current = await loadProviderConfig()
  const legacyInput = { ...input, key: text(input?.key, 1000) || current.apiKey }
  const prepared = await prepareChannel(legacyInput, current, { discoverModels: true })
  const { warning, ...channel } = prepared
  const stored = normalizeStoredProvider(await saveProviderSettings(channel))
  return { config: stored, warning }
}

export async function createProviderChannel(input) {
  const pool = await loadProviderConfigs()
  const requestedId = providerId(input?.id, `channel-${randomUUID().slice(0, 8)}`)
  if (pool.channels.some((channel) => channel.id === requestedId)) throw providerError(`通道 ID “${requestedId}” 已存在`, 409)
  const fallback = normalizeStoredProvider({
    id: requestedId,
    name: text(input?.name, 80) || `通道 ${pool.channels.length + 1}`,
    enabled: input?.enabled !== false,
    maxConcurrency: input?.maxConcurrency,
  }, pool.channels.length)
  const prepared = await prepareChannel(input, fallback, { discoverModels: true })
  const { warning, ...channel } = prepared
  channel.id = requestedId
  const primaryProviderId = input?.primary === true ? requestedId : pool.primaryProviderId
  const saved = normalizeStoredPool(await saveProviderChannelSettings({ channels: [...pool.channels, channel], primaryProviderId }))
  return { pool: saved, channel: saved.channels.find((item) => item.id === requestedId), warning }
}

export async function updateProviderChannel(id, input) {
  const pool = await loadProviderConfigs()
  const channelId = providerId(id, '')
  const index = pool.channels.findIndex((channel) => channel.id === channelId)
  if (index < 0) throw providerError('模型通道不存在', 404)
  const prepared = await prepareChannel(input, pool.channels[index], { requireKey: false })
  const { warning, ...channel } = prepared
  channel.id = channelId
  const channels = pool.channels.map((item, itemIndex) => itemIndex === index ? channel : item)
  const primaryProviderId = input?.primary === true ? channelId : pool.primaryProviderId
  const saved = normalizeStoredPool(await saveProviderChannelSettings({ channels, primaryProviderId }))
  return { pool: saved, channel: saved.channels.find((item) => item.id === channelId), warning }
}

export async function deleteProviderChannel(id) {
  const pool = await loadProviderConfigs()
  const channelId = providerId(id, '')
  if (!pool.channels.some((channel) => channel.id === channelId)) throw providerError('模型通道不存在', 404)
  if (pool.channels.length === 1) throw providerError('至少保留一个模型通道；可以清空其 API Key 或将其停用', 409)
  const channels = pool.channels.filter((channel) => channel.id !== channelId)
  const primaryProviderId = pool.primaryProviderId === channelId ? channels[0].id : pool.primaryProviderId
  return normalizeStoredPool(await saveProviderChannelSettings({ channels, primaryProviderId }))
}

export async function resetProviderConfig() {
  const current = await loadProviderConfig()
  const stored = await saveProviderSettings({
    ...current,
    apiKey: '',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    apiMode: 'auto',
    models: [],
  })
  return normalizeStoredProvider(stored)
}

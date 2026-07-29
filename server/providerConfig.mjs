import { loadProviderSettings, saveProviderSettings } from './settings.mjs'

const supportedModes = new Set(['auto', 'responses', 'chat-completions'])

function text(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
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

export async function loadProviderConfig() {
  const stored = await loadProviderSettings()
  return {
    apiKey: text(stored.apiKey, 1000),
    baseURL: normalizeBaseUrl(stored.baseURL),
    model: text(stored.model, 200) || 'gpt-5-mini',
    apiMode: normalizeMode(stored.apiMode),
    models: Array.isArray(stored.models) ? stored.models.map((item) => text(item, 200)).filter(Boolean).slice(0, 300) : [],
    source: stored.source,
  }
}

export function publicProviderConfig(config) {
  return {
    configured: Boolean(config.apiKey),
    model: config.model,
    apiMode: config.apiMode,
    baseUrl: config.baseURL,
    provider: providerName(config.baseURL),
    keyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
    source: config.source,
    models: config.models,
  }
}

export function editableProviderConfig(config) {
  return { ...publicProviderConfig(config), key: config.apiKey }
}

export async function discoverModels(config) {
  try {
    const endpoint = new URL('models', `${config.baseURL.replace(/\/+$/, '')}/`)
    const response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: 'application/json',
      },
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

export async function saveProviderConfig(input) {
  if (input?._type && input._type !== 'newapi_channel_conn') throw new Error('不支持的连接配置类型')
  const current = await loadProviderConfig()
  const apiKey = text(input?.key, 1000) || current.apiKey
  if (!apiKey) throw new Error('请填写 API Key')
  const baseURL = normalizeBaseUrl(input?.url || current.baseURL)
  const apiMode = normalizeMode(input?.apiMode || current.apiMode)
  const requestedModel = text(input?.model, 200)
  let models = []
  let discoveryWarning = ''
  try {
    models = await discoverModels({ apiKey, baseURL })
  } catch (error) {
    if (!requestedModel) throw new Error(`无法自动获取模型列表：${error instanceof Error ? error.message : '连接失败'}。也可以填写明确的模型 ID 后保存。`)
    discoveryWarning = '模型列表不可用，已按手动模型 ID 保存。'
  }
  const model = pickModel(models, requestedModel)
  const stored = await saveProviderSettings({ apiKey, baseURL, model, apiMode, models })
  return { config: { ...stored, apiKey, baseURL, source: 'settings-ini' }, warning: discoveryWarning }
}

export async function resetProviderConfig() {
  const stored = await saveProviderSettings({
    apiKey: '',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    apiMode: 'auto',
    models: [],
  })
  return { ...stored, source: 'settings-ini' }
}

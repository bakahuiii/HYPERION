import { Activity, FileJson, Gauge, KeyRound, Plus, Power, RefreshCw, Save, ServerCog, Star, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  createAiProviderChannel,
  deleteAiProviderChannel,
  discoverAiModels,
  saveAiProvider,
  getAiStatus,
  updateAiProviderChannel,
  type AiChannelMutationResult,
  type AiProviderChannel,
  type AiProviderInput,
  type AiStatus,
} from '../lib/aiClient'
import { normalizeAiConcurrency } from '../lib/aiConcurrency'

interface AiProviderPoolProps {
  globalConcurrency: number
  onGlobalConcurrencyChange: (value: number) => void
}

interface ChannelDraft {
  name: string
  url: string
  key: string
  model: string
  apiMode: AiStatus['apiMode']
  enabled: boolean
  maxConcurrency: number
}

interface UsageSample {
  at: number
  active: number
  capacity: number
  queue: number
}

const EMPTY_DRAFT: ChannelDraft = {
  name: '',
  url: 'https://api.openai.com/v1',
  key: '',
  model: '',
  apiMode: 'auto',
  enabled: true,
  maxConcurrency: 4,
}

const PROVIDER_STATUS_CACHE_KEY = 'theia:ai-provider-status:v1'

function stripProviderSecrets(status: AiStatus): AiStatus {
  return {
    ...status,
    key: '',
    channels: status.channels?.map((channel) => ({ ...channel, key: '' })),
  }
}

function loadCachedProviderStatus(): AiStatus | null {
  try {
    const raw = window.localStorage.getItem(PROVIDER_STATUS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AiStatus
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.channels) && typeof parsed.model !== 'string') return null
    return stripProviderSecrets(parsed)
  } catch {
    return null
  }
}

function cacheProviderStatus(status: AiStatus) {
  try {
    window.localStorage.setItem(PROVIDER_STATUS_CACHE_KEY, JSON.stringify(stripProviderSecrets(status)))
  } catch { /* The cache is optional and must never block saving a model. */ }
}

function urlReady(value: string) {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  } catch {
    return false
  }
}

function channelDraft(channel: AiProviderChannel): ChannelDraft {
  return {
    name: channel.name,
    url: channel.baseUrl,
    key: channel.key,
    model: channel.model,
    apiMode: channel.apiMode,
    enabled: channel.enabled,
    maxConcurrency: normalizeAiConcurrency(channel.maxConcurrency),
  }
}

type AiProviderMutationResponse = AiStatus | AiChannelMutationResult

function poolFrom(result: AiProviderMutationResponse): AiStatus {
  return 'pool' in result && result.pool ? result.pool : result
}

function resultChannelId(result: AiProviderMutationResponse) {
  return 'channel' in result ? result.channel?.id : undefined
}

function channelStatusLabel(channel: AiProviderChannel) {
  const runtime = channel.runtime
  if (!channel.enabled) return '已停用'
  if (!channel.configured) return channel.configurationError || '未配置'
  if (runtime?.status === 'authentication-failed') return '认证失败'
  if (runtime?.status === 'cooling-down') {
    const remaining = Math.max(1, Math.ceil((runtime.cooldownRemainingMs || 0) / 100)) / 10
    return `短暂冷却 ${remaining.toFixed(1)}s`
  }
  if (runtime?.status === 'at-capacity') return '满载排队'
  if (runtime && runtime.effectiveMaxConcurrency < runtime.configuredMaxConcurrency) return '可用'
  return '可用'
}

function channelStatusClass(channel: AiProviderChannel) {
  if (!channel.enabled || !channel.configured) return 'is-muted'
  if (channel.runtime?.status === 'authentication-failed') return 'is-warn'
  if (channel.runtime?.status === 'cooling-down') return 'is-warn'
  if (channel.runtime?.status === 'at-capacity') return 'is-warn'
  return 'is-ready'
}

function channelHost(value: string) {
  try { return new URL(value).host } catch { return value || '未填写地址' }
}

export function AiProviderPool({ globalConcurrency, onGlobalConcurrencyChange }: AiProviderPoolProps) {
  const [status, setStatus] = useState<AiStatus | null>(() => loadCachedProviderStatus())
  const [selectedId, setSelectedId] = useState(() => {
    const cached = loadCachedProviderStatus()
    return cached?.primaryProviderId || cached?.id || cached?.channels?.[0]?.id || ''
  })
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [manualModelEntry, setManualModelEntry] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pollError, setPollError] = useState('')
  const [loading, setLoading] = useState(true)
  const [usageHistory, setUsageHistory] = useState<UsageSample[]>([])
  const configInputRef = useRef<HTMLInputElement>(null)
  const probeSignatureRef = useRef('')
  const refreshInFlightRef = useRef(false)
  const statusRequestRef = useRef<AbortController | null>(null)
  const refreshSequenceRef = useRef(0)
  const autoFilledCapacityRef = useRef(0)
  const statusRef = useRef<AiStatus | null>(null)
  const probePendingRef = useRef(false)
  const probeControllerRef = useRef<AbortController | null>(null)
  const probeRevisionRef = useRef(0)

  const channels = useMemo<AiProviderChannel[]>(() => {
    if (status?.channels?.length) return status.channels
    if (!status) return []
    return [{
      id: status.id || 'primary',
      name: status.name || status.provider || '主通道',
      enabled: status.enabled !== false,
      configured: status.configured,
      key: status.key,
      model: status.model,
      apiMode: status.apiMode,
      baseUrl: status.baseUrl,
      provider: status.provider,
      keyHint: status.keyHint,
      source: status.source,
      models: status.models,
      maxConcurrency: status.maxConcurrency || 4,
      configurationError: status.configurationError,
    }]
  }, [status])

  const selectedChannel = channels.find((channel) => channel.id === selectedId)
  const selectedSignature = selectedChannel
    ? [selectedChannel.id, selectedChannel.name, selectedChannel.baseUrl, selectedChannel.key, selectedChannel.model, selectedChannel.apiMode, selectedChannel.enabled, selectedChannel.maxConcurrency].join('\u0000')
    : ''

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const refresh = useCallback(async (force = false) => {
    // A normal poll reuses an in-flight read. A user-triggered refresh must
    // instead replace it: an older build may have sent that read through the
    // saturated Vite origin, where it can remain queued behind model requests.
    if (refreshInFlightRef.current) {
      if (!force) return
      statusRequestRef.current?.abort()
    }
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    refreshInFlightRef.current = true
    const controller = new AbortController()
    statusRequestRef.current = controller
    let timedOut = false
    const requestTimeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 15_000)
    const slowResponseTimer = window.setTimeout(() => {
      setPollError('本机代理响应较慢，仍在继续读取通道状态。')
    }, 8000)
    if (!statusRef.current) setLoading(true)
    try {
      const next = await getAiStatus(controller.signal)
      if (sequence !== refreshSequenceRef.current) return
      statusRef.current = next
      setStatus(next)
      cacheProviderStatus(next)
      setPollError('')
      if (next.scheduler) {
        setUsageHistory((current) => [...current, {
          at: Date.now(),
          active: next.scheduler?.activeRequests ?? 0,
          capacity: next.scheduler?.effectiveMaxConcurrency ?? next.scheduler?.totalMaxConcurrency ?? 0,
          queue: next.scheduler?.queueDepth ?? 0,
        }].slice(-24))
      }
      setSelectedId((current) => {
        const available = next.channels?.map((channel) => channel.id) ?? []
        if (current && available.includes(current)) return current
        return next.primaryProviderId || next.id || available[0] || 'primary'
      })
    } catch (error) {
      if (sequence !== refreshSequenceRef.current) return
      if (error instanceof Error && error.name === 'AbortError') {
        setPollError(timedOut ? '读取通道状态超时；已保留上一次可用状态，将自动重试。' : '通道状态读取已取消；将自动重试。')
      } else {
        setPollError(error instanceof Error ? error.message : '无法连接本机模型代理。')
      }
    } finally {
      window.clearTimeout(requestTimeout)
      window.clearTimeout(slowResponseTimer)
      if (sequence === refreshSequenceRef.current) {
        statusRequestRef.current = null
        refreshInFlightRef.current = false
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => { void refresh() }, 0)
    const pollTimer = window.setInterval(() => { void refresh() }, 5000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(pollTimer)
      statusRequestRef.current?.abort()
      probeControllerRef.current?.abort()
    }
  }, [refresh])

  useEffect(() => {
    if (creating || dirty || !selectedSignature || !selectedChannel) return
    const timer = window.setTimeout(() => {
      setDraft(channelDraft(selectedChannel))
      setModels(selectedChannel.models)
      setManualModelEntry(Boolean(selectedChannel.model) && !selectedChannel.models.includes(selectedChannel.model))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [creating, dirty, selectedChannel, selectedSignature])

  const updateDraft = (update: Partial<ChannelDraft>) => {
    setDraft((current) => ({ ...current, ...update }))
    setDirty(true)
    if (update.url !== undefined || update.key !== undefined) {
      probeRevisionRef.current += 1
      probeControllerRef.current?.abort()
      probePendingRef.current = true
      setModels([])
      probeSignatureRef.current = ''
    }
  }

  const selectChannel = (id: string) => {
    if (id === selectedId) return
    if (dirty && !window.confirm('当前通道有未保存更改，确定切换吗？')) return
    setCreating(false)
    setDirty(false)
    probePendingRef.current = false
    setModels([])
    setManualModelEntry(false)
    setSelectedId(id)
  }

  const addChannel = () => {
    if (dirty && !window.confirm('当前通道有未保存更改，确定放弃并添加新通道吗？')) return
    setCreating(true)
    setDirty(false)
    probePendingRef.current = false
    setSelectedId('')
    setModels([])
    setManualModelEntry(true)
    setDraft({ ...EMPTY_DRAFT, name: `通道 ${channels.length + 1}` })
    setMessage('已准备新通道；填写地址与 API Key 后会自动检测模型。')
  }

  const probe = useCallback(async () => {
    if (busy || !urlReady(draft.url) || !draft.key.trim()) return
    const revision = probeRevisionRef.current
    const controller = new AbortController()
    probeControllerRef.current?.abort()
    probeControllerRef.current = controller
    setBusy(true)
    try {
      const result = await discoverAiModels({ _type: 'newapi_channel_conn', key: draft.key, url: draft.url, apiMode: draft.apiMode }, controller.signal)
      if (controller.signal.aborted || revision !== probeRevisionRef.current) return
      setModels(result.models)
      setManualModelEntry(false)
      setDraft((current) => ({ ...current, model: result.models.includes(current.model) ? current.model : result.models[0] || current.model }))
      // Keep a completed discovery visible until it is saved. Otherwise the
      // next status poll can restore the channel's older cached model list.
      setDirty(true)
      setMessage(`检测到 ${result.models.length} 个模型，可在下方选择。`)
    } catch (error) {
      if (controller.signal.aborted || revision !== probeRevisionRef.current) return
      setModels([])
      setMessage(error instanceof Error ? error.message : '模型列表检测失败。')
    } finally {
      if (probeControllerRef.current === controller) {
        probeControllerRef.current = null
        setBusy(false)
      }
    }
  }, [busy, draft.apiMode, draft.key, draft.url])

  useEffect(() => {
    // Only connection changes need discovery. Editing a display name, model,
    // mode, or capacity must never start a long-running probe and disable save.
    if (!probePendingRef.current || !dirty || busy || !urlReady(draft.url) || !draft.key.trim()) return
    const signature = `${selectedId}\u0000${draft.url}\u0000${draft.key}`
    if (signature === probeSignatureRef.current) {
      probePendingRef.current = false
      return
    }
    const timer = window.setTimeout(() => {
      probePendingRef.current = false
      probeSignatureRef.current = signature
      void probe()
    }, 800)
    return () => window.clearTimeout(timer)
  }, [busy, dirty, draft.key, draft.url, probe, selectedId])

  const save = async () => {
    if (busy || !draft.model.trim()) {
      setMessage('请先选择或输入模型 ID。')
      return
    }
    const connectionReady = urlReady(draft.url) && Boolean(draft.key.trim())
    setBusy(true)
    setMessage('正在保存模型通道…')
    // Model selection is independent from discovery and connection health. If
    // an existing channel is temporarily unavailable, persist only the model
    // field so the next request uses it without overwriting the last known
    // connection details.
    const input: AiProviderInput = connectionReady || creating
      ? {
        _type: 'newapi_channel_conn',
        name: draft.name.trim() || (creating ? `通道 ${channels.length + 1}` : selectedChannel?.name || '模型通道'),
        key: draft.key,
        url: draft.url,
        model: draft.model.trim(),
        apiMode: draft.apiMode,
        models,
        enabled: draft.enabled,
        maxConcurrency: normalizeAiConcurrency(draft.maxConcurrency),
      }
      : { model: draft.model.trim(), name: draft.name.trim() || selectedChannel?.name || 'Model channel' }
    try {
      const result = creating
        ? await createAiProviderChannel(input)
        : selectedId
          ? await updateAiProviderChannel(selectedId, input)
          : await saveAiProvider(input)
      const next = poolFrom(result)
      setStatus(next)
      cacheProviderStatus(next)
      setCreating(false)
      setDirty(false)
      probePendingRef.current = false
      setSelectedId(resultChannelId(result) || next.primaryProviderId || selectedId)
      setMessage(result.warning || `已保存 ${input.name}；通道池总容量 ${next.totalMaxConcurrency ?? next.scheduler?.totalMaxConcurrency ?? input.maxConcurrency}。`)
      // A five-second status poll may have started before this mutation. It
      // must be aborted before reading the new state, otherwise its stale
      // response can put the old draft back into the editor.
      await refresh(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '模型通道保存失败。')
    } finally {
      setBusy(false)
    }
  }

  const toggleChannel = async (channel: AiProviderChannel) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await updateAiProviderChannel(channel.id, { enabled: !channel.enabled })
      setStatus(poolFrom(result))
      cacheProviderStatus(poolFrom(result))
      setMessage(`${channel.name} 已${channel.enabled ? '停用' : '启用'}。`)
      setDirty(false)
      probePendingRef.current = false
      await refresh(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '通道状态更新失败。')
    } finally {
      setBusy(false)
    }
  }

  const makePrimary = async (channel: AiProviderChannel) => {
    if (busy || status?.primaryProviderId === channel.id) return
    setBusy(true)
    try {
      const result = await updateAiProviderChannel(channel.id, { primary: true })
      setStatus(poolFrom(result))
      cacheProviderStatus(poolFrom(result))
      setMessage(`${channel.name} 已设为主通道。`)
      probePendingRef.current = false
      await refresh(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '主通道设置失败。')
    } finally {
      setBusy(false)
    }
  }

  const removeChannel = async (channel: AiProviderChannel) => {
    if (busy || !window.confirm(`确定删除“${channel.name}”吗？这会从本机 INI 中移除该通道，但不会删除聊天记录。`)) return
    setBusy(true)
    try {
      const next = await deleteAiProviderChannel(channel.id)
      setStatus(next)
      cacheProviderStatus(next)
      setDirty(false)
      probePendingRef.current = false
      setSelectedId(next.primaryProviderId || next.channels?.[0]?.id || '')
      setMessage(`已删除 ${channel.name}。`)
      await refresh(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '通道删除失败。')
    } finally {
      setBusy(false)
    }
  }

  const importConnection = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const input = JSON.parse(await file.text()) as AiProviderInput
      if (input._type && input._type !== 'newapi_channel_conn') throw new Error('不支持的连接配置类型')
      if (!input.url && !input.baseURL) throw new Error('连接 JSON 缺少 url')
      setBusy(true)
      const result = await createAiProviderChannel({ ...input, _type: 'newapi_channel_conn', name: input.name || file.name.replace(/\.json$/i, '') })
      const next = poolFrom(result)
      setStatus(next)
      cacheProviderStatus(next)
      setCreating(false)
      setDirty(false)
      probePendingRef.current = false
      setSelectedId(resultChannelId(result) || next.channels?.at(-1)?.id || '')
      setMessage(result.warning || `已导入并新增 ${input.name || file.name}。`)
      await refresh(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '连接配置无法解析。')
    } finally {
      setBusy(false)
    }
  }

  const scheduler = status?.scheduler
  const totalCapacity = scheduler?.totalMaxConcurrency ?? status?.totalMaxConcurrency ?? channels.filter((channel) => channel.enabled && channel.configured).reduce((sum, channel) => sum + channel.maxConcurrency, 0)
  const effectiveCapacity = scheduler?.effectiveMaxConcurrency ?? totalCapacity
  const suggestedConcurrency = normalizeAiConcurrency(totalCapacity || globalConcurrency)
  const activeChannel = selectedChannel || null

  useEffect(() => {
    // The user explicitly chose to fill all configured channels. Apply that
    // once for a newly observed larger pool, but preserve a later manual
    // reduction instead of continually forcing the value back up.
    if (!totalCapacity || globalConcurrency >= suggestedConcurrency || autoFilledCapacityRef.current === suggestedConcurrency) return
    autoFilledCapacityRef.current = suggestedConcurrency
    onGlobalConcurrencyChange(suggestedConcurrency)
  }, [globalConcurrency, onGlobalConcurrencyChange, suggestedConcurrency, totalCapacity])

  return <section className="options-section provider-pool-section">
    <div className="options-heading">
      <div><ServerCog size={18} /><div><h3>模型通道池</h3><p>多个 API 会按各自容量持续分流；429、502、503 或超时只记录失败，不暂停或降低已保存的通道容量。Key 由当前系统账户加密保存，不写入日志。</p></div></div>
      <div className="provider-pool-heading-actions"><span className={`ai-status ${status?.configured ? 'is-ready' : ''}`}>{status?.configuredChannelCount ?? channels.filter((channel) => channel.enabled && channel.configured).length} 路已配置 · 配置并发 {totalCapacity || 0}</span><button type="button" className="icon-button" title="刷新通道状态" aria-label="刷新通道状态" onClick={() => void refresh(true)}><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /></button></div>
    </div>
    <div className="provider-usage-dashboard" aria-label="API 与通道使用率">
      <div className="provider-usage-overview">
        <div className="provider-usage-overview-heading"><div><strong>实时使用率</strong><span>每 5 秒刷新，保留最近 24 个采样</span></div><b>{scheduler?.activeRequests ?? 0}/{effectiveCapacity || 0}</b></div>
        <div className="provider-usage-meter" role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(1, effectiveCapacity)} aria-valuenow={scheduler?.activeRequests ?? 0} aria-label="总通道使用率"><span style={{ width: `${effectiveCapacity ? Math.min(100, Math.round(((scheduler?.activeRequests ?? 0) / effectiveCapacity) * 100)) : 0}%` }} /></div>
        <div className="provider-usage-meta"><span>活动请求 {scheduler?.activeRequests ?? 0}</span><span>空闲槽位 {scheduler?.availableCapacity ?? totalCapacity}</span><span>排队 {scheduler?.queueDepth ?? 0}</span></div>
        <div className="provider-usage-history" aria-label="最近使用率"><span className="provider-usage-history-scale">100%</span>{usageHistory.length ? usageHistory.map((sample) => { const percent = sample.capacity ? Math.round((sample.active / sample.capacity) * 100) : 0; return <span key={sample.at} title={`${new Date(sample.at).toLocaleTimeString('zh-CN', { hour12: false })} · ${sample.active}/${sample.capacity}`} style={{ height: `${Math.max(4, percent)}%` }} /> }) : <em>等待第一次状态采样</em>}</div>
      </div>
      <div className="provider-usage-channels"><div className="provider-usage-channels-heading"><strong>通道利用率</strong><span>活动 / 当前容量</span></div>{channels.map((channel) => { const active = channel.runtime?.activeRequests ?? 0; const capacity = Math.max(1, (channel.runtime?.effectiveMaxConcurrency ?? channel.maxConcurrency) || 1); const percent = Math.min(100, Math.round((active / capacity) * 100)); return <div className="provider-usage-channel" key={channel.id}><div className="provider-usage-channel-label"><span title={channel.name}>{channel.name}</span><b>{active}/{capacity}</b></div><div className="provider-channel-meter" role="progressbar" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={active} aria-label={`${channel.name} 使用率`}><span className={percent >= 100 ? 'is-full' : ''} style={{ width: `${percent}%` }} /></div><small>{channel.runtime?.successfulRequests ?? 0} 成功 · {channel.runtime?.failedRequests ?? 0} 失败</small></div> })}</div>
    </div>
    <div className="provider-pool-summary">
      <span><Activity size={14} />队列 {scheduler?.queueDepth ?? 0}</span>
      <span><Gauge size={14} />运行中 {scheduler?.activeRequests ?? 0}</span>
      <span>可用槽位 {scheduler?.availableCapacity ?? totalCapacity}</span>
      <span className="is-ready">持续调度</span>
      {totalCapacity > 0 && <button type="button" className="text-button" onClick={() => onGlobalConcurrencyChange(suggestedConcurrency)} disabled={normalizeAiConcurrency(globalConcurrency) === suggestedConcurrency}>将全局并发设为 {suggestedConcurrency}</button>}
    </div>
    <div className="provider-pool-layout">
      <div className="provider-channel-browser">
        <div className="provider-channel-browser-heading"><strong>已配置通道</strong><button type="button" className="secondary-button" onClick={addChannel} disabled={busy}><Plus size={15} />添加通道</button></div>
        <div className="provider-channel-list">
          {channels.map((channel) => <article className={`provider-channel-row ${channel.id === selectedId && !creating ? 'is-selected' : ''}`} key={channel.id}>
            <button type="button" className="provider-channel-select" onClick={() => selectChannel(channel.id)} aria-pressed={channel.id === selectedId && !creating}>
              <span className={`provider-channel-dot ${channelStatusClass(channel)}`} />
              <span className="provider-channel-copy"><strong>{channel.name}</strong><small>{channelHost(channel.baseUrl)} · {channel.model || '未选择模型'}{(channel.sharedCredentialCount ?? 0) > 1 ? ` · 共用凭据 ×${channel.sharedCredentialCount}` : ''}</small></span>
              <span className={`provider-channel-status ${channelStatusClass(channel)}`}>{channelStatusLabel(channel)}</span>
              <span className="provider-channel-capacity">{channel.runtime?.activeRequests ?? 0}/{channel.maxConcurrency}</span>
            </button>
            <div className="provider-channel-actions">
              <button type="button" className="icon-button" title={channel.enabled ? '停用通道' : '启用通道'} aria-label={channel.enabled ? `停用${channel.name}` : `启用${channel.name}`} onClick={() => void toggleChannel(channel)} disabled={busy}><Power size={14} /></button>
              <button type="button" className={`icon-button ${status?.primaryProviderId === channel.id ? 'is-active' : ''}`} title={status?.primaryProviderId === channel.id ? '主通道' : '设为主通道'} aria-label={status?.primaryProviderId === channel.id ? `${channel.name}是主通道` : `将${channel.name}设为主通道`} onClick={() => void makePrimary(channel)} disabled={busy || status?.primaryProviderId === channel.id}><Star size={14} /></button>
              <button type="button" className="icon-button provider-channel-delete" title="删除通道" aria-label={`删除${channel.name}`} onClick={() => void removeChannel(channel)} disabled={busy || channels.length <= 1}><Trash2 size={14} /></button>
            </div>
          </article>)}
          {loading && !channels.length && <p className="provider-empty">正在读取本机代理通道…</p>}
          {!loading && !channels.length && <p className="provider-empty">尚未读取到通道，请确认本机代理正在运行。</p>}
        </div>
        {pollError && <div className="provider-poll-error"><p className="provider-message is-error" role="status">{pollError}</p><button type="button" className="secondary-button" onClick={() => void refresh(true)}><RefreshCw size={14} />重试</button></div>}
      </div>
      <div className="provider-channel-editor">
        <div className="provider-channel-editor-heading"><div><span className="section-kicker">CHANNEL EDITOR</span><h4>{creating ? '添加模型通道' : activeChannel?.name || '选择一个通道'}</h4></div><span>{creating ? '尚未保存' : activeChannel?.keyHint || '未配置 Key'}</span></div>
        <div className="provider-fields provider-fields--pool">
          <label><span>通道名称</span><input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="例如：主中转" /></label>
          <label className="provider-field-wide"><span>服务地址</span><input type="url" value={draft.url} onChange={(event) => updateDraft({ url: event.target.value })} placeholder="https://relay.example.com/v1" /></label>
          <label className="provider-field-wide"><span>API Key</span><div className="provider-key-input"><KeyRound size={14} /><input type="text" autoComplete="off" spellCheck={false} value={draft.key} onChange={(event) => updateDraft({ key: event.target.value })} placeholder="由当前系统账户加密保存" /></div></label>
          <label className="provider-model-field"><span>模型 ID</span>{models.length > 0 && <select value={manualModelEntry || !models.includes(draft.model) ? '__manual__' : draft.model} onChange={(event) => { if (event.target.value === '__manual__') setManualModelEntry(true); else { setManualModelEntry(false); updateDraft({ model: event.target.value }) } }}><option value="__manual__">手动输入模型 ID</option>{models.map((item) => <option value={item} key={item}>{item}</option>)}</select>}{(manualModelEntry || models.length === 0) && <input value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })} placeholder="输入模型 ID" />}</label>
          <label><span>接口模式</span><select value={draft.apiMode} onChange={(event) => updateDraft({ apiMode: event.target.value as AiStatus['apiMode'] })}><option value="auto">自动兼容</option><option value="responses">Responses API</option><option value="chat-completions">Chat Completions</option></select></label>
          <label><span>通道并发容量</span><select value={normalizeAiConcurrency(draft.maxConcurrency)} onChange={(event) => updateDraft({ maxConcurrency: Number(event.target.value) })}>{Array.from({ length: 8 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 个请求</option>)}</select></label>
          <label className="provider-enabled-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.target.checked })} /><span>参与自动分流</span></label>
        </div>
        <div className="provider-actions"><button type="button" className="secondary-button" onClick={() => void probe()} disabled={busy || !urlReady(draft.url) || !draft.key.trim()}><RefreshCw size={15} />{busy ? '处理中' : '检测模型'}</button><button type="button" className="primary-button" onClick={() => void save()} disabled={busy || (!creating && !selectedId && !draft.model.trim())}><Save size={15} />保存通道</button><input ref={configInputRef} type="file" accept=".json,application/json" onChange={(event) => void importConnection(event)} hidden /><button type="button" className="secondary-button" onClick={() => configInputRef.current?.click()} disabled={busy}><FileJson size={15} />导入为新通道</button></div>
        {activeChannel?.runtime?.status === 'authentication-failed' && <p className="provider-message is-error" role="alert">上游已明确拒绝当前 API Key。请替换为属于该服务地址的有效 Key，再点击“检测模型”和“保存通道”。</p>}
        {message && <p className="provider-message" role="status">{message}</p>}
      </div>
    </div>
  </section>
}

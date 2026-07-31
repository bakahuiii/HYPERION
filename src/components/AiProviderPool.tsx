import { Activity, FileJson, Gauge, KeyRound, Plus, Power, RefreshCw, Save, ServerCog, Star, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  createAiProviderChannel,
  deleteAiProviderChannel,
  discoverAiModels,
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

const EMPTY_DRAFT: ChannelDraft = {
  name: '',
  url: 'https://api.openai.com/v1',
  key: '',
  model: '',
  apiMode: 'auto',
  enabled: true,
  maxConcurrency: 4,
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

function poolFrom(result: AiChannelMutationResult): AiStatus {
  return result.pool ?? result
}

function channelStatusLabel(channel: AiProviderChannel) {
  const runtime = channel.runtime
  if (!channel.enabled) return '已停用'
  if (!channel.configured) return channel.configurationError || '未配置'
  if (runtime?.status === 'cooling-down') {
    const seconds = Math.max(1, Math.ceil((runtime.cooldownRemainingMs || 0) / 1000))
    return `冷却中 ${seconds}s`
  }
  if (runtime?.status === 'at-capacity') return '满载排队'
  return '可用'
}

function channelStatusClass(channel: AiProviderChannel) {
  if (!channel.enabled || !channel.configured) return 'is-muted'
  if (channel.runtime?.status === 'cooling-down' || channel.runtime?.status === 'at-capacity') return 'is-warn'
  return 'is-ready'
}

function channelHost(value: string) {
  try { return new URL(value).host } catch { return value || '未填写地址' }
}

export function AiProviderPool({ globalConcurrency, onGlobalConcurrencyChange }: AiProviderPoolProps) {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pollError, setPollError] = useState('')
  const configInputRef = useRef<HTMLInputElement>(null)
  const probeSignatureRef = useRef('')

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

  const refresh = useCallback(async () => {
    try {
      const next = await getAiStatus()
      setStatus(next)
      setPollError('')
      setSelectedId((current) => {
        const available = next.channels?.map((channel) => channel.id) ?? []
        if (current && available.includes(current)) return current
        return next.primaryProviderId || next.id || available[0] || 'primary'
      })
    } catch (error) {
      setPollError(error instanceof Error ? error.message : '无法连接本机模型代理。')
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => { void refresh() }, 0)
    const pollTimer = window.setInterval(() => { void refresh() }, 5000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(pollTimer)
    }
  }, [refresh])

  useEffect(() => {
    if (creating || dirty || !selectedSignature || !selectedChannel) return
    const timer = window.setTimeout(() => {
      setDraft(channelDraft(selectedChannel))
      setModels(selectedChannel.models)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [creating, dirty, selectedChannel, selectedSignature])

  const updateDraft = (update: Partial<ChannelDraft>) => {
    setDraft((current) => ({ ...current, ...update }))
    setDirty(true)
    if (update.url !== undefined || update.key !== undefined) {
      setModels([])
      probeSignatureRef.current = ''
    }
  }

  const selectChannel = (id: string) => {
    if (id === selectedId) return
    if (dirty && !window.confirm('当前通道有未保存更改，确定切换吗？')) return
    setCreating(false)
    setDirty(false)
    setModels([])
    setSelectedId(id)
  }

  const addChannel = () => {
    if (dirty && !window.confirm('当前通道有未保存更改，确定放弃并添加新通道吗？')) return
    setCreating(true)
    setDirty(false)
    setSelectedId('')
    setModels([])
    setDraft({ ...EMPTY_DRAFT, name: `通道 ${channels.length + 1}` })
    setMessage('已准备新通道；填写地址与 API Key 后会自动检测模型。')
  }

  const probe = useCallback(async () => {
    if (busy || !urlReady(draft.url) || !draft.key.trim()) return
    setBusy(true)
    try {
      const result = await discoverAiModels({ _type: 'newapi_channel_conn', key: draft.key, url: draft.url, apiMode: draft.apiMode })
      setModels(result.models)
      setDraft((current) => ({ ...current, model: result.models.includes(current.model) ? current.model : result.models[0] || current.model }))
      setMessage(`检测到 ${result.models.length} 个模型，可在下方选择。`)
    } catch (error) {
      setModels([])
      setMessage(error instanceof Error ? error.message : '模型列表检测失败。')
    } finally {
      setBusy(false)
    }
  }, [busy, draft.apiMode, draft.key, draft.url])

  useEffect(() => {
    if (!dirty || busy || !urlReady(draft.url) || !draft.key.trim()) return
    const signature = `${selectedId}\u0000${draft.url}\u0000${draft.key}`
    if (signature === probeSignatureRef.current) return
    const timer = window.setTimeout(() => {
      probeSignatureRef.current = signature
      void probe()
    }, 800)
    return () => window.clearTimeout(timer)
  }, [busy, dirty, draft.key, draft.url, probe, selectedId])

  const save = async () => {
    if (busy || !urlReady(draft.url) || !draft.key.trim() || !draft.model.trim()) {
      setMessage('请填写有效的 HTTPS 服务地址、API Key 和模型 ID。')
      return
    }
    setBusy(true)
    setMessage('正在保存模型通道…')
    const input: AiProviderInput = {
      _type: 'newapi_channel_conn',
      name: draft.name.trim() || (creating ? `通道 ${channels.length + 1}` : selectedChannel?.name || '模型通道'),
      key: draft.key,
      url: draft.url,
      model: draft.model.trim(),
      apiMode: draft.apiMode,
      enabled: draft.enabled,
      maxConcurrency: normalizeAiConcurrency(draft.maxConcurrency),
    }
    try {
      const result = creating
        ? await createAiProviderChannel(input)
        : await updateAiProviderChannel(selectedId, input)
      const next = poolFrom(result)
      setStatus(next)
      setCreating(false)
      setDirty(false)
      setSelectedId(result.channel?.id || next.primaryProviderId || selectedId)
      setMessage(result.warning || `已保存 ${input.name}；通道池总容量 ${next.totalMaxConcurrency ?? next.scheduler?.totalMaxConcurrency ?? input.maxConcurrency}。`)
      await refresh()
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
      setMessage(`${channel.name} 已${channel.enabled ? '停用' : '启用'}。`)
      setDirty(false)
      await refresh()
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
      setMessage(`${channel.name} 已设为主通道。`)
      await refresh()
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
      setDirty(false)
      setSelectedId(next.primaryProviderId || next.channels?.[0]?.id || '')
      setMessage(`已删除 ${channel.name}。`)
      await refresh()
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
      setCreating(false)
      setDirty(false)
      setSelectedId(result.channel?.id || next.channels?.at(-1)?.id || '')
      setMessage(result.warning || `已导入并新增 ${input.name || file.name}。`)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '连接配置无法解析。')
    } finally {
      setBusy(false)
    }
  }

  const scheduler = status?.scheduler
  const totalCapacity = scheduler?.totalMaxConcurrency ?? status?.totalMaxConcurrency ?? channels.filter((channel) => channel.enabled && channel.configured).reduce((sum, channel) => sum + channel.maxConcurrency, 0)
  const suggestedConcurrency = normalizeAiConcurrency(totalCapacity || globalConcurrency)
  const activeChannel = selectedChannel || null

  return <section className="options-section provider-pool-section">
    <div className="options-heading">
      <div><ServerCog size={18} /><div><h3>模型通道池</h3><p>多个 API 会按各自容量分流；某一路 502、429 或超时会进入短暂冷却，不会阻塞其它通道。Key 明文保存在本机通用 INI，不写入日志。</p></div></div>
      <span className={`ai-status ${status?.configured ? 'is-ready' : ''}`}>{status?.configuredChannelCount ?? channels.filter((channel) => channel.enabled && channel.configured).length} 路可用 · 总并发 {totalCapacity || 0}</span>
    </div>
    <div className="provider-pool-summary">
      <span><Activity size={14} />队列 {scheduler?.queueDepth ?? 0}</span>
      <span><Gauge size={14} />运行中 {scheduler?.activeRequests ?? 0}</span>
      <span>可用槽位 {scheduler?.availableCapacity ?? totalCapacity}</span>
      {scheduler?.coolingDownChannelCount ? <span className="is-warn">冷却 {scheduler.coolingDownChannelCount} 路</span> : <span className="is-ready">无冷却通道</span>}
      {totalCapacity > 0 && <button type="button" className="text-button" onClick={() => onGlobalConcurrencyChange(suggestedConcurrency)} disabled={normalizeAiConcurrency(globalConcurrency) === suggestedConcurrency}>将全局并发设为 {suggestedConcurrency}</button>}
    </div>
    <div className="provider-pool-layout">
      <div className="provider-channel-browser">
        <div className="provider-channel-browser-heading"><strong>已配置通道</strong><button type="button" className="secondary-button" onClick={addChannel} disabled={busy}><Plus size={15} />添加通道</button></div>
        <div className="provider-channel-list">
          {channels.map((channel) => <article className={`provider-channel-row ${channel.id === selectedId && !creating ? 'is-selected' : ''}`} key={channel.id}>
            <button type="button" className="provider-channel-select" onClick={() => selectChannel(channel.id)} aria-pressed={channel.id === selectedId && !creating}>
              <span className={`provider-channel-dot ${channelStatusClass(channel)}`} />
              <span className="provider-channel-copy"><strong>{channel.name}</strong><small>{channelHost(channel.baseUrl)} · {channel.model || '未选择模型'}</small></span>
              <span className={`provider-channel-status ${channelStatusClass(channel)}`}>{channelStatusLabel(channel)}</span>
              <span className="provider-channel-capacity">{channel.runtime?.activeRequests ?? 0}/{channel.maxConcurrency}</span>
            </button>
            <div className="provider-channel-actions">
              <button type="button" className="icon-button" title={channel.enabled ? '停用通道' : '启用通道'} aria-label={channel.enabled ? `停用${channel.name}` : `启用${channel.name}`} onClick={() => void toggleChannel(channel)} disabled={busy}><Power size={14} /></button>
              <button type="button" className={`icon-button ${status?.primaryProviderId === channel.id ? 'is-active' : ''}`} title={status?.primaryProviderId === channel.id ? '主通道' : '设为主通道'} aria-label={status?.primaryProviderId === channel.id ? `${channel.name}是主通道` : `将${channel.name}设为主通道`} onClick={() => void makePrimary(channel)} disabled={busy || status?.primaryProviderId === channel.id}><Star size={14} /></button>
              <button type="button" className="icon-button provider-channel-delete" title="删除通道" aria-label={`删除${channel.name}`} onClick={() => void removeChannel(channel)} disabled={busy || channels.length <= 1}><Trash2 size={14} /></button>
            </div>
          </article>)}
          {!channels.length && <p className="provider-empty">尚未读取通道。请确认本机代理正在运行。</p>}
        </div>
        {pollError && <p className="provider-message is-error" role="status">{pollError}</p>}
      </div>
      <div className="provider-channel-editor">
        <div className="provider-channel-editor-heading"><div><span className="section-kicker">CHANNEL EDITOR</span><h4>{creating ? '添加模型通道' : activeChannel?.name || '选择一个通道'}</h4></div><span>{creating ? '尚未保存' : activeChannel?.keyHint || '未配置 Key'}</span></div>
        <div className="provider-fields provider-fields--pool">
          <label><span>通道名称</span><input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="例如：主中转" /></label>
          <label className="provider-field-wide"><span>服务地址</span><input type="url" value={draft.url} onChange={(event) => updateDraft({ url: event.target.value })} placeholder="https://relay.example.com/v1" /></label>
          <label className="provider-field-wide"><span>API Key</span><div className="provider-key-input"><KeyRound size={14} /><input type="text" autoComplete="off" spellCheck={false} value={draft.key} onChange={(event) => updateDraft({ key: event.target.value })} placeholder="明文保存在本机 INI" /></div></label>
          <label><span>模型 ID</span>{models.length ? <select value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })}>{models.map((item) => <option value={item} key={item}>{item}</option>)}</select> : <input value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })} placeholder="输入地址与 Key 后自动获取" />}</label>
          <label><span>接口模式</span><select value={draft.apiMode} onChange={(event) => updateDraft({ apiMode: event.target.value as AiStatus['apiMode'] })}><option value="auto">自动兼容</option><option value="responses">Responses API</option><option value="chat-completions">Chat Completions</option></select></label>
          <label><span>通道并发容量</span><select value={normalizeAiConcurrency(draft.maxConcurrency)} onChange={(event) => updateDraft({ maxConcurrency: Number(event.target.value) })}>{Array.from({ length: 8 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 个请求</option>)}</select></label>
          <label className="provider-enabled-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.target.checked })} /><span>参与自动分流</span></label>
        </div>
        <div className="provider-actions"><button type="button" className="secondary-button" onClick={() => void probe()} disabled={busy || !urlReady(draft.url) || !draft.key.trim()}><RefreshCw size={15} />{busy ? '处理中' : '检测模型'}</button><button type="button" className="primary-button" onClick={() => void save()} disabled={busy || !creating && !selectedId}><Save size={15} />保存通道</button><input ref={configInputRef} type="file" accept=".json,application/json" onChange={(event) => void importConnection(event)} hidden /><button type="button" className="secondary-button" onClick={() => configInputRef.current?.click()} disabled={busy}><FileJson size={15} />导入为新通道</button></div>
        {message && <p className="provider-message" role="status">{message}</p>}
      </div>
    </div>
  </section>
}

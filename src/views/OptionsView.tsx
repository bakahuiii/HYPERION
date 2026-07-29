import { CheckCircle2, ChevronDown, ChevronRight, FileJson, FilePenLine, HardDrive, KeyRound, Palette, RefreshCw, Save, ServerCog, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { discoverAiModels, getAiStatus, resetAiProvider, saveAiProvider, type AiProviderInput, type AiStatus } from '../lib/aiClient'
import { loadStorageOverview, type StorageOverview } from '../lib/storageOverview'
import { defaultPromptInstructions } from '../lib/storage'
import type { AiSettings } from '../types'

interface OptionsViewProps {
  settings: AiSettings
  onSettingsChange: (settings: AiSettings) => void
  onAppearance: () => void
  personCount: number
  questCount: number
  onClearPeople: () => void
  onClearQuests: () => void
}

function urlReady(value: string) {
  try { const url = new URL(value.trim()); return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) } catch { return false }
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value) || value === undefined) return '未计算大小'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatFeedbackTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function OptionsView({ settings, onSettingsChange, onAppearance, personCount, questCount, onClearPeople, onClearQuests }: OptionsViewProps) {
  const touched = useRef(false)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<AiStatus['apiMode']>('auto')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [storage, setStorage] = useState<StorageOverview | null>(null)
  const [storageOpen, setStorageOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [promptKind, setPromptKind] = useState<keyof AiSettings['promptInstructions']>('task')
  const [storageMessage, setStorageMessage] = useState('正在读取本机存储概览…')
  const detected = useRef('')
  const configInputRef = useRef<HTMLInputElement>(null)
  const availableModels = models.length ? models : key.trim() ? [] : status?.models ?? []

  const applyStatus = useCallback((next: AiStatus, preserve = false) => {
    setStatus(next); setModels(next.models)
    if (preserve && touched.current) return
    touched.current = false; setUrl(next.baseUrl); setKey(next.key); setModel(next.model); setMode(next.apiMode)
  }, [])

  useEffect(() => { void getAiStatus().then((next) => applyStatus(next, true)).catch(() => setMessage('无法连接本机模型代理。')) }, [applyStatus])

  const refreshStorage = useCallback(async () => {
    setStorageMessage('正在读取本机存储概览…')
    try {
      const overview = await loadStorageOverview()
      setStorage(overview)
      setStorageMessage('仅显示文件位置和用途；不会读取或上传聊天正文。')
    } catch (error) {
      setStorage(null)
      setStorageMessage(error instanceof Error ? error.message : '无法读取本机存储概览。')
    }
  }, [])

  useEffect(() => {
    if (!storageOpen) return
    const timer = window.setTimeout(() => { void refreshStorage() }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshStorage, storageOpen])

  const probe = useCallback(async () => {
    if (busy || !urlReady(url) || !key.trim()) return
    setBusy(true); setMessage('正在检测模型列表...')
    try {
      const result = await discoverAiModels({ _type: 'newapi_channel_conn', key, url, apiMode: mode })
      setModels(result.models)
      if (!result.models.includes(model)) setModel(result.models[0] ?? '')
      setMessage(`检测到 ${result.models.length} 个模型。`)
    } catch (error) { setModels([]); setMessage(error instanceof Error ? error.message : '模型列表检测失败。') } finally { setBusy(false) }
  }, [busy, key, mode, model, url])

  const save = useCallback(async (chosenModel = model) => {
    if (busy || !urlReady(url)) return
    setBusy(true); setMessage('正在保存模型通道...')
    try {
      const next = await saveAiProvider({ _type: 'newapi_channel_conn', key: key || undefined, url, model: chosenModel || undefined, apiMode: mode })
      applyStatus(next); setMessage(next.warning || `已保存 ${next.provider} · ${next.model}`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '模型通道保存失败。') } finally { setBusy(false) }
  }, [applyStatus, busy, key, mode, model, url])

  useEffect(() => {
    const signature = `${url}\u0000${key}`
    if (!key.trim() || !urlReady(url) || busy || signature === detected.current) return
    const timer = window.setTimeout(() => { detected.current = signature; void probe() }, 700)
    return () => window.clearTimeout(timer)
  }, [busy, key, probe, url])

  const promptInstructions: AiSettings['promptInstructions'] = { ...defaultPromptInstructions, ...(settings.promptInstructions ?? {}) }
  const updateSettings = (update: Partial<AiSettings>) => onSettingsChange({
    ...settings,
    ...update,
    intervalHours: Math.max(24, Number(update.intervalHours ?? settings.intervalHours)),
    // Older INI files did not have this field. Persisting the merged form makes
    // them self-heal as soon as any setting is changed.
    promptInstructions: { ...promptInstructions, ...(update.promptInstructions ?? {}) },
  })
  const updatePrompt = (key: keyof AiSettings['promptInstructions'], value: string) => updateSettings({ promptInstructions: { ...promptInstructions, [key]: value } })
  const promptLabels: Record<keyof AiSettings['promptInstructions'], string> = { task: '任务提炼', people: '人物证据', peopleMerge: '人物归并', taskGuidance: '任务建议' }
  const promptGuards: Record<keyof AiSettings['promptInstructions'], string> = {
    task: '模型只能根据导出记录提炼“仍需你处理”的事项。发言方向、引用消息、时间锚点与过期判断均以原记录为准，不能由自定义文字改写。',
    people: '每一条事实或偏好都必须给出消息 ID 和对方原话；客户端会核对该原话确实来自该人物的 other 消息。单次表达不得写成稳定习惯、性格或关系结论。',
    peopleMerge: '归并只能保留或去重已有的已核验陈述，不能制造新事实。线索不足时，人物刻画必须说明信息不足，建议为空。',
    taskGuidance: '建议只能使用任务、地点、天气和已核验人物信息。不得虚构消费、路线、场所、关系、同意或个人属性；单次偏好必须建议再次确认。',
  }
  const feedbackReasonLabels: Record<AiSettings['feedback'][number]['reason'], string> = { useful: '有用', expired: '已过期', ownership: '归属错误', completed: '已完成', 'not-actionable': '不构成任务', incorrect: '内容错误', other: '其他' }
  const feedbackEntries = [...(settings.feedback ?? [])].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

  const importConnection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const input = JSON.parse(await file.text()) as AiProviderInput
      if (input._type && input._type !== 'newapi_channel_conn') throw new Error('不支持的连接配置类型')
      touched.current = true
      setUrl(input.url ?? '')
      setKey(input.key ?? '')
      setModel(input.model ?? '')
      setMode(input.apiMode === 'responses' || input.apiMode === 'chat-completions' ? input.apiMode : 'auto')
      const next = await saveAiProvider({ ...input, _type: 'newapi_channel_conn' })
      applyStatus(next)
      setMessage(next.warning || `已导入 ${next.provider} · ${next.model}`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '连接配置无法解析。') }
  }

  const clearPeople = () => {
    if (!personCount) return
    if (window.confirm(`确定彻底删除全部 ${personCount} 张人物卡吗？原始聊天记录不会删除，已删除的人物也不会在下次同步时自动恢复。`)) onClearPeople()
  }

  const clearQuests = () => {
    if (!questCount) return
    if (window.confirm(`确定彻底删除全部 ${questCount} 个任务和长期事件吗？这不会删除原始聊天记录或地点数据。`)) onClearQuests()
  }

  return <div className="options-view page-width">
    <div className="page-intro"><div><span className="section-kicker">OPTIONS · 本机设置</span><h2>选项</h2></div></div>
    <section className="options-section"><div className="options-heading"><div><Palette size={18} /><div><h3>界面外观</h3><p>配色、背景图片、缩放、模糊与显示名称。</p></div></div><button type="button" className="primary-button" onClick={onAppearance}><Palette size={16} />编辑外观</button></div></section>
    <section className="options-section"><div className="options-heading"><div><ServerCog size={18} /><div><h3>模型通道</h3><p>服务地址、明文 API Key 与模型列表保存在本机通用 INI，浏览器与客户端共用。</p></div></div><span className={`ai-status ${status?.configured ? 'is-ready' : ''}`}>{status?.configured ? `${status.provider} · ${status.model}` : '尚未配置'}</span></div>
      <div className="provider-fields"><label><span>服务地址</span><input type="url" value={url} onChange={(event) => { touched.current = true; setUrl(event.target.value); setModels([]); detected.current = '' }} placeholder="https://relay.example.com" /></label><label><span>API Key</span><div className="provider-key-input"><KeyRound size={14} /><input type="text" autoComplete="off" spellCheck={false} value={key} onChange={(event) => { touched.current = true; setKey(event.target.value); setModels([]); detected.current = '' }} /></div></label><label><span>模型 ID</span>{availableModels.length ? <select value={model} onChange={(event) => { setModel(event.target.value); void save(event.target.value) }} disabled={busy}>{availableModels.map((item) => <option value={item} key={item}>{item}</option>)}</select> : <input value={model} onChange={(event) => { touched.current = true; setModel(event.target.value) }} placeholder="填写地址与 Key 后自动获取" />}</label><label><span>接口模式</span><select value={mode} onChange={(event) => { touched.current = true; setMode(event.target.value as AiStatus['apiMode']) }}><option value="auto">自动兼容</option><option value="responses">Responses API</option><option value="chat-completions">Chat Completions</option></select></label></div>
      <div className="provider-actions"><button type="button" className="secondary-button" onClick={() => void probe()} disabled={busy || !url || !key}><RefreshCw size={15} />{busy ? '检测中' : '检测模型'}</button><button type="button" className="primary-button" onClick={() => void save()} disabled={busy || !url}><Save size={15} />保存通道</button><input ref={configInputRef} type="file" accept=".json,application/json" onChange={importConnection} hidden /><button type="button" className="secondary-button" onClick={() => configInputRef.current?.click()} disabled={busy}><FileJson size={15} />导入连接 JSON</button><button type="button" className="icon-button" title="清空模型通道" aria-label="清空模型通道" onClick={() => void resetAiProvider().then((next) => applyStatus(next)).catch(() => setMessage('无法清空模型通道。'))}><RefreshCw size={15} /></button></div>{message && <p className="provider-message" role="status">{message}</p>}
    </section>
    <section className="options-section"><div className="options-heading"><div><SlidersHorizontal size={18} /><div><h3>提炼策略</h3><p>这里决定分析范围、时效和筛选偏好；下面的模型提示词只细化各工作流的表达。两者同时生效，证据、发言方向和时间核验规则优先。</p></div></div></div><div className="ai-controls ai-controls--four"><label><span>分析模式</span><select value={settings.mode} onChange={(event) => updateSettings({ mode: event.target.value as AiSettings['mode'] })}><option value="balanced">明确事项与提醒</option><option value="action">行动优先</option><option value="planning">长期规划</option><option value="review">复盘与整理</option></select></label><label><span>历史事项范围</span><select value={settings.recencyPolicy} onChange={(event) => updateSettings({ recencyPolicy: event.target.value as AiSettings['recencyPolicy'] })}><option value="strict">严格：更快淘汰短时事项</option><option value="balanced">平衡：保留仍有效安排</option><option value="broad">宽泛：更多历史长期事项</option></select></label><label><span>自动更新</span><select value={settings.intervalHours} onChange={(event) => updateSettings({ intervalHours: Number(event.target.value) })}><option value="24">每 24 小时</option><option value="48">每 48 小时</option><option value="72">每 72 小时</option><option value="168">每 7 天</option></select></label><label className="auto-switch"><input type="checkbox" checked={settings.autoEnabled} onChange={(event) => updateSettings({ autoEnabled: event.target.checked })} /><span>自动提炼未分析记录</span></label></div><label className="ai-instructions"><span>任务筛选偏好 <small>自动保存，下一次提炼立即按此要求执行</small></span><textarea value={settings.instructions} onChange={(event) => updateSettings({ instructions: event.target.value })} rows={4} placeholder="例如：优先保留约会、约见、预约、报名、课程、截止和需回复事项；日期不明确时留空。" /></label><div className="feedback-memory"><div><strong>候选磨合记录</strong><span>已保存 {settings.feedback?.length ?? 0} 条保留或忽略反馈；下一次提炼会参考这些偏好。</span></div><div className="feedback-actions"><button type="button" className="secondary-button" onClick={() => setFeedbackOpen(true)} disabled={!settings.feedback?.length}>查看记录</button><button type="button" className="icon-button" title="清空全部磨合记录" aria-label="清空全部磨合记录" onClick={() => updateSettings({ feedback: [] })} disabled={!settings.feedback?.length}><Trash2 size={15} /></button></div></div></section>
    <section className="options-section prompt-editor-section"><div className="options-heading"><div><FilePenLine size={18} /><div><h3>模型提示词</h3><p>任务提炼、人物证据、人物归并和任务建议各有独立提示词。默认文本已回填到旧配置；编辑后会自动保存到 INI 并在下次对应请求生效。</p></div></div></div><div className="prompt-tabs">{(Object.keys(promptLabels) as Array<keyof AiSettings['promptInstructions']>).map((key) => <button type="button" key={key} className={promptKind === key ? 'is-active' : ''} onClick={() => setPromptKind(key)}>{promptLabels[key]}</button>)}</div><label className="ai-instructions prompt-instructions"><span>{promptLabels[promptKind]} 工作要求 <small>这是工作流细化要求，不替代上方筛选策略</small></span><textarea value={promptInstructions[promptKind]} onChange={(event) => updatePrompt(promptKind, event.target.value)} rows={7} /></label><details className="prompt-guard"><summary>固定核验规则（同时发给模型）</summary><p>{promptGuards[promptKind]}</p></details></section>
    <section className={`options-section storage-section ${storageOpen ? 'is-open' : ''}`}><div className="options-heading"><div><HardDrive size={18} /><div><h3>数据与存储</h3><p>{storageOpen ? '所有持久化文件统一位于当前 THEIA 工作目录；这里可确认位置、用途和占用。' : '已折叠；展开后查看本地数据的位置、用途和占用。'}</p></div></div><div className="storage-actions">{storageOpen && <button type="button" className="icon-button" title="刷新存储概览" aria-label="刷新存储概览" onClick={() => void refreshStorage()}><RefreshCw size={15} /></button>}<button type="button" className="icon-button" title={storageOpen ? '折叠数据与存储' : '展开数据与存储'} aria-label={storageOpen ? '折叠数据与存储' : '展开数据与存储'} aria-expanded={storageOpen} onClick={() => setStorageOpen((current) => !current)}>{storageOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button></div></div>{storageOpen && <div className="storage-panel"><p className="storage-message" role="status">{storageMessage}</p>{storage && <><div className="storage-workspace"><span>工作目录</span><code>{storage.workspace}</code></div><div className="storage-list">{storage.entries.map((entry) => <article className={`storage-entry ${entry.exists ? '' : 'is-missing'}`} key={entry.id}><div><strong>{entry.exists ? entry.kind === 'directory' ? '文件夹' : '文件' : '尚未创建'}</strong><code>{entry.path}</code><p>{entry.description}</p></div><span>{entry.exists ? entry.kind === 'directory' ? `${entry.entryCount ?? 0} 项` : formatBytes(entry.sizeBytes) : '未创建'}</span></article>)}</div></>}<div className="bulk-delete-panel"><div><strong>批量清除卡片</strong><p>只删除界面中的人物卡、任务和长期事件；原始聊天、地点和模型通道配置会保留。</p></div><div className="bulk-delete-actions"><button type="button" className="danger-button" onClick={clearPeople} disabled={!personCount}><Trash2 size={15} />删除人物卡 {personCount}</button><button type="button" className="danger-button" onClick={clearQuests} disabled={!questCount}><Trash2 size={15} />删除任务 {questCount}</button></div></div><div className="storage-note">浏览器版还会使用浏览器自身的 localStorage 与 IndexedDB 作为界面缓存；桌面版的 Chromium 缓存归入 <code>.theia-user-data</code>。任务、人物和候选的可同步状态以 <code>.theia-shared-state.json</code> 为准，原始聊天归档以 <code>.theia-shared-intel.json</code> 为准。</div></div>}</section>
    <div className="options-local-note"><CheckCircle2 size={16} />浏览器版与桌面版会经本机代理同步任务、情报和人物；模型请求仍只有在你提炼任务时才会发出。</div>
    {feedbackOpen && <div className="modal-backdrop feedback-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setFeedbackOpen(false)}><section className="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title"><div className="modal-header"><div><span className="section-kicker">CANDIDATE CALIBRATION</span><h2 id="feedback-title">候选磨合记录</h2></div><button type="button" className="icon-button" aria-label="关闭候选磨合记录" onClick={() => setFeedbackOpen(false)}><X size={18} /></button></div><div className="feedback-modal-body">{feedbackEntries.length ? <div className="feedback-list" aria-label="候选磨合记录">{feedbackEntries.map((feedback) => <article className={`feedback-entry feedback-entry--${feedback.decision}`} key={feedback.id}><div><div className="feedback-entry-meta"><strong>{feedback.decision === 'accepted' ? '保留' : '忽略'}</strong><span>{feedbackReasonLabels[feedback.reason]} · {formatFeedbackTime(feedback.createdAt)}</span></div><b>{feedback.title}</b><p>{feedback.description}</p></div><button type="button" className="icon-button" title="删除这条磨合记录" aria-label={`删除磨合记录：${feedback.title}`} onClick={() => updateSettings({ feedback: (settings.feedback ?? []).filter((item) => item.id !== feedback.id) })}><Trash2 size={14} /></button></article>)}</div> : <p className="feedback-empty">没有可显示的磨合记录。</p>}</div></section></div>}
  </div>
}

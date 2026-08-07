import { CheckCircle2, FilePenLine, Palette, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AiProviderPool } from '../components/AiProviderPool'
import { StoragePanel } from '../components/StoragePanel'
import { MapProviderSettings } from '../components/MapProviderSettings'
import { loadStorageOverview, type StorageOverview } from '../lib/storageOverview'
import { defaultPromptInstructions } from '../lib/storage'
import { AI_CONCURRENCY_OPTIONS, normalizeAiConcurrency } from '../lib/aiConcurrency'
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

function formatFeedbackTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function OptionsView({ settings, onSettingsChange, onAppearance, personCount, questCount, onClearPeople, onClearQuests }: OptionsViewProps) {
  const [storage, setStorage] = useState<StorageOverview | null>(null)
  const [storageOpen, setStorageOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [promptKind, setPromptKind] = useState<keyof AiSettings['promptInstructions']>('task')
  const [storageMessage, setStorageMessage] = useState('正在读取本机存储概览…')
  const storageRequestRef = useRef<AbortController | null>(null)
  const refreshStorage = useCallback(async () => {
    storageRequestRef.current?.abort()
    const controller = new AbortController()
    storageRequestRef.current = controller
    setStorageMessage('正在读取本机存储概览…')
    try {
      const overview = await loadStorageOverview(controller.signal)
      if (controller.signal.aborted) return
      setStorage(overview)
      setStorageMessage('仅显示文件位置和用途；不会读取或上传聊天正文。')
    } catch (error) {
      if (controller.signal.aborted) return
      setStorage(null)
      setStorageMessage(error instanceof Error ? error.message : '无法读取本机存储概览。')
    } finally {
      if (storageRequestRef.current === controller) storageRequestRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!storageOpen) {
      storageRequestRef.current?.abort()
      return
    }
    const timer = window.setTimeout(() => { void refreshStorage() }, 0)
    return () => {
      window.clearTimeout(timer)
      storageRequestRef.current?.abort()
    }
  }, [refreshStorage, storageOpen])

  const promptInstructions: AiSettings['promptInstructions'] = { ...defaultPromptInstructions, ...(settings.promptInstructions ?? {}) }
  const automaticTriggerMode = ['time', 'message-count', 'either'].includes(String(settings.autoTriggerMode))
    ? settings.autoTriggerMode
    : 'either'
  const automaticIntervalHours = Math.min(720, Math.max(1, Number(settings.intervalHours) || 24))
  const automaticMessageThreshold = Math.min(10_000, Math.max(1, Math.round(Number(settings.incrementalMessageCount) || 50)))
  const updateSettings = (update: Partial<AiSettings>) => onSettingsChange({
    ...settings,
    ...update,
    intervalHours: Math.min(24 * 30, Math.max(1, Number(update.intervalHours ?? settings.intervalHours))),
    autoTriggerMode: ['time', 'message-count', 'either'].includes(String(update.autoTriggerMode ?? settings.autoTriggerMode))
      ? update.autoTriggerMode ?? settings.autoTriggerMode
      : 'either',
    incrementalMessageCount: Math.min(10_000, Math.max(1, Math.round(Number(update.incrementalMessageCount ?? settings.incrementalMessageCount) || 50))),
    concurrency: normalizeAiConcurrency(update.concurrency ?? settings.concurrency),
    // Older INI files did not have this field. Persisting the merged form makes
    // them self-heal as soon as any setting is changed.
    promptInstructions: { ...promptInstructions, ...(update.promptInstructions ?? {}) },
  })
  const updatePrompt = (key: keyof AiSettings['promptInstructions'], value: string) => updateSettings({ promptInstructions: { ...promptInstructions, [key]: value } })
  const promptLabels: Record<keyof AiSettings['promptInstructions'], string> = { task: '任务提炼', people: '人物证据', peopleMerge: '人物归并', taskGuidance: '任务建议', selfObservation: '自我观察', selfMerge: '自我归并' }
  const promptGuards: Record<keyof AiSettings['promptInstructions'], string> = {
    task: '模型只能根据导出记录提炼“仍需你处理”的事项。发言方向、引用消息、时间锚点与过期判断均以原记录为准，不能由自定义文字改写。',
    people: '每一条事实或偏好都必须给出消息 ID 和对方原话；客户端会核对该原话确实来自该人物的 other 消息。单次表达不得写成稳定习惯、性格或关系结论。',
    peopleMerge: '事实、偏好和关键互动事件只能保留已有引文；人物志可以把多条已核验陈述按时间线组织成连贯文字，并区分变化与延续，但不得引入新事实。人物底稿与日期明确的时间线注记是独立的用户确认来源，不能伪装成聊天结论。线索不足时必须说明边界。',
    taskGuidance: '建议只能使用任务、地点、天气和已核验人物信息。不得虚构消费、路线、场所、关系、同意或个人属性；单次偏好必须建议再次确认。',
    selfObservation: '每条自我观察都必须引用本人发言或日记的精确原文与消息 ID；本地会核验引文与时间。不得将一次表达扩展为稳定人格、诊断、动机或未记录事件。',
    selfMerge: '阶段叙事只能引用已核验观察。时期起止、来源消息和专业概念的证据关系均由本地重建；专业概念仅作非诊断性的解释，不能输出疾病、人格或治疗结论。',
  }
  const feedbackReasonLabels: Record<AiSettings['feedback'][number]['reason'], string> = { useful: '有用', expired: '已过期', ownership: '归属错误', completed: '已完成', 'not-actionable': '不构成任务', incorrect: '内容错误', other: '其他' }
  const feedbackEntries = [...(settings.feedback ?? [])].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

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
    <AiProviderPool globalConcurrency={normalizeAiConcurrency(settings.concurrency)} onGlobalConcurrencyChange={(concurrency) => updateSettings({ concurrency })} />
    <MapProviderSettings />
    <section className="options-section"><div className="options-heading"><div><SlidersHorizontal size={18} /><div><h3>提炼策略</h3><p>这里决定分析范围、时效和筛选偏好；下面的模型提示词只细化各工作流的表达。并发只作用于不同会话，同一会话始终按时间顺序处理。</p></div></div></div><div className="ai-controls"><label><span>分析模式</span><select value={settings.mode} onChange={(event) => updateSettings({ mode: event.target.value as AiSettings['mode'] })}><option value="balanced">明确事项与提醒</option><option value="action">行动优先</option><option value="planning">长期规划</option><option value="review">复盘与整理</option></select></label><label><span>历史事项范围</span><select value={settings.recencyPolicy} onChange={(event) => updateSettings({ recencyPolicy: event.target.value as AiSettings['recencyPolicy'] })}><option value="strict">严格：更快淘汰短时事项</option><option value="balanced">平衡：保留仍有效安排</option><option value="broad">宽泛：更多历史长期事项</option></select></label><label><span>并发会话</span><select value={normalizeAiConcurrency(settings.concurrency)} onChange={(event) => updateSettings({ concurrency: Number(event.target.value) })}>{AI_CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value} 个会话</option>)}</select></label></div><label className="ai-instructions"><span>任务筛选偏好 <small>自动保存，下一次提炼立即按此要求执行</small></span><textarea value={settings.instructions} onChange={(event) => updateSettings({ instructions: event.target.value })} rows={4} placeholder="例如：优先保留约会、约见、预约、报名、课程、截止和需回复事项；日期不明确时留空。" /></label><div className="feedback-memory"><div><strong>候选磨合记录</strong><span>已保存 {settings.feedback?.length ?? 0} 条保留或忽略反馈；下一次提炼会参考最近的偏好。</span></div><div className="feedback-actions"><button type="button" className="secondary-button" onClick={() => setFeedbackOpen(true)} disabled={!settings.feedback?.length}>查看记录</button><button type="button" className="icon-button" title="清空全部磨合记录" aria-label="清空全部磨合记录" onClick={() => updateSettings({ feedback: [] })} disabled={!settings.feedback?.length}><Trash2 size={15} /></button></div></div></section>
    <section className="options-section"><div className="options-heading"><div><SlidersHorizontal size={18} /><div><h3>增量自动提炼</h3><p>只处理发生变化的会话；首次全库提炼后，后续请求只包含新增消息和必要上下文。</p></div></div></div><div className="ai-controls"><label className="auto-switch"><input type="checkbox" checked={settings.autoEnabled} onChange={(event) => updateSettings({ autoEnabled: event.target.checked })} /><span>自动提炼增量记录</span></label><label><span>触发条件</span><select value={automaticTriggerMode} onChange={(event) => updateSettings({ autoTriggerMode: event.target.value as AiSettings['autoTriggerMode'] })} disabled={!settings.autoEnabled}><option value="either">时间或数量满足其一</option><option value="time">仅按时间</option><option value="message-count">仅按新增消息数</option></select></label><label><span>时间间隔（小时）</span><input type="number" min="1" max="720" value={automaticIntervalHours} onChange={(event) => updateSettings({ intervalHours: Number(event.target.value) })} disabled={!settings.autoEnabled || automaticTriggerMode === 'message-count'} /></label><label><span>新增消息阈值</span><input type="number" min="1" max="10000" value={automaticMessageThreshold} onChange={(event) => updateSettings({ incrementalMessageCount: Number(event.target.value) })} disabled={!settings.autoEnabled || automaticTriggerMode === 'time'} /></label></div></section>
    <section className="options-section prompt-editor-section"><div className="options-heading"><div><FilePenLine size={18} /><div><h3>模型提示词</h3><p>任务提炼、人物证据、人物归并和任务建议各有独立提示词。默认文本已回填到旧配置；编辑后会自动保存到 INI 并在下次对应请求生效。</p></div></div></div><div className="prompt-tabs">{(Object.keys(promptLabels) as Array<keyof AiSettings['promptInstructions']>).map((key) => <button type="button" key={key} className={promptKind === key ? 'is-active' : ''} onClick={() => setPromptKind(key)}>{promptLabels[key]}</button>)}</div><label className="ai-instructions prompt-instructions"><span>{promptLabels[promptKind]} 工作要求 <small>这是工作流细化要求，不替代上方筛选策略</small></span><textarea value={promptInstructions[promptKind]} onChange={(event) => updatePrompt(promptKind, event.target.value)} rows={7} /></label><details className="prompt-guard"><summary>固定核验规则（同时发给模型）</summary><p>{promptGuards[promptKind]}</p></details></section>
    <StoragePanel
      open={storageOpen}
      storage={storage}
      message={storageMessage}
      personCount={personCount}
      questCount={questCount}
      onToggle={() => setStorageOpen((current) => !current)}
      onRefresh={() => void refreshStorage()}
      onClearPeople={clearPeople}
      onClearQuests={clearQuests}
    />
    <div className="options-local-note"><CheckCircle2 size={16} />浏览器版与桌面版会经本机代理同步任务、情报和人物；模型请求仍只有在你提炼任务时才会发出。</div>
    {feedbackOpen && <div className="modal-backdrop feedback-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setFeedbackOpen(false)}><section className="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title"><div className="modal-header"><div><span className="section-kicker">CANDIDATE CALIBRATION</span><h2 id="feedback-title">候选磨合记录</h2></div><button type="button" className="icon-button" aria-label="关闭候选磨合记录" onClick={() => setFeedbackOpen(false)}><X size={18} /></button></div><div className="feedback-modal-body">{feedbackEntries.length ? <div className="feedback-list" aria-label="候选磨合记录">{feedbackEntries.map((feedback) => <article className={`feedback-entry feedback-entry--${feedback.decision}`} key={feedback.id}><div><div className="feedback-entry-meta"><strong>{feedback.decision === 'accepted' ? '保留' : '忽略'}</strong><span>{feedbackReasonLabels[feedback.reason]} · {formatFeedbackTime(feedback.createdAt)}</span></div><b>{feedback.title}</b><p>{feedback.description}</p></div><button type="button" className="icon-button" title="删除这条磨合记录" aria-label={`删除磨合记录：${feedback.title}`} onClick={() => updateSettings({ feedback: (settings.feedback ?? []).filter((item) => item.id !== feedback.id) })}><Trash2 size={14} /></button></article>)}</div> : <p className="feedback-empty">没有可显示的磨合记录。</p>}</div></section></div>}
  </div>
}

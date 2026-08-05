import type { ChangeEventHandler, RefObject } from 'react'
import { ChevronDown, ImagePlus, Pause, RefreshCw, Sparkles, X } from 'lucide-react'

import type { AiSettings, ArchiveSummary } from '../../types'
import type { AiProgress, AiStatus } from '../../lib/aiClient'
import type { ConversationTimeline } from '../../lib/intelConversationView'
import type { AnalysisScope, AnalysisTargets, TimelineFilterMode } from '../../hooks/useIntelAnalysisSelection'
import { estimateAttachmentQueue } from '../../lib/attachmentQueue'

interface AnalysisPanelProps {
  open: boolean
  aiStatus: AiStatus | null
  scope: AnalysisScope
  analysisTargets: AnalysisTargets
  analysisConversationId: string
  analysisConversation?: ConversationTimeline
  conversations: ConversationTimeline[]
  filteredConversationCount: number
  timelineMode: TimelineFilterMode
  timelineStart: string
  timelineEnd: string
  analysisMessageCount: number
  analysisConversationCount: number
  archive: ArchiveSummary
  attachmentRef: RefObject<HTMLInputElement | null>
  attachmentFiles: File[]
  aiBusy: boolean
  retryConversationIds: string[]
  aiSettings: AiSettings
  effectiveConcurrency: number
  aiProgress: AiProgress | null
  aiMessage: string
  onToggleOpen: () => void
  onScopeChange: (scope: AnalysisScope) => void
  onTargetsChange: (targets: AnalysisTargets) => void
  onConversationChange: (id: string) => void
  onTimelineModeChange: (mode: TimelineFilterMode) => void
  onTimelineStartChange: (value: string) => void
  onTimelineEndChange: (value: string) => void
  onClearTimeline: () => void
  onAddAttachments: ChangeEventHandler<HTMLInputElement>
  onRemoveAttachment: (index: number) => void
  onRun: () => void
  onStop: () => void
  onRetry: () => void
}

function formatLastRun(value?: string) {
  if (!value) return '尚未运行模型分析'
  return `上次模型分析：${new Date(value).toLocaleString('zh-CN')}`
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function AnalysisPanel({
  open,
  aiStatus,
  scope,
  analysisTargets,
  analysisConversationId,
  analysisConversation,
  conversations,
  filteredConversationCount,
  timelineMode,
  timelineStart,
  timelineEnd,
  analysisMessageCount,
  analysisConversationCount,
  archive,
  attachmentRef,
  attachmentFiles,
  aiBusy,
  retryConversationIds,
  aiSettings,
  effectiveConcurrency,
  aiProgress,
  aiMessage,
  onToggleOpen,
  onScopeChange,
  onTargetsChange,
  onConversationChange,
  onTimelineModeChange,
  onTimelineStartChange,
  onTimelineEndChange,
  onClearTimeline,
  onAddAttachments,
  onRemoveAttachment,
  onRun,
  onStop,
  onRetry,
}: AnalysisPanelProps) {
  const attachmentEstimate = estimateAttachmentQueue(attachmentFiles)
  const attachmentSize = attachmentEstimate.totalBytes < 1024 * 1024
    ? `${(attachmentEstimate.totalBytes / 1024).toFixed(1)} KB`
    : `${(attachmentEstimate.totalBytes / (1024 * 1024)).toFixed(1)} MB`
  return (
    <section className={`ai-console intel-list-section intel-collapsible-section ${open ? 'is-open' : 'is-collapsed'}`}>
      <div className="list-heading"><div><span className="section-kicker">MODEL WORKBENCH · 批量分析</span><h2><button type="button" className="intel-section-toggle" aria-expanded={open} onClick={onToggleOpen}>模型任务提炼<ChevronDown size={17} /></button></h2></div><span className={`ai-status ${aiStatus?.configured ? 'is-ready' : ''}`}>{aiStatus ? (aiStatus.configured ? `${aiStatus.provider} · ${aiStatus.model}` : '尚未配置通道') : '检查连接中…'}</span></div>
      {open && <>
        <div className="intel-analysis-brief">
          <label><span>提炼范围</span><select value={scope} onChange={(event) => onScopeChange(event.target.value as AnalysisScope)}><option value="unprocessed">未分析的新记录</option><option value="new">全部新记录</option><option value="all">全部记录</option></select></label>
          <div className="intel-workflow-picker" role="group" aria-label="提炼内容">
            <span>提炼内容</span>
            <label className="auto-switch"><input type="checkbox" checked={analysisTargets.tasks} onChange={(event) => onTargetsChange({ ...analysisTargets, tasks: event.target.checked })} disabled={aiBusy} /><span>任务</span></label>
            <label className="auto-switch"><input type="checkbox" checked={analysisTargets.people} onChange={(event) => onTargetsChange({ ...analysisTargets, people: event.target.checked })} disabled={aiBusy} /><span>人物</span></label>
            <label className="auto-switch"><input type="checkbox" checked={analysisTargets.self} onChange={(event) => onTargetsChange({ ...analysisTargets, self: event.target.checked })} disabled={aiBusy} /><span>自我</span></label>
            <button type="button" className="text-button" onClick={() => onTargetsChange({ tasks: true, people: true, self: true })} disabled={aiBusy || (analysisTargets.tasks && analysisTargets.people && analysisTargets.self)}>全选</button>
          </div>
          <label className="intel-conversation-picker"><span>指定对话</span><select value={analysisConversationId} onChange={(event) => onConversationChange(event.target.value)}><option value="">全部符合范围的对话</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.name} · {formatCount(conversation.records.length)} 条</option>)}</select></label>
          <label><span>时间模式</span><select value={timelineMode} onChange={(event) => onTimelineModeChange(event.target.value as TimelineFilterMode)}><option value="last-chat">按最后聊天时间</option><option value="strict-window">严格时间窗口</option></select></label>
          <div className="intel-time-filter">
            <label><span>{timelineMode === 'last-chat' ? '最后聊天时间从' : '消息时间从'}</span><input type="date" value={timelineStart} onChange={(event) => onTimelineStartChange(event.target.value)} max={timelineEnd || undefined} /></label>
            <label><span>至</span><input type="date" value={timelineEnd} onChange={(event) => onTimelineEndChange(event.target.value)} min={timelineStart || undefined} /></label>
            {(timelineStart || timelineEnd) && <button type="button" className="icon-button" title="清除时间筛选" aria-label="清除时间筛选" onClick={onClearTimeline}><X size={15} /></button>}
          </div>
          <span>{analysisConversationId
            ? `已指定“${analysisConversation?.name ?? '已移除的对话'}”；${timelineMode === 'strict-window' ? `严格窗口内上传 ${formatCount(analysisMessageCount)} 条消息。` : `将上传该对话完整历史，共 ${formatCount(analysisMessageCount)} 条消息。`}`
            : timelineMode === 'last-chat'
              ? `当前选中 ${filteredConversationCount}/${conversations.length} 个会话；会将其完整历史按分段覆盖上传。`
              : `严格窗口内有 ${formatCount(analysisMessageCount)} 条消息，来自 ${analysisConversationCount} 个会话；窗口外消息不会发送。`}{analysisTargets.self && ' 自我分析只读取本地已确认的本人发言、手动日记、每日状态和 AI 对话导入；默认跨会话按完整时间线归并。'}</span>
        </div>
        <div className="archive-structure" aria-label="档案与模型分析结构">
          <div className="archive-stage"><span>当前导出文件</span><strong>{archive.fileCount === undefined ? '未记录' : formatCount(archive.fileCount)}</strong><small>连接目录中的 JSON、CSV、TXT 文件数；不等于消息数。</small></div>
          <div className="archive-stage"><span>原始消息档案</span><strong>{formatCount(archive.messageCount)}</strong><small>当前目录快照去重后留存的消息总数；不是文件数，也不是模型上下文。</small></div>
          <div className="archive-stage"><span>已归档对话</span><strong>{formatCount(archive.conversationCount)}</strong><small>{archive.directConversationCount !== undefined || archive.groupConversationCount !== undefined ? `私聊 ${formatCount(archive.directConversationCount ?? 0)} 个 · 群聊 ${formatCount(archive.groupConversationCount ?? 0)} 个。` : archive.identifiedConversationCount ? `${formatCount(archive.identifiedConversationCount)} 个由导出目录确认。` : '旧记录尚未带目录身份。'}{archive.messagesWithoutConversation ? ` ${formatCount(archive.messagesWithoutConversation)} 条旧记录按来源月份临时归档。` : ''}</small></div>
          <div className="archive-stage"><span>本轮选择</span><strong>{formatCount(analysisConversationCount)} 个对话</strong><small>{analysisConversationId ? `已指定“${analysisConversation?.name ?? '对话'}”，范围内有 ${formatCount(analysisMessageCount)} 条消息。` : `范围内有 ${formatCount(analysisMessageCount)} 条消息，按${timelineMode === 'last-chat' ? '最后聊天时间' : '严格时间窗口'}筛选。`}</small></div>
          <div className="archive-stage"><span>模型输入方式</span><strong>完整覆盖分段</strong><small>超长会话按时间连续分段，每段保留少量前序上下文；全部消息都会上传，不做抽样或固定条数截断。</small></div>
        </div>
        <div className="attachment-queue"><div className="attachment-row"><input ref={attachmentRef} type="file" accept="image/*,.pdf,.json,.csv,.txt" multiple onChange={onAddAttachments} hidden /><button type="button" className="secondary-button" onClick={() => attachmentRef.current?.click()} disabled={aiBusy}><ImagePlus size={16} />添加图片或文件</button>{attachmentFiles.map((file, index) => <span className="attachment-chip" key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => onRemoveAttachment(index)}><X size={13} /></button></span>)}</div>{attachmentEstimate.fileCount > 0 && <p className="attachment-cost" role="status">待识别 {attachmentEstimate.fileCount} 个附件 · {attachmentSize}{attachmentEstimate.estimatedTextTokens ? ` · 文本约 ${attachmentEstimate.estimatedTextTokens.toLocaleString('zh-CN')} tokens` : ''}{attachmentEstimate.imageCount ? ` · ${attachmentEstimate.imageCount} 张图片按所选模型计费` : ''}{attachmentEstimate.binaryDocumentCount ? ` · ${attachmentEstimate.binaryDocumentCount} 个文档的识别成本由模型决定` : ''}。开始提炼后才会上传。</p>}</div>
        <div className="ai-actions"><button type="button" className="primary-button" onClick={onRun} disabled={aiBusy || !aiStatus?.configured || (!analysisTargets.tasks && !analysisTargets.people && !analysisTargets.self)}><Sparkles size={16} />{aiBusy ? '按时间线提炼中' : analysisConversationId ? '提炼指定对话' : scope === 'all' ? '提炼全部对话' : '提炼当前范围'}</button>{aiBusy && <button type="button" className="secondary-button ai-stop-button" onClick={onStop}><Pause size={15} />暂停并保存进度</button>}{retryConversationIds.length > 0 && <button type="button" className="secondary-button" onClick={onRetry} disabled={aiBusy || !aiStatus?.configured}><RefreshCw size={15} />重试失败会话 {retryConversationIds.length}</button>}<span>{formatLastRun(aiSettings.lastRunAt)} · {effectiveConcurrency} 个会话并行{aiProgress && aiBusy ? ` · 总进度 ${aiProgress.completedConversations ?? 0}/${aiProgress.totalConversations ?? analysisConversationCount} 个对话${aiProgress.total ? ` · ${aiProgress.completed}/${aiProgress.total} 个片段` : ''}` : ''}</span></div>
        {aiMessage && <p className="ai-message" role="status">{aiMessage}</p>}
      </>}
    </section>
  )
}

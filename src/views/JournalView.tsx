import { BookOpenText, CalendarDays, FileSearch, Send, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { isSelfJournalRecord } from '../lib/selfJournal'
import type { IntelItem, SelfAnalysis } from '../types'

interface JournalViewProps {
  items: IntelItem[]
  selfAnalysis?: SelfAnalysis
  sourceCounts: { selfMessageCount: number; journalEntryCount: number; contextEventCount: number }
  onAddEntry: (content: string) => void
  onDeleteEntry: (id: string) => void
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '未记录时间'
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function analysisDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '未记录时间'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

function analysisRange(startAt: string, endAt: string) {
  const start = analysisDate(startAt)
  const end = analysisDate(endAt)
  return start === end ? start : `${start} 至 ${end}`
}

/** The low-friction journal is the sole user-authored self-recording surface. */
export function JournalView({ items, selfAnalysis, sourceCounts, onAddEntry, onDeleteEntry }: JournalViewProps) {
  const [entry, setEntry] = useState('')
  const journals = useMemo(() => items
    .filter((item) => isSelfJournalRecord(item) && item.messageType !== 'daily-checkin')
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id))
    .slice(0, 80), [items])

  const sendEntry = () => {
    if (!entry.trim()) return
    onAddEntry(entry)
    setEntry('')
  }

  return <div className="journal-view page-width">
    <div className="page-intro journal-intro">
      <div><span className="section-kicker">SELF ARCHIVE</span><h2>记录</h2></div>
      <div className="journal-foundation" title="日记与已确认的本人发言是自我分析的证据。SELENE 时间线仅用于保持时间线完整，默认不含精确位置。">
        <span>本人发言 {sourceCounts.selfMessageCount.toLocaleString()}</span>
        <span>日记 {sourceCounts.journalEntryCount.toLocaleString()}</span>
        <span>SELENE 时间线 {sourceCounts.contextEventCount.toLocaleString()}</span>
      </div>
    </div>

    <section className="self-analysis-panel" aria-label="自我分析">
      <div className="journal-panel-heading self-analysis-heading">
        <div><Sparkles size={17} /><h3>自我分析</h3></div>
        {selfAnalysis && <small>更新于 {formatTime(selfAnalysis.generatedAt)}</small>}
      </div>
      {selfAnalysis ? <>
        <div className="self-analysis-metrics">
          <span><strong>{selfAnalysis.sourceRecordCount.toLocaleString()}</strong> 本人来源</span>
          <span><strong>{(selfAnalysis.sourceContextEventCount ?? 0).toLocaleString()}</strong> 时间线背景</span>
          <span><strong>{selfAnalysis.observationCount.toLocaleString()}</strong> 核验观察</span>
          <span><strong>{selfAnalysis.periods.length.toLocaleString()}</strong> 时间阶段</span>
        </div>
        <div className="self-analysis-periods">
          {selfAnalysis.periods.map((period) => <article className="self-analysis-period" key={period.id}>
            <header>
              <div><time>{analysisRange(period.startAt, period.endAt)}</time><h4>{period.title}</h4></div>
              <span title="每个阶段都保留可回到本地归档核验的来源消息 ID"><FileSearch size={14} /> {period.sourceIds.length} 条来源</span>
            </header>
            <p>{period.narrative}</p>
            {period.themes.length > 0 && <div className="self-analysis-themes" aria-label="主题">{period.themes.map((theme) => <span key={theme}>{theme}</span>)}</div>}
            {period.professionalContexts.length > 0 && <div className="self-analysis-contexts">
              <div><BookOpenText size={14} /><span>解释性参考，非诊断</span></div>
              {period.professionalContexts.map((context) => <section key={`${context.term}-${context.observationIds.join('-')}`}><strong>{context.term}</strong><p>{context.explanation}</p></section>)}
            </div>}
          </article>)}
        </div>
        {selfAnalysis.limitations?.length ? <div className="self-analysis-limitations"><strong>分析边界</strong>{selfAnalysis.limitations.map((note) => <span key={note}>{note}</span>)}</div> : null}
      </> : <div className="self-analysis-empty"><Sparkles size={18} /><p>还没有自我分析。前往“情报库”，在模型任务提炼中勾选“自我”后开始；分析只会读取本地确认的本人发言、日记、导入的 AI 对话和受权导入的时间线上下文。</p></div>}
    </section>

    <section className="journal-composer" aria-label="写一条日记">
      <textarea value={entry} onChange={(event) => setEntry(event.target.value)} placeholder="写下此刻发生的事、正在想什么，或任何想留给未来自己的话。" rows={4} maxLength={8000} />
      <div className="journal-composer-actions"><small>{entry.length.toLocaleString()} / 8,000</small><button type="button" className="primary-button" onClick={sendEntry} disabled={!entry.trim()}><Send size={16} /><span>发送</span></button></div>
    </section>

    <section className="journal-history" aria-label="最近日记">
      <div className="journal-panel-heading"><div><CalendarDays size={17} /><h3>最近记录</h3></div><small>{sourceCounts.journalEntryCount.toLocaleString()} 条</small></div>
      <div className="journal-history-list">{journals.map((item) => <article key={item.id}><time>{formatTime(item.capturedAt)}</time><p>{item.content || item.summary}</p><button type="button" className="icon-button danger-button" title="删除这条记录" aria-label="删除这条记录" onClick={() => { if (window.confirm('删除这条记录？此操作不可撤销。')) onDeleteEntry(item.id) }}><Trash2 size={16} /></button></article>)}{!journals.length && <p className="empty-note">还没有日记记录。</p>}</div>
    </section>
  </div>
}

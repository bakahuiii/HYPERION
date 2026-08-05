import { BookOpenText, CalendarDays, ClipboardCheck, FileSearch, Moon, Pill, Save, Send, Sparkles, Trash2, Wine } from 'lucide-react'
import { useMemo, useState } from 'react'
import { isSelfJournalRecord } from '../lib/selfJournal'
import type { DailyAlcoholLevel, DailyCheckIn, DailyMedicationStatus, IntelItem, SelfAnalysis } from '../types'

interface CheckInDraft {
  date: string
  mood?: DailyCheckIn['mood']
  sleepHours: string
  medication: DailyMedicationStatus
  alcohol: DailyAlcoholLevel
  mainFocus: string
  note: string
}

interface JournalViewProps {
  items: IntelItem[]
  checkIns: DailyCheckIn[]
  selfAnalysis?: SelfAnalysis
  sourceCounts: { selfMessageCount: number; journalEntryCount: number; checkInCount: number }
  onAddEntry: (content: string) => void
  onDeleteEntry: (id: string) => void
  onSaveCheckIn: (draft: Partial<DailyCheckIn>) => void
  onDeleteCheckIn: (date: string) => void
}

function localDay(now = new Date()) {
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function blankDraft(date: string): CheckInDraft {
  return { date, sleepHours: '', medication: 'unknown', alcohol: 'unknown', mainFocus: '', note: '' }
}

function draftFromCheckIn(checkIn: DailyCheckIn | undefined, date: string): CheckInDraft {
  if (!checkIn) return blankDraft(date)
  return {
    date,
    mood: checkIn.mood,
    sleepHours: checkIn.sleepHours === undefined ? '' : String(checkIn.sleepHours),
    medication: checkIn.medication,
    alcohol: checkIn.alcohol,
    mainFocus: checkIn.mainFocus ?? '',
    note: checkIn.note ?? '',
  }
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '未记录时间'
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function dateLabel(value: string) {
  const [year, month, day] = value.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
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

export function JournalView({ items, checkIns, selfAnalysis, sourceCounts, onAddEntry, onDeleteEntry, onSaveCheckIn, onDeleteCheckIn }: JournalViewProps) {
  const [entry, setEntry] = useState('')
  const [selectedDate, setSelectedDate] = useState(() => localDay())
  const [draft, setDraft] = useState<CheckInDraft>(() => blankDraft(localDay()))
  const selectedCheckIn = checkIns.find((item) => item.date === selectedDate)
  const journals = useMemo(() => items
    .filter((item) => isSelfJournalRecord(item) && item.messageType !== 'daily-checkin')
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id))
    .slice(0, 80), [items])

  const selectDate = (date: string) => {
    const nextDate = date || localDay()
    setSelectedDate(nextDate)
    setDraft(draftFromCheckIn(checkIns.find((item) => item.date === nextDate), nextDate))
  }

  const hasCheckInContent = Boolean(
    draft.mood
    || draft.sleepHours.trim()
    || draft.medication !== 'unknown'
    || draft.alcohol !== 'unknown'
    || draft.mainFocus.trim()
    || draft.note.trim(),
  )

  const sendEntry = () => {
    if (!entry.trim()) return
    onAddEntry(entry)
    setEntry('')
  }

  const saveCheckIn = () => {
    const sleepHours = draft.sleepHours.trim() === '' ? undefined : Number(draft.sleepHours)
    onSaveCheckIn({
      date: selectedDate,
      mood: draft.mood,
      ...(Number.isFinite(sleepHours) ? { sleepHours } : {}),
      medication: draft.medication,
      alcohol: draft.alcohol,
      mainFocus: draft.mainFocus,
      note: draft.note,
    })
  }

  return <div className="journal-view page-width">
    <div className="page-intro journal-intro">
      <div><span className="section-kicker">SELF ARCHIVE</span><h2>记录</h2></div>
      <div className="journal-foundation" title="这些数据将作为未来自我分析的可追溯基础，当前不会自动提交给模型。">
        <span>自我发言 {sourceCounts.selfMessageCount.toLocaleString()}</span>
        <span>日记 {sourceCounts.journalEntryCount.toLocaleString()}</span>
        <span>快照 {sourceCounts.checkInCount.toLocaleString()}</span>
      </div>
    </div>

    <section className="self-analysis-panel" aria-label="自我分析">
      <div className="journal-panel-heading self-analysis-heading">
        <div><Sparkles size={17} /><h3>自我分析</h3></div>
        {selfAnalysis && <small>更新于 {formatTime(selfAnalysis.generatedAt)}</small>}
      </div>
      {selfAnalysis ? <>
        <div className="self-analysis-metrics">
          <span><strong>{selfAnalysis.sourceRecordCount.toLocaleString()}</strong>本人来源</span>
          <span><strong>{selfAnalysis.sourceCheckInCount.toLocaleString()}</strong>状态快照</span>
          <span><strong>{selfAnalysis.observationCount.toLocaleString()}</strong>核验观察</span>
          <span><strong>{selfAnalysis.periods.length.toLocaleString()}</strong>时间阶段</span>
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
      </> : <div className="self-analysis-empty"><Sparkles size={18} /><p>还没有自我分析。前往“情报库”，在模型任务提炼中勾选“自我”后开始；分析会读取本地确认的本人发言、日记、每日状态与 AI 对话导入，并按时间线生成可追溯阶段。</p></div>}
    </section>

    <section className="journal-composer" aria-label="写一条日记">
      <textarea value={entry} onChange={(event) => setEntry(event.target.value)} placeholder="写下此刻发生的事、正在想什么，或任何想留给未来自己的话。" rows={4} maxLength={8000} />
      <div className="journal-composer-actions"><small>{entry.length.toLocaleString()} / 8,000</small><button type="button" className="primary-button" onClick={sendEntry} disabled={!entry.trim()}><Send size={16} /><span>发送</span></button></div>
    </section>

    <div className="journal-grid">
      <section className="checkin-panel" aria-label="每日状态快照">
        <div className="journal-panel-heading"><div><ClipboardCheck size={17} /><h3>每日状态</h3></div><label className="checkin-date"><CalendarDays size={14} /><input type="date" value={selectedDate} onChange={(event) => selectDate(event.target.value)} /></label></div>
        <div className="checkin-fields">
          <fieldset className="mood-picker"><legend>今天状态</legend><div>{([1, 2, 3, 4, 5] as const).map((mood) => <button key={mood} type="button" className={draft.mood === mood ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, mood: current.mood === mood ? undefined : mood }))}>{mood}</button>)}</div></fieldset>
          <label className="checkin-field"><span><Moon size={14} />睡眠</span><div className="unit-input"><input type="number" min="0" max="24" step="0.5" inputMode="decimal" value={draft.sleepHours} onChange={(event) => setDraft((current) => ({ ...current, sleepHours: event.target.value }))} placeholder="-" /><em>小时</em></div></label>
          <label className="checkin-field"><span><Pill size={14} />药物</span><select value={draft.medication} onChange={(event) => setDraft((current) => ({ ...current, medication: event.target.value as DailyMedicationStatus }))}><option value="unknown">未记录</option><option value="yes">服用</option><option value="reduced">减量</option><option value="no">未服用</option></select></label>
          <label className="checkin-field"><span><Wine size={14} />酒精</span><select value={draft.alcohol} onChange={(event) => setDraft((current) => ({ ...current, alcohol: event.target.value as DailyAlcoholLevel }))}><option value="unknown">未记录</option><option value="none">无</option><option value="low">少</option><option value="high">多</option></select></label>
          <label className="checkin-field checkin-field--wide"><span>主要在做什么</span><input value={draft.mainFocus} onChange={(event) => setDraft((current) => ({ ...current, mainFocus: event.target.value }))} maxLength={360} placeholder="学习、见面、休息、处理一件事……" /></label>
          <label className="checkin-field checkin-field--wide"><span>一句话描述今天</span><textarea value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} maxLength={1200} rows={3} placeholder="不需要写得完整。" /></label>
        </div>
        <div className="checkin-actions"><span>{selectedCheckIn ? `上次更新：${formatTime(selectedCheckIn.updatedAt)}` : dateLabel(selectedDate)}</span><div>{selectedCheckIn && <button type="button" className="icon-button danger-button" title="删除这一天的状态快照" aria-label="删除这一天的状态快照" onClick={() => { if (window.confirm(`删除 ${dateLabel(selectedDate)} 的状态快照？`)) { onDeleteCheckIn(selectedDate); setDraft(blankDraft(selectedDate)) } }}><Trash2 size={16} /></button>}<button type="button" className="primary-button" disabled={!hasCheckInContent} onClick={saveCheckIn}><Save size={16} /><span>{selectedCheckIn ? '更新快照' : '保存快照'}</span></button></div></div>
      </section>

      <section className="checkin-history" aria-label="近期每日状态">
        <div className="journal-panel-heading"><div><CalendarDays size={17} /><h3>近期快照</h3></div><small>{checkIns.length} 条</small></div>
        <div className="checkin-history-list">{checkIns.slice(0, 14).map((checkIn) => <button type="button" key={checkIn.id} className={checkIn.date === selectedDate ? 'is-active' : ''} onClick={() => selectDate(checkIn.date)}><strong>{dateLabel(checkIn.date)}</strong><span>{checkIn.mood ? `状态 ${checkIn.mood}/5` : '未记录状态'}{checkIn.sleepHours !== undefined ? ` · 睡眠 ${checkIn.sleepHours}h` : ''}</span><small>{checkIn.note || checkIn.mainFocus || '打开查看详情'}</small></button>)}{!checkIns.length && <p className="empty-note">还没有状态快照。</p>}</div>
      </section>
    </div>

    <section className="journal-history" aria-label="最近日记">
      <div className="journal-panel-heading"><div><CalendarDays size={17} /><h3>最近记录</h3></div><small>{sourceCounts.journalEntryCount.toLocaleString()} 条</small></div>
      <div className="journal-history-list">{journals.map((item) => <article key={item.id}><time>{formatTime(item.capturedAt)}</time><p>{item.content || item.summary}</p><button type="button" className="icon-button danger-button" title="删除这条记录" aria-label="删除这条记录" onClick={() => { if (window.confirm('删除这条记录？此操作不可撤销。')) onDeleteEntry(item.id) }}><Trash2 size={16} /></button></article>)}{!journals.length && <p className="empty-note">还没有日记记录。</p>}</div>
    </section>
  </div>
}

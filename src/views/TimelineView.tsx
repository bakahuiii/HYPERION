import { CalendarRange, CheckCircle2, Circle, FileText, MapPin, Pencil, Trash2 } from 'lucide-react'
import { formatQuestSourceTime, formatQuestTargetTime, formatTimelineClock, parseQuestTime, questTimelineAt, timelineDayKey, timelineSortValue } from '../lib/questTime'
import type { IntelItem, Place, Quest } from '../types'

interface TimelineViewProps {
  quests: Quest[]
  places: Place[]
  intel: IntelItem[]
  onToggle: (id: string) => void
  onEdit: (quest: Quest) => void
  onViewSource: (quest: Quest) => void
  onDelete: (id: string) => void
}

function dayLabel(value: string) {
  if (value === '未记录信息源时间') return value
  const date = parseQuestTime(value)
  if (!date) return '未记录信息源时间'
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

function TimeBadges({ quest, intel }: { quest: Quest; intel: IntelItem[] }) {
  return <div className="timeline-time-badges">
    <span className="timeline-time-badge timeline-time-badge--target"><CalendarRange size={13} /><i>目标时间</i><strong>{formatQuestTargetTime(quest)}</strong></span>
    <span className="timeline-time-badge timeline-time-badge--source"><FileText size={13} /><i>信息源时间</i><strong>{formatQuestSourceTime(quest, intel)}</strong></span>
  </div>
}

function DeleteButton({ quest, onDelete }: { quest: Quest; onDelete: (id: string) => void }) {
  return <button type="button" className="icon-button task-delete-button" title="删除任务" aria-label={`删除 ${quest.title}`} onClick={() => { if (window.confirm(`确定彻底删除“${quest.title}”？此操作不可撤销。`)) onDelete(quest.id) }}><Trash2 size={16} /></button>
}

export function TimelineView({ quests, places, intel, onToggle, onEdit, onViewSource, onDelete }: TimelineViewProps) {
  const sorted = [...quests].sort((a, b) => timelineSortValue(a, intel) - timelineSortValue(b, intel) || a.title.localeCompare(b.title, 'zh-CN'))
  const longEvents = sorted.filter((quest) => quest.kind === 'long-event')
  const datedTasks = sorted.filter((quest) => quest.kind !== 'long-event')
  const grouped = datedTasks.reduce<Record<string, Quest[]>>((acc, quest) => { const label = dayLabel(timelineDayKey(quest, intel)); acc[label] = [...(acc[label] ?? []), quest]; return acc }, {})
  return <div className="timeline-view page-width">
    <div className="page-intro"><div><span className="section-kicker">SCHEDULE · 时间与地点</span><h2>行程</h2></div></div>
    {!!longEvents.length && <section className="long-event-section" aria-label="长期事件">
      <div className="long-event-heading"><div><CalendarRange size={17} /><span>长期事件</span></div><small>跨越多个日期的安排</small></div>
      <div className="long-event-list">{longEvents.map((quest) => {
        const place = places.find((item) => item.id === quest.locationId)
        const done = quest.status === 'done'
        return <article className={`long-event-item ${done ? 'is-done' : ''}`} key={quest.id}>
          <button type="button" className={`timeline-complete-button ${done ? 'is-done' : ''}`} onClick={() => onToggle(quest.id)} disabled={quest.status === 'locked'} aria-label={done ? `重新打开 ${quest.title}` : `标记 ${quest.title} 为已完成`}>{done ? <CheckCircle2 size={17} /> : <Circle size={17} />}<span>{done ? '已完成' : '完成'}</span></button>
          <div className="long-event-period"><CalendarRange size={16} /><span>{formatQuestTargetTime(quest)}</span></div>
          <div className="timeline-copy"><h3>{quest.title}</h3><p>{quest.description}</p><TimeBadges quest={quest} intel={intel} /><div className="timeline-meta"><span><MapPin size={14} />{place?.name ?? '未标注地点'}</span></div></div>
          <div className="timeline-actions"><button type="button" className="icon-button" title="查看来源" aria-label={`查看 ${quest.title} 的来源`} onClick={() => onViewSource(quest)}><FileText size={16} /></button><button type="button" className="icon-button" title="编辑事件" aria-label={`编辑 ${quest.title}`} onClick={() => onEdit(quest)}><Pencil size={16} /></button><DeleteButton quest={quest} onDelete={onDelete} /></div>
        </article>
      })}</div>
    </section>}
    <div className="timeline-list">{Object.entries(grouped).map(([day, items]) => <section className="timeline-day" key={day}><div className="day-marker"><strong>{day}</strong><span>{items.length} 项</span></div><div className="day-items">{items.map((quest) => {
      const place = places.find((item) => item.id === quest.locationId)
      const done = quest.status === 'done'
      return <article className={`timeline-item ${done ? 'is-done' : ''}`} key={quest.id}><button type="button" className={`timeline-complete-button ${done ? 'is-done' : ''}`} onClick={() => onToggle(quest.id)} disabled={quest.status === 'locked'} aria-label={done ? `重新打开 ${quest.title}` : `标记 ${quest.title} 为已完成`}>{done ? <CheckCircle2 size={17} /> : <Circle size={17} />}<span>{done ? '已完成' : '完成'}</span></button><time>{formatTimelineClock(questTimelineAt(quest, intel))}</time><div className="timeline-copy"><h3>{quest.title}</h3><p>{quest.description}</p><TimeBadges quest={quest} intel={intel} /><div className="timeline-meta"><span><MapPin size={14} />{place?.name ?? '未标注地点'}</span></div></div><div className="timeline-actions"><button type="button" className="icon-button" title="查看来源" aria-label={`查看 ${quest.title} 的来源`} onClick={() => onViewSource(quest)}><FileText size={16} /></button><button type="button" className="icon-button" title="编辑任务" aria-label={`编辑 ${quest.title}`} onClick={() => onEdit(quest)}><Pencil size={16} /></button><DeleteButton quest={quest} onDelete={onDelete} /></div></article>
    } )}</div></section>)}</div>
  </div>
}

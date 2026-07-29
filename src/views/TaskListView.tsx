import { CheckCircle2, Circle, Clock3, FileText, MapPin, Pencil, Search, Trash2, UserRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatQuestTime, timelineSortValue } from '../lib/questTime'
import type { IntelItem, Place, Quest } from '../types'

interface TaskListViewProps {
  quests: Quest[]
  places: Place[]
  intel: IntelItem[]
  onToggle: (id: string) => void
  onEdit: (quest: Quest) => void
  onViewSource: (quest: Quest) => void
  onDelete: (id: string) => void
}

type StatusFilter = 'all' | Quest['status']

const statusLabel: Record<Quest['status'], string> = {
  available: '待处理', active: '进行中', done: '已完成', locked: '等待条件',
}
const TASK_ROW_HEIGHT = 196
const OVERSCAN_ROWS = 5

function platformsFor(quest: Quest) {
  if (quest.sourcePlatforms?.length) return [...new Set(quest.sourcePlatforms)]
  return quest.source ? [quest.source] : ['手动记录']
}

export function TaskListView({ quests, places, intel, onToggle, onEdit, onViewSource, onDelete }: TaskListViewProps) {
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(620)
  const listRef = useRef<HTMLElement>(null)
  const scrollFrame = useRef(0)
  const pendingScrollTop = useRef(0)
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return [...quests]
      .filter((quest) => filter === 'all' || quest.status === filter)
      .filter((quest) => !normalized || `${quest.title} ${quest.description} ${quest.providers?.join(' ') ?? ''} ${quest.source ?? ''}`.toLocaleLowerCase('zh-CN').includes(normalized))
      .sort((left, right) => timelineSortValue(left, intel) - timelineSortValue(right, intel) || left.title.localeCompare(right.title, 'zh-CN'))
  }, [filter, intel, query, quests])
  const placeById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places])

  useEffect(() => {
    const element = listRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => { if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current) }, [])

  const safeScrollTop = Math.min(scrollTop, Math.max(0, visible.length * TASK_ROW_HEIGHT - viewportHeight))
  const firstRow = Math.max(0, Math.floor(safeScrollTop / TASK_ROW_HEIGHT) - OVERSCAN_ROWS)
  const lastRow = Math.min(visible.length, Math.ceil((safeScrollTop + viewportHeight) / TASK_ROW_HEIGHT) + OVERSCAN_ROWS)
  const rendered = visible.slice(firstRow, lastRow)
  const handleScroll = (top: number) => {
    pendingScrollTop.current = top
    if (scrollFrame.current) return
    scrollFrame.current = window.requestAnimationFrame(() => { scrollFrame.current = 0; setScrollTop(pendingScrollTop.current) })
  }

  return (
    <div className="task-list-view page-width">
      <div className="page-intro task-list-intro"><div><span className="section-kicker">TASK REGISTER · 全部行动</span><h2>任务列表</h2></div><span className="count-label">{visible.length} / {quests.length} 项</span></div>
      <section className="task-list-toolbar" aria-label="任务筛选"><div className="task-filter" role="group" aria-label="任务状态">{(['all', 'available', 'active', 'locked', 'done'] as StatusFilter[]).map((item) => <button type="button" className={filter === item ? 'is-active' : ''} onClick={() => setFilter(item)} key={item}>{item === 'all' ? '全部' : statusLabel[item]}</button>)}</div><label className="task-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、来源或提供者" /></label></section>
      <section ref={listRef} className="task-list task-list--virtual" aria-label="完整任务列表" onScroll={(event) => handleScroll(event.currentTarget.scrollTop)}>
        <div className="task-list-spacer" style={{ height: `${visible.length * TASK_ROW_HEIGHT}px` }}><div className="task-list-window" style={{ transform: `translateY(${firstRow * TASK_ROW_HEIGHT}px)` }}>
          {rendered.map((quest) => {
            const place = placeById.get(quest.locationId)
            const platforms = platformsFor(quest)
            const isDone = quest.status === 'done'
            return <article className={`task-row task-row--${quest.status}`} style={{ height: `${TASK_ROW_HEIGHT}px` }} key={quest.id}>
              <button type="button" className={`task-complete-button ${isDone ? 'is-done' : ''}`} onClick={() => onToggle(quest.id)} disabled={quest.status === 'locked'} aria-label={isDone ? `重新打开 ${quest.title}` : `标记 ${quest.title} 为已完成`}>
                {isDone ? <CheckCircle2 size={17} /> : <Circle size={17} />}<span>{isDone ? '已完成' : '标记完成'}</span>
              </button>
              <div className="task-row-main"><div className="task-row-heading"><span className={`status-text status-text--${quest.status}`}>{statusLabel[quest.status]}</span><h3>{quest.title}</h3></div><p>{quest.description}</p><div className="task-meta"><span><Clock3 size={14} />{formatQuestTime(quest, intel)}</span><span><MapPin size={14} />{place?.name ?? '未标注地点'}</span></div><div className="task-provenance"><span className="provenance-label">来源</span>{platforms.map((platform) => <span className="source-chip" key={platform}>{platform}</span>)}{quest.providers?.length ? <><UserRound size={13} /><span>{quest.providers.join('、')}</span></> : <span className="muted-provenance">未标注提供者</span>}</div></div>
              <div className="task-row-actions"><button type="button" className="secondary-button task-action" onClick={() => onViewSource(quest)}><FileText size={15} />查看来源</button><button type="button" className="icon-button" title="编辑任务" aria-label={`编辑 ${quest.title}`} onClick={() => onEdit(quest)}><Pencil size={16} /></button><button type="button" className="icon-button task-delete-button" title="删除任务" aria-label={`删除 ${quest.title}`} onClick={() => { if (window.confirm(`确定彻底删除“${quest.title}”？此操作不可撤销。`)) onDelete(quest.id) }}><Trash2 size={16} /></button></div>
            </article>
          })}
        </div></div>
        {!visible.length && <p className="empty-note">没有符合当前筛选条件的任务。</p>}
      </section>
    </div>
  )
}

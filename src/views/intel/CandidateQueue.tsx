import { memo, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Sparkles, Trash2 } from 'lucide-react'

import type { AiFeedbackReason, AiTaskCandidate, IntelItem } from '../../types'
import { sourceProvider } from '../../lib/people'
import { formatQuestTime } from '../../lib/questTime'

const ROW_HEIGHT = 184
const OVERSCAN = 5

interface CandidateQueueProps {
  open: boolean
  candidates: AiTaskCandidate[]
  selectedIds: ReadonlySet<string>
  intelById: ReadonlyMap<string, IntelItem>
  onToggleOpen: () => void
  onSelectAll: () => void
  onToggleCandidate: (id: string) => void
  onDismiss: (ids: string[], reason?: AiFeedbackReason) => void
  onCreateAll: () => void
  onCreateSelected: () => void
}

export const CandidateQueue = memo(function CandidateQueue({
  open,
  candidates,
  selectedIds,
  intelById,
  onToggleOpen,
  onSelectAll,
  onToggleCandidate,
  onDismiss,
  onCreateAll,
  onCreateSelected,
}: CandidateQueueProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef(0)
  const pendingScrollTopRef = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)

  useEffect(() => {
    const element = listRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const safeScrollTop = Math.min(scrollTop, Math.max(0, candidates.length * ROW_HEIGHT - viewportHeight))
  const first = Math.max(0, Math.floor(safeScrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(candidates.length, Math.ceil((safeScrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const rendered = candidates.slice(first, last)

  const handleScroll = (top: number) => {
    pendingScrollTopRef.current = top
    if (scrollFrameRef.current) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0
      setScrollTop(pendingScrollTopRef.current)
    })
  }

  return (
    <section className={`intel-list-section intel-collapsible-section ${open ? 'is-open' : 'is-collapsed'}`}>
      <div className="list-heading">
        <div><span className="section-kicker">REVIEW QUEUE · 人工确认</span><h2><button type="button" className="intel-section-toggle" aria-expanded={open} onClick={onToggleOpen}>候选任务<ChevronDown size={17} /></button></h2></div>
        <div className="list-heading-actions">
          <span>{candidates.length} 个待确认</span>
          <button type="button" className="secondary-button" onClick={onSelectAll} disabled={!candidates.length}>全选</button>
          <button type="button" className="secondary-button" onClick={() => onDismiss([...selectedIds])} disabled={!selectedIds.size}><Trash2 size={15} />忽略已选 {selectedIds.size}</button>
          <button type="button" className="primary-button bulk-quest-button" onClick={onCreateAll} disabled={!candidates.length}><Sparkles size={15} />一键生成全部</button>
          <button type="button" className="primary-button bulk-quest-button" onClick={onCreateSelected} disabled={!selectedIds.size}><Check size={15} />生成已选 {selectedIds.size}</button>
        </div>
      </div>
      {open && <div ref={listRef} className={`candidate-list ${candidates.length ? 'candidate-list--virtual' : ''}`} onScroll={(event) => handleScroll(event.currentTarget.scrollTop)}>
        <div className="candidate-list-spacer" style={{ height: `${candidates.length * ROW_HEIGHT}px` }}>
          <div className="candidate-list-window" style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
            {rendered.map((candidate) => {
              const sources = candidate.sourceIds.map((id) => intelById.get(id)).filter((item): item is IntelItem => Boolean(item))
              const platforms = [...new Set(sources.map((item) => item.source))]
              const providers = [...new Set(sources.map(sourceProvider).filter((name): name is string => Boolean(name)))]
              return <article className="candidate-item" style={{ height: `${ROW_HEIGHT}px` }} key={candidate.id}>
                <input type="checkbox" aria-label={`选择 ${candidate.title}`} checked={selectedIds.has(candidate.id)} onChange={() => onToggleCandidate(candidate.id)} />
                <div><div className="candidate-meta">{platforms.map((platform) => <span key={platform}>{platform}</span>)}{providers.length > 0 && <span>提供者：{providers.join('、')}</span>}{candidate.locationPrecision === 'exact' && <span>精确地点</span>}{candidate.locationPrecision === 'approximate' && <span>大致范围</span>}</div><h3>{candidate.title}</h3><p>{candidate.description}</p><small>{candidate.place ?? '未指定地点'} · {formatQuestTime({ ...candidate, sourceCapturedAt: candidate.sourceCapturedAt ?? candidate.createdAt }, sources)}</small></div>
                <label className="candidate-feedback"><span>忽略并学习</span><select aria-label={`忽略 ${candidate.title} 的原因`} defaultValue="" onChange={(event) => { const reason = event.target.value as AiFeedbackReason; if (reason) onDismiss([candidate.id], reason) }}><option value="" disabled>选择原因</option><option value="expired">已经过期</option><option value="ownership">人物/方向错误</option><option value="completed">已经完成</option><option value="not-actionable">没有行动价值</option><option value="incorrect">内容不准确</option><option value="other">其他/直接删除</option></select></label>
              </article>
            })}
          </div>
        </div>
        {!candidates.length && <p className="empty-note">还没有模型候选。提炼会按对话合并结果，并在这里等待确认。</p>}
      </div>}
    </section>
  )
})

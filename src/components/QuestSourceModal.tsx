import { FileText, MapPin, Users, X } from 'lucide-react'
import type { IntelItem, Quest } from '../types'

interface QuestSourceModalProps {
  quest?: Quest
  intel: IntelItem[]
  onClose: () => void
}

export function QuestSourceModal({ quest, intel, onClose }: QuestSourceModalProps) {
  if (!quest) return null
  const evidence = intel.filter((item) => quest.sourceIds?.includes(item.id)).slice(0, 12)
  const platforms = quest.sourcePlatforms?.length ? quest.sourcePlatforms : quest.source ? [quest.source] : ['手动记录']
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal source-modal" role="dialog" aria-modal="true" aria-labelledby="source-modal-title">
        <div className="modal-header"><div><span className="section-kicker">SOURCE TRACE</span><h2 id="source-modal-title">{quest.title}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>
        <div className="source-modal-body">
          <div className="source-summary"><span><FileText size={16} />{platforms.join(' / ')}</span>{quest.providers?.length ? <span><Users size={16} />{quest.providers.join('、')}</span> : null}<span><MapPin size={16} />{quest.sourceIds?.length ?? 0} 条引用记录</span></div>
          {evidence.map((item) => <article className="source-evidence" key={item.id}><time>{item.source} · {item.capturedAt}</time><h3>{item.title}</h3><p>{item.summary}</p><code>{item.id}</code></article>)}
          {!evidence.length && <p className="empty-note">该任务没有可显示的原始记录。手动任务仅保留其来源标记。</p>}
        </div>
      </section>
    </div>
  )
}

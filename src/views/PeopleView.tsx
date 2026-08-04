import { FileText, MessageCircle, Search, Send, Trash2, Users, X, Save } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AvatarImage } from '../components/AvatarImage'
import type { IntelItem, Person, Quest } from '../types'

interface PeopleViewProps {
  people: Person[]
  quests: Quest[]
  selectedId: string
  onSelect: (id: string) => void
  onGoIntel: () => void
  onDismiss: (ids: string[]) => void
  onUpdateProfileNotes: (id: string, notes: string) => void
  onRetryPortrait: (id: string) => void
  intelCount: number
  intel: IntelItem[]
}

const PERSON_ROW_HEIGHT = 104
const PERSON_OVERSCAN = 5
const CONVERSATION_ROW_HEIGHT = 118
const CONVERSATION_OVERSCAN = 5
const portraitColors = ['#b96f58', '#648b79', '#6f84a5', '#9d8058', '#8b708b', '#5f8b8f']

function initialsFor(name: string) {
  const compact = name.replace(/\s+/g, '')
  return compact.slice(-2) || '?'
}

function portraitColorFor(person: Person) {
  let hash = 2166136261
  for (const character of person.id || person.name) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return portraitColors[(hash >>> 0) % portraitColors.length]
}

function formatFirstObserved(value?: string) {
  if (!value) return '未能从引用记录中确定'
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

function formatChatTime(value?: string) {
  if (!value) return '时间未记录'
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
    : value
}

function portraitFor(person: Person) {
  const portrait = person.portrait?.trim() ?? ''
  if (!portrait) return ''
  const hasConfirmedBackground = Boolean(person.profileNotes?.trim()) && person.profileNotesUsed === true
  const hasChatProvenance = (person.portraitSourceIds?.length ?? 0) >= 2
    && (person.evidence?.length ?? 0) > 0
  return hasConfirmedBackground || hasChatProvenance ? portrait : ''
}

function PersonProfileEditor({ person, onSave }: { person: Person; onSave: (notes: string) => void }) {
  const [draft, setDraft] = useState(person.profileNotes ?? '')
  return <section className="person-profile-editor">
    <label><span>人物底稿 <small>仅填写你本人确认的背景、经历或长期观察；不会写入聊天事实。</small></span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} maxLength={6000} placeholder="例如：与此人于 2024 年秋认识；她目前在准备考研。只填写你确认过的内容。" /></label>
    <div className="person-profile-editor-actions"><small>{draft.length}/6000</small><button type="button" className="secondary-button" onClick={() => onSave(draft)} disabled={draft.trim() === (person.profileNotes ?? '').trim()}><Save size={14} />保存并重写人物志</button></div>
  </section>
}

export function PeopleView({ people, quests, selectedId, onSelect, onGoIntel, onDismiss, onUpdateProfileNotes, onRetryPortrait, intelCount, intel }: PeopleViewProps) {
  const [scrollTop, setScrollTop] = useState(0)
  const [query, setQuery] = useState('')
  const [selectedPeopleIds, setSelectedPeopleIds] = useState<Set<string>>(() => new Set())
  const [viewportHeight, setViewportHeight] = useState(520)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef(0)
  const pendingScrollTop = useRef(0)
  const [openConversationId, setOpenConversationId] = useState<string>()
  const [conversationScrollTop, setConversationScrollTop] = useState(0)
  const [conversationViewportHeight, setConversationViewportHeight] = useState(560)
  const conversationListRef = useRef<HTMLDivElement>(null)
  const conversationScrollFrame = useRef(0)
  const pendingConversationScrollTop = useRef(0)
  const orderedPeople = useMemo(() => [...people].sort((left, right) => {
    const sourceDelta = right.sourceIds.length - left.sourceIds.length
    if (sourceDelta) return sourceDelta
    const conversationDelta = (right.conversationIds?.length ?? 0) - (left.conversationIds?.length ?? 0)
    if (conversationDelta) return conversationDelta
    const rightTime = new Date(right.lastObservedAt ?? '').getTime()
    const leftTime = new Date(left.lastObservedAt ?? '').getTime()
    if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) return rightTime - leftTime
    return left.name.localeCompare(right.name, 'zh-CN')
  }), [people])
  const visiblePeople = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN')
    if (!keyword) return orderedPeople
    return orderedPeople.filter((person) => `${person.name} ${person.platforms.join(' ')}`.toLocaleLowerCase('zh-CN').includes(keyword))
  }, [orderedPeople, query])
  const selected = visiblePeople.find((person) => person.id === selectedId) ?? visiblePeople[0]
  const selectedPortrait = selected ? portraitFor(selected) : ''
  const portraitFailed = selected?.portraitStatus === 'failed'
  const selectedFacts = selected?.evidence?.filter((claim) => claim.kind === 'fact').slice(0, 12) ?? []
  const selectedPreferences = selected?.evidence?.filter((claim) => claim.kind === 'preference').slice(0, 8) ?? []
  const selectedAdvice = selected?.advice ?? []
  const linked = quests.filter((quest) => selected && quest.characterIds.includes(selected.id))
  const intelIndexes = useMemo(() => {
    const byId = new Map<string, IntelItem>()
    const byConversation = new Map<string, IntelItem[]>()
    for (const item of intel) {
      byId.set(item.id, item)
      if (!item.conversationId) continue
      const records = byConversation.get(item.conversationId)
      if (records) records.push(item)
      else byConversation.set(item.conversationId, [item])
    }
    return { byId, byConversation }
  }, [intel])
  const conversationIds = useMemo(() => {
    if (!selected) return []
    const citedConversationIds = selected.sourceIds
      .map((id) => intelIndexes.byId.get(id)?.conversationId)
      .filter((id): id is string => Boolean(id))
    return [...new Set([...(selected.conversationIds ?? []), ...citedConversationIds])]
  }, [intelIndexes, selected])
  const personConversations = useMemo(() => conversationIds.map((id) => {
    const records = [...intelIndexes.byConversation.get(id) ?? []].sort((left, right) => {
      const leftTime = new Date(left.capturedAt).getTime()
      const rightTime = new Date(right.capturedAt).getTime()
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
      if (Number.isFinite(leftTime)) return -1
      if (Number.isFinite(rightTime)) return 1
      return left.capturedAt.localeCompare(right.capturedAt)
    })
    return {
      id,
      records,
      name: records[0]?.conversationName || selected?.name || '原始对话',
      source: records[0]?.source || '导入记录',
    }
  }).filter((conversation) => conversation.records.length), [conversationIds, intelIndexes, selected?.name])
  const openConversation = personConversations.find((conversation) => conversation.id === openConversationId)
  const openConversationRecords = openConversation?.records ?? []
  const safeConversationScrollTop = Math.min(conversationScrollTop, Math.max(0, openConversationRecords.length * CONVERSATION_ROW_HEIGHT - conversationViewportHeight))
  const firstConversationMessage = Math.max(0, Math.floor(safeConversationScrollTop / CONVERSATION_ROW_HEIGHT) - CONVERSATION_OVERSCAN)
  const lastConversationMessage = Math.min(openConversationRecords.length, Math.ceil((safeConversationScrollTop + conversationViewportHeight) / CONVERSATION_ROW_HEIGHT) + CONVERSATION_OVERSCAN)
  const renderedConversationMessages = openConversationRecords.slice(firstConversationMessage, lastConversationMessage)
  const safeScrollTop = Math.min(scrollTop, Math.max(0, visiblePeople.length * PERSON_ROW_HEIGHT - viewportHeight))
  const firstPerson = Math.max(0, Math.floor(safeScrollTop / PERSON_ROW_HEIGHT) - PERSON_OVERSCAN)
  const lastPerson = Math.min(visiblePeople.length, Math.ceil((safeScrollTop + viewportHeight) / PERSON_ROW_HEIGHT) + PERSON_OVERSCAN)
  const renderedPeople = visiblePeople.slice(firstPerson, lastPerson)
  const selectedPeopleCount = [...selectedPeopleIds].filter((id) => people.some((person) => person.id === id)).length

  useEffect(() => {
    const element = listRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current)
    if (conversationScrollFrame.current) window.cancelAnimationFrame(conversationScrollFrame.current)
  }, [])

  useEffect(() => {
    const element = conversationListRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setConversationViewportHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [openConversationId])

  const handleScroll = (top: number) => {
    pendingScrollTop.current = top
    if (scrollFrame.current) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0
      setScrollTop(pendingScrollTop.current)
    })
  }

  const openChat = (conversationId: string) => {
    setOpenConversationId(conversationId)
    setConversationScrollTop(0)
    if (conversationListRef.current) conversationListRef.current.scrollTop = 0
  }

  const handleConversationScroll = (top: number) => {
    pendingConversationScrollTop.current = top
    if (conversationScrollFrame.current) return
    conversationScrollFrame.current = window.requestAnimationFrame(() => {
      conversationScrollFrame.current = 0
      setConversationScrollTop(pendingConversationScrollTop.current)
    })
  }

  const togglePersonSelection = (id: string) => {
    setSelectedPeopleIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleVisibleSelection = () => {
    const visibleIds = visiblePeople.map((person) => person.id)
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedPeopleIds.has(id))
    setSelectedPeopleIds((current) => {
      const next = new Set(current)
      visibleIds.forEach((id) => allVisibleSelected ? next.delete(id) : next.add(id))
      return next
    })
  }

  const deleteSelectedPeople = () => {
    const ids = [...selectedPeopleIds].filter((id) => people.some((person) => person.id === id))
    if (!ids.length) return
    if (!window.confirm(`确定删除已选的 ${ids.length} 张人物卡吗？原始聊天记录不会删除，已删除卡片不会在下次同步时自动恢复。`)) return
    onDismiss(ids)
    setSelectedPeopleIds(new Set())
  }

  const allVisibleSelected = visiblePeople.length > 0 && visiblePeople.every((person) => selectedPeopleIds.has(person.id))

  return (
    <div className="people-layout page-width">
      <section className="people-index">
        <div className="page-intro">
          <div><span className="section-kicker">EVIDENCE-BOUND MODEL NOTES</span><h2>人物</h2></div>
          <span className="count-label"><Users size={16} />{people.length} 位</span>
        </div>
        <p className="people-disclaimer">按可核实互动证据由多到少排列。每个由导出目录明确标记为私聊的人都会保留一张人物卡；事实必须能引用原始记录，“人物形象”只在多条对话支持时给出谨慎印象。</p>
        {!people.length && <div className="people-analysis-bar"><div><FileText size={19} /><span>{intelCount ? `已接入 ${intelCount} 条记录。人物会在情报库提炼任务时自动核验并加入。` : '先在情报库导入聊天或平台记录，再提炼任务。'}</span></div><button type="button" className="primary-button" onClick={onGoIntel}><Send size={16} />前往情报库</button></div>}
        {!!people.length && <div className="people-toolbar"><label className="people-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0 }} placeholder="搜索人物或来源平台" aria-label="搜索人物" /></label><div className="people-toolbar-actions"><span>{visiblePeople.length === people.length ? `${people.length} 位人物` : `匹配 ${visiblePeople.length}/${people.length} 位`}</span><button type="button" className="secondary-button people-select-all" onClick={toggleVisibleSelection} disabled={!visiblePeople.length}>{allVisibleSelected ? '取消全选' : '全选'}</button><button type="button" className="danger-button people-bulk-delete" onClick={deleteSelectedPeople} disabled={!selectedPeopleCount}><Trash2 size={14} />删除已选 {selectedPeopleCount}</button></div></div>}

        <div ref={listRef} className={`people-list ${people.length ? 'people-list--virtual' : ''}`} onScroll={(event) => handleScroll(event.currentTarget.scrollTop)}>
          <div className="people-list-spacer" style={{ height: `${visiblePeople.length * PERSON_ROW_HEIGHT}px` }}>
            <div className="people-list-window" style={{ transform: `translateY(${firstPerson * PERSON_ROW_HEIGHT}px)` }}>
              {renderedPeople.map((person) => {
                const color = portraitColorFor(person)
                const selectedForDeletion = selectedPeopleIds.has(person.id)
                return <article className={`person-card-row ${selectedForDeletion ? 'is-marked' : ''}`} style={{ height: `${PERSON_ROW_HEIGHT}px` }} key={person.id}>
                  <label className="person-select"><input type="checkbox" checked={selectedForDeletion} onChange={() => togglePersonSelection(person.id)} aria-label={`选择 ${person.name}`} /><span /></label>
                  <button type="button" className={`person-card ${selected?.id === person.id ? 'is-selected' : ''}`} onClick={() => onSelect(person.id)}>
                    <div className="portrait" style={{ '--portrait-color': color } as CSSProperties}><AvatarImage source={person.avatarUrl} alt="" loading="lazy" /><span>{initialsFor(person.name)}</span><i /></div>
                    <div className="person-summary"><span>模型核验 · {person.platforms.join(' / ') || '来源平台未标注'}</span><h3>{person.name}</h3><div className="person-record-count"><FileText size={13} />{person.sourceIds.length} 条引用记录</div></div>
                  </button>
                </article>
              })}
            </div>
          </div>
        </div>
        {!people.length && <p className="empty-note">尚无可核验人物信息。情报库提炼任务时，会同步加入有原始证据的人物事实。</p>}
        {!!people.length && !visiblePeople.length && <p className="empty-note">没有匹配的人物。</p>}
      </section>

      {selected && (
        <aside className="person-detail">
          <div className="person-hero" style={{ '--portrait-color': portraitColorFor(selected) } as CSSProperties}>
          <div className="person-hero-identity"><div className="large-monogram"><AvatarImage source={selected.avatarUrl} alt="" loading="lazy" /><span>{initialsFor(selected.name)}</span></div><div><span>MODEL-VERIFIED PERSON</span><h2>{selected.name}</h2></div></div>
            <button type="button" className="person-delete" aria-label={`删除 ${selected.name}`} title="删除此人物条目" onClick={() => onDismiss([selected.id])}><Trash2 size={16} /></button>
          </div>
          <div className="person-observed"><span>最早可核实互动</span><strong>{formatFirstObserved(selected.firstObservedAt)}</strong></div>
          <div className={`person-portrait-note ${selectedPortrait ? '' : 'is-insufficient'}`}><span>人物刻画 {selected?.profileNotesUsed && selected.profileNotes?.trim() ? '· 已确认底稿参与' : ''}</span><p>{selectedPortrait || (portraitFailed ? '人物刻画生成失败，系统没有保存未经证据校验的内容。' : '当前没有通过证据校验的人物志。请补充更多授权来源，或在下方填写你确认的人物底稿。')}</p><small>{selectedPortrait ? (selected.profileNotesUsed ? '人物志综合了你确认的人物底稿；聊天事实仍单独列在下方，不会被底稿伪装成聊天结论。' : '人物志只综合多条可追溯聊天证据，并保留证据边界。') : (portraitFailed ? `${selected.portraitFailure || '模型未通过校验。'} 可手动重试。` : '没有可靠画像时不会用事实列表拼接成假想性格。')}</small>{portraitFailed && <button type="button" className="secondary-button" onClick={() => onRetryPortrait(selected.id)}>重试人物刻画</button>}</div>
          <PersonProfileEditor key={selected.id} person={selected} onSave={(notes) => onUpdateProfileNotes(selected.id, notes)} />
          {!!selectedFacts.length && <section className="person-evidence-section"><span className="subsection-label">已核验事实</span>{selectedFacts.map((claim, index) => <div key={`${selected.id}-fact-${index}`}><p>{claim.text}</p><small>原话：“{claim.quote}” · {claim.sourceIds.join('、')}</small></div>)}</section>}
          {!!selectedPreferences.length && <section className="person-evidence-section person-evidence-section--preference"><span className="subsection-label">偏好线索</span>{selectedPreferences.map((claim, index) => <div key={`${selected.id}-preference-${index}`}><p>{claim.text}</p><small>原话：“{claim.quote}” · {claim.sourceIds.join('、')}</small></div>)}</section>}
          {!!selectedAdvice.length && <div className="person-interaction-advice"><span>相处建议</span>{selectedAdvice.map((item, index) => <p key={`${selected.id}-advice-${index}`}>{item}</p>)}</div>}
          <div className="person-detail-actions"><button type="button" className="secondary-button" onClick={() => personConversations[0] && openChat(personConversations[0].id)} disabled={!personConversations.length}><MessageCircle size={15} />查看聊天记录{personConversations.length > 1 ? ` · ${personConversations.length}` : ''}</button><small>{personConversations.length ? '在当前页面打开该人物卡引用的原始对话，不会跳转。' : '当前人物卡尚无可打开的对话目录。'}</small></div>
          <div className="source-id-list">
            <span className="subsection-label">模型引用的记录 ID</span>
            <div>{selected.sourceIds.map((id) => <code key={id}>{id}</code>)}</div>
            <small>{selected.model}</small>
          </div>
          <div className="linked-quests">
            <span className="subsection-label">关联任务</span>
            {linked.map((quest) => <article key={quest.id}><span className={`status-pip status-pip--${quest.status}`} /><div><h3>{quest.title}</h3><p>{quest.status === 'done' ? '已完成' : quest.status === 'active' ? '进行中' : '等待行动'}</p></div></article>)}
            {!linked.length && <p className="empty-note">没有与该人物条目关联的任务。</p>}
          </div>
        </aside>
      )}
      {openConversation && <div className="modal-backdrop people-conversation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenConversationId(undefined) }}>
        <section className="modal people-conversation-modal" role="dialog" aria-modal="true" aria-label={`${openConversation.name} 的原始对话`}>
          <header className="modal-header people-conversation-header"><div><span className="section-kicker">RAW CONVERSATION · 本机原始记录</span><h2>{openConversation.name}</h2><p>{openConversation.source} · {openConversationRecords.length.toLocaleString('zh-CN')} 条消息</p></div><button type="button" className="icon-button" title="关闭聊天记录" aria-label="关闭聊天记录" onClick={() => setOpenConversationId(undefined)}><X size={17} /></button></header>
          {personConversations.length > 1 && <label className="people-conversation-switch"><span>关联对话</span><select value={openConversation.id} onChange={(event) => openChat(event.target.value)}>{personConversations.map((conversation) => <option value={conversation.id} key={conversation.id}>{conversation.name} · {conversation.records.length.toLocaleString('zh-CN')} 条</option>)}</select></label>}
          <div ref={conversationListRef} className="people-conversation-list" onScroll={(event) => handleConversationScroll(event.currentTarget.scrollTop)}><div className="conversation-message-spacer" style={{ height: `${openConversationRecords.length * CONVERSATION_ROW_HEIGHT}px` }}><div className="conversation-message-window" style={{ transform: `translateY(${firstConversationMessage * CONVERSATION_ROW_HEIGHT}px)` }}>{renderedConversationMessages.map((item) => <article className="conversation-message" style={{ height: `${CONVERSATION_ROW_HEIGHT}px` }} key={item.id}><div><span>{item.speakerRole === 'self' ? '你' : item.speakerRole === 'other' ? '对方' : '发言方向未确认'}</span>{item.speaker && <strong>{item.speaker}</strong>}{item.messageType && <em>类型：{item.messageType}</em>}<time>{formatChatTime(item.capturedAt)}</time></div><p title={item.content || item.summary}>{item.content || item.summary}</p></article>)}</div></div></div>
        </section>
      </div>}
    </div>
  )
}

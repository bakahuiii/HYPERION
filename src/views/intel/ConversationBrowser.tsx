import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Clock3, MessagesSquare, Search, Sparkles, X } from 'lucide-react'

import type { ConversationTimeline } from '../../lib/intelConversationView'
import { timelineBucket } from '../../lib/intelConversationView'

const MESSAGE_ROW_HEIGHT = 118
const MESSAGE_OVERSCAN = 5

interface ConversationBrowserProps {
  open: boolean
  conversations: ConversationTimeline[]
  filteredConversations: ConversationTimeline[]
  analysisConversationId: string
  conversationRequest?: { id: string; sequence: number }
  onToggleOpen: () => void
  onOpen: () => void
  onAnalyze: (id: string) => void
  onResetTimeline: () => void
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatChatTime(value?: string) {
  if (!value) return '未记录时间'
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '未记录时间'
}

function formatTimelinePeriod(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  return match ? `${match[1]}年${Number(match[2])}月` : value
}

function latestCounterpartRecord(conversation: ConversationTimeline) {
  for (let index = conversation.records.length - 1; index >= 0; index -= 1) {
    if (conversation.records[index].speakerRole === 'other') return conversation.records[index]
  }
  return conversation.records.at(-1)
}

export function ConversationBrowser({
  open,
  conversations,
  filteredConversations,
  analysisConversationId,
  conversationRequest,
  onToggleOpen,
  onOpen,
  onAnalyze,
  onResetTimeline,
}: ConversationBrowserProps) {
  const [selectedConversationId, setSelectedConversationId] = useState<string>()
  const [conversationSearch, setConversationSearch] = useState('')
  const [messageScrollTop, setMessageScrollTop] = useState(0)
  const [messageViewportHeight, setMessageViewportHeight] = useState(600)
  const messageListRef = useRef<HTMLDivElement>(null)
  const messageScrollFrame = useRef(0)
  const pendingMessageScrollTop = useRef(0)
  const visibleConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase()
    return query
      ? filteredConversations.filter((conversation) => conversation.name.toLocaleLowerCase().includes(query))
      : filteredConversations
  }, [conversationSearch, filteredConversations])
  const conversationsByPeriod = useMemo(() => {
    const groups = new Map<string, ConversationTimeline[]>()
    for (const conversation of visibleConversations) {
      const bucket = timelineBucket(conversation)
      const current = groups.get(bucket)
      if (current) current.push(conversation)
      else groups.set(bucket, [conversation])
    }
    return [...groups.entries()]
  }, [visibleConversations])
  const selectedConversation = useMemo(
    () => visibleConversations.find((conversation) => conversation.id === selectedConversationId),
    [selectedConversationId, visibleConversations],
  )
  const selectedConversationRecords = selectedConversation?.records ?? []
  const safeMessageScrollTop = Math.min(messageScrollTop, Math.max(0, selectedConversationRecords.length * MESSAGE_ROW_HEIGHT - messageViewportHeight))
  const firstMessage = Math.max(0, Math.floor(safeMessageScrollTop / MESSAGE_ROW_HEIGHT) - MESSAGE_OVERSCAN)
  const lastMessage = Math.min(selectedConversationRecords.length, Math.ceil((safeMessageScrollTop + messageViewportHeight) / MESSAGE_ROW_HEIGHT) + MESSAGE_OVERSCAN)
  const renderedMessages = selectedConversationRecords.slice(firstMessage, lastMessage)

  useEffect(() => {
    if (!conversationRequest) return
    const timer = window.setTimeout(() => {
      onResetTimeline()
      onOpen()
      setSelectedConversationId(conversationRequest.id)
      setMessageScrollTop(0)
      if (messageListRef.current) messageListRef.current.scrollTop = 0
    }, 0)
    return () => window.clearTimeout(timer)
  }, [conversationRequest, onOpen, onResetTimeline])

  useEffect(() => {
    const element = messageListRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setMessageViewportHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [selectedConversationId])

  useEffect(() => () => {
    if (messageScrollFrame.current) window.cancelAnimationFrame(messageScrollFrame.current)
  }, [])

  const handleMessageScroll = (top: number) => {
    pendingMessageScrollTop.current = top
    if (messageScrollFrame.current) return
    messageScrollFrame.current = window.requestAnimationFrame(() => {
      messageScrollFrame.current = 0
      setMessageScrollTop(pendingMessageScrollTop.current)
    })
  }

  const openConversation = (id: string) => {
    setSelectedConversationId(id)
    setMessageScrollTop(0)
    if (messageListRef.current) messageListRef.current.scrollTop = 0
  }

  return (
    <section className={`intel-list-section conversation-section intel-collapsible-section ${open ? 'is-open' : 'is-collapsed'}`}>
      <div className="list-heading"><div><span className="section-kicker">LOCAL CONVERSATIONS · 原始对话目录</span><h2><button type="button" className="intel-section-toggle" aria-expanded={open} onClick={onToggleOpen}>对话档案<ChevronDown size={17} /></button></h2></div><div className="list-heading-actions"><label className="conversation-search"><Search size={15} /><input type="search" value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="搜索会话名称" aria-label="搜索会话名称" />{conversationSearch && <button type="button" aria-label="清除会话搜索" title="清除会话搜索" onClick={() => setConversationSearch('')}><X size={14} /></button>}</label><span>{visibleConversations.length}/{filteredConversations.length} 个对话{filteredConversations.length !== conversations.length ? ` · 全部 ${conversations.length}` : ''}</span></div></div>
      {open && <>
        <div className="bulk-note">这里是去重后的原始消息档案，不是模型候选。每个文件夹或导出会话被归为一个对话；按最后聊天时间倒序和月份分组。选择时间范围后，显示范围与模型提炼范围一致。</div>
        <div className="conversation-timeline">
          {conversationsByPeriod.map(([period, entries]) => <section className="conversation-period" key={period}>
            <div className="conversation-period-heading"><span>{period === '未记录时间' ? period : `${formatTimelinePeriod(period)} · 最后聊天`}</span><small>{entries.length} 个对话</small></div>
            {entries.map((conversation) => {
              const latest = latestCounterpartRecord(conversation)
              const kind = conversation.kind === 'group' ? '群聊' : conversation.kind === 'direct' ? '私聊' : '对话'
              return <article className={`conversation-row ${selectedConversation?.id === conversation.id ? 'is-selected' : ''} ${analysisConversationId === conversation.id ? 'is-analysis-target' : ''}`} key={conversation.id}>
                <div className="conversation-row-icon"><MessagesSquare size={17} /></div>
                <div className="conversation-row-copy"><div><span>{conversation.source}</span><span>{kind}</span><time><Clock3 size={12} />最后聊天：{formatChatTime(conversation.lastAt)}</time></div><h3>{conversation.name}</h3><p>{latest?.content || latest?.summary || '没有可显示的消息内容。'}</p><small>{formatCount(conversation.records.length)} 条消息{conversation.firstAt ? ` · 最早 ${formatChatTime(conversation.firstAt)}` : ' · 消息时间未记录'}</small></div>
                <div className="conversation-row-actions"><button type="button" className="conversation-analyze" onClick={() => onAnalyze(conversation.id)} aria-label={`单独提炼 ${conversation.name}`}><Sparkles size={14} />单独提炼</button><button type="button" className="conversation-open" onClick={() => openConversation(conversation.id)} aria-label={`查看 ${conversation.name} 的对话`}><span>查看对话</span><ChevronRight size={16} /></button></div>
              </article>
            })}
          </section>)}
          {!visibleConversations.length && <p className="empty-note">{conversationSearch.trim() ? '没有名称匹配的对话。' : '当前时间范围内没有最后聊天时间可匹配的对话。'}</p>}
        </div>
        {selectedConversation && <section className="conversation-detail" aria-label={`${selectedConversation.name} 的对话内容`}>
          <div className="conversation-detail-heading"><div><span className="section-kicker">DIALOGUE · 按消息时间排序</span><h3>{selectedConversation.name}</h3><p>{selectedConversation.source} · {selectedConversation.kind === 'group' ? '群聊' : selectedConversation.kind === 'direct' ? '私聊' : '对话'} · {formatCount(selectedConversation.records.length)} 条消息 · 最后聊天 {formatChatTime(selectedConversation.lastAt)}</p></div><button type="button" className="icon-button" title="关闭对话内容" aria-label="关闭对话内容" onClick={() => setSelectedConversationId(undefined)}><X size={16} /></button></div>
          <div ref={messageListRef} className="conversation-message-list" onScroll={(event) => handleMessageScroll(event.currentTarget.scrollTop)}><div className="conversation-message-spacer" style={{ height: `${selectedConversationRecords.length * MESSAGE_ROW_HEIGHT}px` }}><div className="conversation-message-window" style={{ transform: `translateY(${firstMessage * MESSAGE_ROW_HEIGHT}px)` }}>{renderedMessages.map((item) => <article className="conversation-message" style={{ height: `${MESSAGE_ROW_HEIGHT}px` }} key={item.id}><div><span>{item.speakerRole === 'self' ? '本人发言' : item.speakerRole === 'other' ? '对方发言' : '发言方向未确认'}</span>{item.speaker && <strong>{item.speaker}</strong>}{item.messageType && <em>类型：{item.messageType}</em>}<time>{formatChatTime(item.capturedAt)}</time></div><p title={item.content || item.summary}>{item.content || item.summary}</p></article>)}</div></div></div>
        </section>}
      </>}
    </section>
  )
}

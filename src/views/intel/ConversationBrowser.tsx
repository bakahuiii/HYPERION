import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Clock3, MessagesSquare, Search, Sparkles, X } from 'lucide-react'

import { loadSharedIntelConversationPage, type ArchiveConversationSummary } from '../../lib/intelStore'
import { timelineBucket } from '../../lib/intelConversationView'
import type { IntelItem } from '../../types'

const MESSAGE_ROW_HEIGHT = 118
const MESSAGE_OVERSCAN = 5
const CONVERSATION_RENDER_BATCH_SIZE = 120

interface ConversationBrowserProps {
  open: boolean
  conversations: ArchiveConversationSummary[]
  filteredConversations: ArchiveConversationSummary[]
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
  const [selectedConversationRecords, setSelectedConversationRecords] = useState<IntelItem[]>([])
  const [selectedConversationRecordCount, setSelectedConversationRecordCount] = useState(0)
  const [selectedConversationCursor, setSelectedConversationCursor] = useState<string | null>(null)
  const [selectedConversationLoading, setSelectedConversationLoading] = useState(false)
  const [selectedConversationError, setSelectedConversationError] = useState('')
  const [messageScrollTop, setMessageScrollTop] = useState(0)
  const [messageViewportHeight, setMessageViewportHeight] = useState(600)
  const [conversationRenderLimit, setConversationRenderLimit] = useState(CONVERSATION_RENDER_BATCH_SIZE)
  const messageListRef = useRef<HTMLDivElement>(null)
  const messageScrollFrame = useRef(0)
  const pendingMessageScrollTop = useRef(0)
  const selectedRequestRef = useRef(0)
  const matchingConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase()
    return query
      ? filteredConversations.filter((conversation) => conversation.name.toLocaleLowerCase().includes(query))
      : filteredConversations
  }, [conversationSearch, filteredConversations])
  const visibleConversations = useMemo(
    () => matchingConversations.slice(0, conversationSearch.trim() ? CONVERSATION_RENDER_BATCH_SIZE : conversationRenderLimit),
    [conversationRenderLimit, conversationSearch, matchingConversations],
  )
  const conversationsByPeriod = useMemo(() => {
    const groups = new Map<string, ArchiveConversationSummary[]>()
    for (const conversation of visibleConversations) {
      const bucket = timelineBucket(conversation)
      const current = groups.get(bucket)
      if (current) current.push(conversation)
      else groups.set(bucket, [conversation])
    }
    return [...groups.entries()]
  }, [visibleConversations])
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId),
    [conversations, selectedConversationId],
  )
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

  const readSelectedConversationPage = useCallback(async (conversationId: string, cursor?: string, append = false) => {
    const request = selectedRequestRef.current + 1
    selectedRequestRef.current = request
    setSelectedConversationLoading(true)
    setSelectedConversationError('')
    try {
      const page = await loadSharedIntelConversationPage(conversationId, { cursor, limit: 250 })
      if (request !== selectedRequestRef.current) return
      setSelectedConversationRecords((current) => {
        if (!append) return page.items
        const known = new Set(current.map((item) => item.id))
        return [...current, ...page.items.filter((item) => !known.has(item.id))]
      })
      setSelectedConversationRecordCount(page.totalRecords)
      setSelectedConversationCursor(page.nextCursor)
    } catch (error) {
      if (request === selectedRequestRef.current) {
        setSelectedConversationError(error instanceof Error ? error.message : '无法读取此对话。')
      }
    } finally {
      if (request === selectedRequestRef.current) setSelectedConversationLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    const resetTimer = window.setTimeout(() => {
      if (!active) return
      setSelectedConversationRecords([])
      setSelectedConversationRecordCount(0)
      setSelectedConversationCursor(null)
      setSelectedConversationError('')
    }, 0)
    if (!selectedConversationId) {
      selectedRequestRef.current += 1
      return () => { active = false; window.clearTimeout(resetTimer) }
    }
    const conversationId = selectedConversationId
    const loadTimer = window.setTimeout(() => {
      if (active) void readSelectedConversationPage(conversationId)
    }, 0)
    return () => {
      active = false
      window.clearTimeout(resetTimer)
      window.clearTimeout(loadTimer)
    }
  }, [readSelectedConversationPage, selectedConversationId])

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

  const loadOlderMessages = () => {
    if (!selectedConversationId || !selectedConversationCursor || selectedConversationLoading) return
    void readSelectedConversationPage(selectedConversationId, selectedConversationCursor, true)
  }

  return (
    <section className={`intel-list-section conversation-section intel-collapsible-section ${open ? 'is-open' : 'is-collapsed'}`}>
      <div className="list-heading"><div><span className="section-kicker">LOCAL CONVERSATIONS · 原始对话目录</span><h2><button type="button" className="intel-section-toggle" aria-expanded={open} onClick={onToggleOpen}>对话档案<ChevronDown size={17} /></button></h2></div><div className="list-heading-actions"><label className="conversation-search"><Search size={15} /><input type="search" value={conversationSearch} onChange={(event) => { setConversationSearch(event.target.value); if (event.target.value.trim()) onOpen() }} placeholder="搜索会话名称" aria-label="搜索会话名称" />{conversationSearch && <button type="button" aria-label="清除会话搜索" title="清除会话搜索" onClick={() => setConversationSearch('')}><X size={14} /></button>}</label><span>{visibleConversations.length}/{matchingConversations.length} 个对话{matchingConversations.length !== conversations.length ? ` · 全部 ${conversations.length}` : ''}</span></div></div>
      {open && <>
        <div className="bulk-note">这里是去重后的原始消息档案，不是模型候选。每个文件夹或导出会话被归为一个对话；按最后聊天时间倒序和月份分组。选择时间范围后，显示范围与模型提炼范围一致。</div>
        <div className="conversation-timeline">
          {conversationsByPeriod.map(([period, entries]) => <section className="conversation-period" key={period}>
            <div className="conversation-period-heading"><span>{period === '未记录时间' ? period : `${formatTimelinePeriod(period)} · 最后聊天`}</span><small>{entries.length} 个对话</small></div>
            {entries.map((conversation) => {
              const latest = conversation.latestPreview
              const kind = conversation.kind === 'group' ? '群聊' : conversation.kind === 'direct' ? '私聊' : '对话'
              return <article className={`conversation-row ${selectedConversation?.id === conversation.id ? 'is-selected' : ''} ${analysisConversationId === conversation.id ? 'is-analysis-target' : ''}`} key={conversation.id}>
                <div className="conversation-row-icon"><MessagesSquare size={17} /></div>
                <div className="conversation-row-copy"><div><span>{conversation.source}</span><span>{kind}</span><time><Clock3 size={12} />最后聊天：{formatChatTime(conversation.lastAt)}</time></div><h3>{conversation.name}</h3><p>{latest?.content || latest?.summary || '没有可显示的消息内容。'}</p><small>{formatCount(conversation.recordCount)} 条消息{conversation.firstAt ? ` · 最早 ${formatChatTime(conversation.firstAt)}` : ' · 消息时间未记录'}</small></div>
                <div className="conversation-row-actions"><button type="button" className="conversation-analyze" onClick={() => onAnalyze(conversation.id)} aria-label={`单独提炼 ${conversation.name}`}><Sparkles size={14} />单独提炼</button><button type="button" className="conversation-open" onClick={() => openConversation(conversation.id)} aria-label={`查看 ${conversation.name} 的对话`}><span>查看对话</span><ChevronRight size={16} /></button></div>
              </article>
            })}
          </section>)}
          {!visibleConversations.length && <p className="empty-note">{conversationSearch.trim() ? '没有名称匹配的对话。' : '当前时间范围内没有最后聊天时间可匹配的对话。'}</p>}
        </div>
        {visibleConversations.length < matchingConversations.length && <button type="button" className="secondary-button conversation-load-more" onClick={() => setConversationRenderLimit((current) => current + CONVERSATION_RENDER_BATCH_SIZE)}>继续显示更多会话（已显示 {formatCount(visibleConversations.length)}/{formatCount(matchingConversations.length)} 个）</button>}
        {selectedConversation && <section className="conversation-detail" aria-label={`${selectedConversation.name} 的对话内容`}>
          <div className="conversation-detail-heading"><div><span className="section-kicker">DIALOGUE · 按消息时间排序</span><h3>{selectedConversation.name}</h3><p>{selectedConversation.source} · {selectedConversation.kind === 'group' ? '群聊' : selectedConversation.kind === 'direct' ? '私聊' : '对话'} · {formatCount(selectedConversationRecordCount || selectedConversation.recordCount)} 条消息 · 最后聊天 {formatChatTime(selectedConversation.lastAt)}</p></div><button type="button" className="icon-button" title="关闭对话内容" aria-label="关闭对话内容" onClick={() => setSelectedConversationId(undefined)}><X size={16} /></button></div>
          <div ref={messageListRef} className="conversation-message-list" onScroll={(event) => handleMessageScroll(event.currentTarget.scrollTop)}><div className="conversation-message-spacer" style={{ height: `${selectedConversationRecords.length * MESSAGE_ROW_HEIGHT}px` }}><div className="conversation-message-window" style={{ transform: `translateY(${firstMessage * MESSAGE_ROW_HEIGHT}px)` }}>{renderedMessages.map((item) => <article className="conversation-message" style={{ height: `${MESSAGE_ROW_HEIGHT}px` }} key={item.id}><div><span>{item.speakerRole === 'self' ? '本人发言' : item.speakerRole === 'other' ? '对方发言' : '发言方向未确认'}</span>{item.speaker && <strong>{item.speaker}</strong>}{item.messageType && <em>类型：{item.messageType}</em>}<time>{formatChatTime(item.capturedAt)}</time></div><p title={item.content || item.summary}>{item.content || item.summary}</p></article>)}</div></div></div>
          {selectedConversationLoading && <p className="conversation-page-status">正在读取这一段对话...</p>}
          {selectedConversationError && <p className="conversation-page-status is-error">{selectedConversationError}</p>}
          {!selectedConversationLoading && selectedConversationCursor && <button type="button" className="secondary-button conversation-load-more" onClick={loadOlderMessages}>继续读取后续消息（已载入 {formatCount(selectedConversationRecords.length)}/{formatCount(selectedConversationRecordCount)} 条）</button>}
        </section>}
      </>}
    </section>
  )
}

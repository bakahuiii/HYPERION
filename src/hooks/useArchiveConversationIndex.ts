import { useCallback, useEffect, useRef, useState } from 'react'

import {
  loadSharedIntelConversationIndex,
  type ArchiveConversationSummary,
} from '../lib/intelStore'

const INDEX_PAGE_SIZE = 250

export interface ArchiveConversationIndexState {
  conversations: ArchiveConversationSummary[]
  totalConversations: number
  loading: boolean
  error: string
  updatedAt: string | null
  refresh: () => void
}

/**
 * Hydrates only the compact conversation directory. The raw message archive
 * is intentionally not read here; ConversationBrowser requests one selected
 * conversation in small chronological pages instead.
 */
export function useArchiveConversationIndex(enabled: boolean, refreshKey: string): ArchiveConversationIndexState {
  const [generation, setGeneration] = useState(0)
  const [conversations, setConversations] = useState<ArchiveConversationSummary[]>([])
  const [totalConversations, setTotalConversations] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const requestRef = useRef(0)

  const refresh = useCallback(() => setGeneration((current) => current + 1), [])

  useEffect(() => {
    if (!enabled) return
    const request = requestRef.current + 1
    requestRef.current = request
    let cancelled = false
    const loadingTimer = window.setTimeout(() => {
      if (!cancelled && request === requestRef.current) {
        setLoading(true)
        setError('')
      }
    }, 0)
    void (async () => {
      const collected: ArchiveConversationSummary[] = []
      let cursor: string | undefined
      let finalTotal: number | undefined
      let finalTimestamp: string | null | undefined
      do {
        const page = await loadSharedIntelConversationIndex({ cursor, limit: INDEX_PAGE_SIZE })
        if (cancelled || request !== requestRef.current) return
        collected.push(...page.items)
        finalTotal = page.totalConversations
        finalTimestamp = page.updatedAt
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      if (cancelled || request !== requestRef.current) return
      setConversations(collected)
      setTotalConversations(finalTotal ?? collected.length)
      setUpdatedAt(finalTimestamp ?? null)
    })().catch((cause: unknown) => {
      if (cancelled || request !== requestRef.current) return
      setConversations([])
      setTotalConversations(0)
      setError(cause instanceof Error ? cause.message : '无法读取本地对话目录。')
    }).finally(() => {
      window.clearTimeout(loadingTimer)
      if (!cancelled && request === requestRef.current) setLoading(false)
    })
    return () => { cancelled = true; window.clearTimeout(loadingTimer) }
  }, [enabled, generation, refreshKey])

  return { conversations, totalConversations, loading, error, updatedAt, refresh }
}

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { AiExtractionCheckpoint, AppData } from '../types'
import { loadSharedMeta, loadSharedSnapshot, saveSharedSnapshot, SharedSnapshotConflictError } from '../lib/sharedSync'
import { mergeSharedChanges, toSharedData, type SharedData } from '../lib/sharedStateMerge'

interface SyncErrors {
  shared?: string
  settings?: string
}

interface PreparedSharedSnapshot {
  data: AppData
  skipEchoWrite: boolean
}

interface UseSharedSyncOptions {
  data: AppData
  dataRef: MutableRefObject<AppData>
  setData: Dispatch<SetStateAction<AppData>>
  intelHydrated: boolean
  setSyncErrors: Dispatch<SetStateAction<SyncErrors>>
  flushSettings: (interruptedRun?: AiExtractionCheckpoint) => Promise<void>
  pendingCheckpointRef: MutableRefObject<AiExtractionCheckpoint | undefined>
  checkpointWriteTimerRef: MutableRefObject<number | undefined>
  prepareIncoming: (current: AppData, base: SharedData, remote: SharedData) => PreparedSharedSnapshot
  reconcileConflict: (current: AppData, reconciled: SharedData) => AppData
  pollIntervalMs?: number
}

export function useSharedSync({
  data,
  dataRef,
  setData,
  intelHydrated,
  setSyncErrors,
  flushSettings,
  pendingCheckpointRef,
  checkpointWriteTimerRef,
  prepareIncoming,
  reconcileConflict,
  pollIntervalMs = 15_000,
}: UseSharedSyncOptions) {
  const [ready, setReady] = useState(false)
  const readyRef = useRef(false)
  const updatedAtRef = useRef('')
  const baseDataRef = useRef<SharedData>(toSharedData(data))
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const skipWriteRef = useRef(false)
  const writeTimerRef = useRef<number | undefined>(undefined)
  const flushInFlightRef = useRef<Promise<void> | null>(null)

  const persistSnapshot = useCallback((snapshot: AppData) => {
    const localAtEnqueue = toSharedData(snapshot)
    const operation = saveQueueRef.current.then(async () => {
      let outgoing = localAtEnqueue
      let mergeBase = baseDataRef.current
      let mergedConflict = false

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const saved = await saveSharedSnapshot(outgoing, updatedAtRef.current || null)
          updatedAtRef.current = saved.updatedAt ?? ''
          baseDataRef.current = outgoing
          if (mergedConflict) {
            setData((current) => {
              const reconciled = mergeSharedChanges(localAtEnqueue, toSharedData(current), outgoing)
              return reconcileConflict(current, reconciled)
            })
          }
          return saved
        } catch (error) {
          if (!(error instanceof SharedSnapshotConflictError)) throw error
          const remote = await loadSharedSnapshot()
          updatedAtRef.current = remote.updatedAt ?? ''
          if (!remote.data) continue
          outgoing = mergeSharedChanges(mergeBase, outgoing, remote.data)
          mergeBase = remote.data
          mergedConflict = true
        }
      }
      throw new Error('共享数据连续发生写入冲突，请稍后重试')
    })

    const visibleOperation = operation.then((saved) => {
      setSyncErrors((current) => current.shared ? { ...current, shared: undefined } : current)
      return saved
    }, (error) => {
      setSyncErrors((current) => ({ ...current, shared: `任务、人物与地点的共享状态保存失败：${error instanceof Error ? error.message : String(error)}` }))
      throw error
    })
    saveQueueRef.current = visibleOperation.then(() => undefined, () => undefined)
    return visibleOperation
  }, [reconcileConflict, setData, setSyncErrors])

  const applyRemoteSnapshot = useCallback((snapshotData: SharedData, updatedAt: string) => {
    const previousBase = baseDataRef.current
    updatedAtRef.current = updatedAt
    baseDataRef.current = snapshotData
    setData((current) => {
      const prepared = prepareIncoming(current, previousBase, snapshotData)
      skipWriteRef.current = prepared.skipEchoWrite
      return prepared.data
    })
  }, [prepareIncoming, setData])

  useEffect(() => {
    if (!intelHydrated) return
    let active = true
    void loadSharedSnapshot().then((snapshot) => {
      if (!active) return
      if (snapshot.data && snapshot.updatedAt) applyRemoteSnapshot(snapshot.data, snapshot.updatedAt)
      else void persistSnapshot(dataRef.current).catch(() => undefined)
    }).catch((error) => {
      if (active) setSyncErrors((current) => ({ ...current, shared: `共享状态读取失败：${error instanceof Error ? error.message : String(error)}` }))
    }).finally(() => {
      if (!active) return
      readyRef.current = true
      setReady(true)
    })
    return () => { active = false }
  }, [applyRemoteSnapshot, dataRef, intelHydrated, persistSnapshot, setSyncErrors])

  useEffect(() => {
    if (!intelHydrated || !ready) return
    if (skipWriteRef.current) {
      skipWriteRef.current = false
      return
    }
    if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
    const snapshot = data
    writeTimerRef.current = window.setTimeout(() => {
      writeTimerRef.current = undefined
      void persistSnapshot(snapshot).catch(() => undefined)
    }, 250)
    return () => {
      if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
    }
  }, [data, intelHydrated, persistSnapshot, ready])

  useEffect(() => {
    const flush = async () => {
      if (flushInFlightRef.current) return flushInFlightRef.current
      const operation = (async () => {
        if (writeTimerRef.current) {
          window.clearTimeout(writeTimerRef.current)
          writeTimerRef.current = undefined
        }
        if (checkpointWriteTimerRef.current) {
          window.clearTimeout(checkpointWriteTimerRef.current)
          checkpointWriteTimerRef.current = undefined
        }

        const writes: Promise<unknown>[] = []
        if (readyRef.current) writes.push(persistSnapshot(dataRef.current))
        writes.push(flushSettings(pendingCheckpointRef.current))
        await Promise.allSettled(writes)
        await saveQueueRef.current
      })()
      flushInFlightRef.current = operation
      try {
        await operation
      } finally {
        if (flushInFlightRef.current === operation) flushInFlightRef.current = null
      }
    }

    window.theiaFlush = flush
    const handlePageHide = () => { void flush() }
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      void flush()
      delete window.theiaFlush
    }
  }, [checkpointWriteTimerRef, dataRef, flushSettings, pendingCheckpointRef, persistSnapshot])

  useEffect(() => {
    if (!intelHydrated) return
    const timer = window.setInterval(() => {
      void loadSharedMeta().then((meta) => {
        if (!meta.updatedAt || meta.updatedAt <= updatedAtRef.current) return
        return loadSharedSnapshot().then((snapshot) => {
          if (!snapshot.data || !snapshot.updatedAt || snapshot.updatedAt <= updatedAtRef.current) return
          applyRemoteSnapshot(snapshot.data, snapshot.updatedAt)
        })
      }).catch((error) => setSyncErrors((current) => ({ ...current, shared: `共享状态刷新失败：${error instanceof Error ? error.message : String(error)}` })))
    }, pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [applyRemoteSnapshot, intelHydrated, pollIntervalMs, setSyncErrors])

  return { ready, persistSnapshot }
}

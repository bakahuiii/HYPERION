import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { AiExtractionCheckpoint, AppData } from '../types'
import { loadSharedSettings, saveSharedSettings, waitForSharedSettingsWrites } from '../lib/settingsClient'
import { editableSettingsSignature } from '../lib/settingsState'

interface SyncErrors {
  shared?: string
  settings?: string
}
interface UseSettingsSyncOptions {
  data: AppData
  dataRef: MutableRefObject<AppData>
  setData: Dispatch<SetStateAction<AppData>>
  setSyncErrors: Dispatch<SetStateAction<SyncErrors>>
}

export function useSettingsSync({ data, dataRef, setData, setSyncErrors }: UseSettingsSyncOptions) {
  const [ready, setReady] = useState(false)
  const readyRef = useRef(false)
  const writeTimerRef = useRef<number | undefined>(undefined)
  const signature = useMemo(() => editableSettingsSignature({
    profile: data.profile,
    appearance: data.appearance,
    aiSettings: data.aiSettings,
  }), [data.aiSettings, data.appearance, data.profile])

  useEffect(() => {
    let active = true
    const initialSignature = editableSettingsSignature({
      profile: dataRef.current.profile,
      appearance: dataRef.current.appearance,
      aiSettings: dataRef.current.aiSettings,
    })
    void loadSharedSettings().then((settings) => {
      if (!active) return
      const currentSignature = editableSettingsSignature({
        profile: dataRef.current.profile,
        appearance: dataRef.current.appearance,
        aiSettings: dataRef.current.aiSettings,
      })
      if (settings.initialized && currentSignature === initialSignature) {
        setData((current) => ({
          ...current,
          profile: settings.profile,
          appearance: settings.appearance,
          aiSettings: settings.aiSettings,
        }))
      }
      setSyncErrors((current) => current.settings ? { ...current, settings: undefined } : current)
    }).catch((error) => {
      if (active) setSyncErrors((current) => ({ ...current, settings: `通用设置读取失败：${error instanceof Error ? error.message : String(error)}` }))
    }).finally(() => {
      if (!active) return
      readyRef.current = true
      setReady(true)
    })
    return () => { active = false }
  }, [dataRef, setData, setSyncErrors])

  useEffect(() => {
    if (!ready) return
    if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
    writeTimerRef.current = window.setTimeout(() => {
      const current = dataRef.current
      void saveSharedSettings({ profile: current.profile, appearance: current.appearance, aiSettings: current.aiSettings })
        .then(() => setSyncErrors((errors) => errors.settings ? { ...errors, settings: undefined } : errors))
        .catch((error) => setSyncErrors((errors) => ({ ...errors, settings: `通用设置保存失败：${error instanceof Error ? error.message : String(error)}` })))
    }, 350)
    return () => { if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current) }
  }, [dataRef, ready, setSyncErrors, signature])

  const flushSettings = useCallback(async (interruptedRun?: AiExtractionCheckpoint) => {
    if (writeTimerRef.current) {
      window.clearTimeout(writeTimerRef.current)
      writeTimerRef.current = undefined
    }
    if (!readyRef.current) return
    const current = dataRef.current
    await saveSharedSettings({
      profile: current.profile,
      appearance: current.appearance,
      aiSettings: { ...current.aiSettings, interruptedRun },
    })
    await waitForSharedSettingsWrites()
  }, [dataRef])

  return { ready, flushSettings }
}

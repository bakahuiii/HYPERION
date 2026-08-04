import type { SharedSettingsInput } from './settingsClient'

export function editableSettingsSignature(settings: SharedSettingsInput) {
  return JSON.stringify({
    profile: settings.profile,
    appearance: settings.appearance,
    aiSettings: { ...settings.aiSettings, interruptedRun: undefined },
  })
}

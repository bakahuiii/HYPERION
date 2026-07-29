import type { AppearanceSettings } from '../types'

export const defaultAppearance: AppearanceSettings = {
  theme: 'verdant',
  motionEnabled: false,
  performanceVersion: 1,
  backgrounds: {
    app: { scale: 100, blur: 0 },
  },
  dynamicBackground: { preset: 'none', intensity: 35, speed: 40 },
}

export function normalizeAppearance(value?: Partial<AppearanceSettings>): AppearanceSettings {
  const theme = value?.theme === 'nocturne' || value?.theme === 'paper' || value?.theme === 'sakura' ? value.theme : 'verdant'
  return {
    theme,
    // Earlier versions enabled several compositing-heavy effects by default.
    // Treat missing performanceVersion as an old setting and migrate to lite mode.
    motionEnabled: value?.performanceVersion === 1 && value.motionEnabled === true,
    performanceVersion: 1,
    backgrounds: {
      app: (() => {
        const stored = value?.backgrounds?.app
        return {
          imageId: typeof stored?.imageId === 'string' ? stored.imageId : undefined,
          url: typeof stored?.url === 'string' ? stored.url.trim().slice(0, 2000) : undefined,
          scale: Math.max(60, Math.min(180, Number(stored?.scale) || defaultAppearance.backgrounds.app.scale)),
          blur: Math.max(0, Math.min(24, Number(stored?.blur) || defaultAppearance.backgrounds.app.blur)),
        }
      })(),
    },
    dynamicBackground: {
      preset: ['ribbons', 'rain', 'scanlines', 'constellation'].includes(value?.dynamicBackground?.preset ?? '')
        ? value!.dynamicBackground!.preset
        : 'none',
      intensity: Math.max(0, Math.min(100, Number(value?.dynamicBackground?.intensity) || defaultAppearance.dynamicBackground.intensity)),
      speed: Math.max(10, Math.min(100, Number(value?.dynamicBackground?.speed) || defaultAppearance.dynamicBackground.speed)),
    },
  }
}

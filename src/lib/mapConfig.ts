import { localProxyUrl } from './apiUrl'

export const MAP_CONFIG_CHANGED_EVENT = 'hyperion:map-config-changed'

export interface MapServiceOption {
  id: string
  name: string
  detail?: string
  policyUrl: string
}

export interface MapConfig {
  tileProvider: 'osm-de' | 'osm-standard' | 'osm-hot'
  searchProvider: 'balanced' | 'nominatim' | 'photon'
  cacheMaxMb: number
  tileProviders: MapServiceOption[]
  searchProviders: MapServiceOption[]
  attribution: string
  usageNotice: string
}

const fallbackConfig: MapConfig = {
  tileProvider: 'osm-de',
  searchProvider: 'balanced',
  cacheMaxMb: 128,
  tileProviders: [
    { id: 'osm-de', name: 'OpenStreetMap DE', policyUrl: 'https://www.openstreetmap.de/germanstyle.html' },
    { id: 'osm-standard', name: 'OpenStreetMap Standard', policyUrl: 'https://operations.osmfoundation.org/policies/tiles/' },
    { id: 'osm-hot', name: 'Humanitarian OpenStreetMap', policyUrl: 'https://www.hotosm.org/terms/' },
  ],
  searchProviders: [
    { id: 'balanced', name: '自动选择', policyUrl: 'https://operations.osmfoundation.org/policies/nominatim/' },
    { id: 'nominatim', name: 'Nominatim', policyUrl: 'https://operations.osmfoundation.org/policies/nominatim/' },
    { id: 'photon', name: 'Photon', policyUrl: 'https://photon.komoot.io/' },
  ],
  attribution: '© OpenStreetMap contributors',
  usageNotice: '仅用于交互式个人地图；禁止批量预取或离线抓取。',
}

let cached: MapConfig | null = null
let pending: Promise<MapConfig> | null = null

export function normalizeMapConfig(payload: Partial<MapConfig>): MapConfig {
  return {
    ...fallbackConfig,
    ...payload,
    cacheMaxMb: Math.round(Math.max(32, Math.min(1024, Number(payload.cacheMaxMb) || fallbackConfig.cacheMaxMb))),
    tileProviders: Array.isArray(payload.tileProviders) && payload.tileProviders.length ? payload.tileProviders : fallbackConfig.tileProviders,
    searchProviders: Array.isArray(payload.searchProviders) && payload.searchProviders.length ? payload.searchProviders : fallbackConfig.searchProviders,
  }
}

export function loadMapConfig(force = false): Promise<MapConfig> {
  if (!force && cached) return Promise.resolve(cached)
  if (!force && pending) return pending
  pending = fetch(localProxyUrl('/api/map/config'), { headers: { accept: 'application/json' } })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({})) as Partial<MapConfig> & { error?: string }
      if (!response.ok) throw new Error(payload.error || `地图服务设置读取失败 (${response.status})`)
      cached = normalizeMapConfig(payload)
      return cached
    })
    .catch(() => cached ?? fallbackConfig)
    .finally(() => { pending = null })
  return pending
}

export async function saveMapConfig(input: Pick<MapConfig, 'tileProvider' | 'searchProvider' | 'cacheMaxMb'>) {
  const response = await fetch(localProxyUrl('/api/map/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => ({})) as Partial<MapConfig> & { error?: string }
  if (!response.ok) throw new Error(payload.error || `地图服务设置保存失败 (${response.status})`)
  cached = normalizeMapConfig({ ...(cached ?? fallbackConfig), ...payload })
  window.dispatchEvent(new CustomEvent(MAP_CONFIG_CHANGED_EVENT, { detail: cached }))
  return cached
}

export function currentMapConfig() {
  return cached ?? fallbackConfig
}

export interface MapSearchResult {
  display_name: string
  lat: string
  lon: string
  bounds?: [number, number, number, number]
  kind?: string
}

function validBounds(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value)
    && value.length === 4
    && value.every((item) => Number.isFinite(Number(item)))
}

export async function searchMapPlaces(query: string) {
  const endpoint = new URL('/api/map/search', window.location.origin)
  endpoint.searchParams.set('q', query.trim())
  const response = await fetch(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  const payload = await response.json().catch(() => null) as MapSearchResult[] | { error?: string } | null
  if (!response.ok) {
    const detail = payload && !Array.isArray(payload) && typeof payload.error === 'string' ? payload.error : `搜索服务返回 ${response.status}`
    throw new Error(detail)
  }
  if (!Array.isArray(payload)) return []
  return payload.flatMap((item): MapSearchResult[] => {
    if (!item.display_name || !Number.isFinite(Number(item.lat)) || !Number.isFinite(Number(item.lon))) return []
    return [{
      display_name: item.display_name,
      lat: String(item.lat),
      lon: String(item.lon),
      bounds: validBounds(item.bounds) ? item.bounds.map(Number) as [number, number, number, number] : undefined,
      kind: typeof item.kind === 'string' ? item.kind : undefined,
    }]
  })
}

export function mapSearchRadius(result: MapSearchResult) {
  if (!result.bounds) return undefined
  const [south, west, north, east] = result.bounds
  const latitude = Number(result.lat)
  const latitudeSpan = Math.abs(north - south) * 111_320
  const longitudeSpan = Math.abs(east - west) * 111_320 * Math.max(.2, Math.cos(latitude * Math.PI / 180))
  const radius = Math.max(latitudeSpan, longitudeSpan) / 2
  return Number.isFinite(radius) && radius > 0 ? Math.round(Math.min(100_000, Math.max(120, radius))) : undefined
}

export function mapSearchPrecision(result: MapSearchResult) {
  const radius = mapSearchRadius(result)
  if (radius && radius >= 320) return 'approximate' as const
  if (/(?:city|town|village|county|district|state|province|region|locality|administrative)/i.test(result.kind ?? '')) return 'approximate' as const
  return 'exact' as const
}

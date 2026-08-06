import type { ContextEvent, ContextEventKind, ContextEventSource } from '../types'

/** The only device-timeline interchange contract accepted by THEIA. */
export const SELENE_EVENTS_SCHEMA = 'selene-context-events/v1'

export interface SeleneEventDocument {
  schema: typeof SELENE_EVENTS_SCHEMA
  device?: {
    platform?: 'android' | 'windows'
    id?: string
    label?: string
  }
  generatedAt: string
  producer: {
    name: 'SELENE'
    version: string
    layout: 'immutable-snapshot-v1'
  }
  events: ContextEvent[]
}

export interface ModelContextEvent {
  id: string
  kind: ContextEventKind
  source: ContextEventSource
  startAt: string
  endAt?: string
  title: string
  summary?: string
  values?: Record<string, string | number | boolean>
  privacy: 'coarse'
}

const kinds = new Set<ContextEventKind>([
  'calendar', 'location', 'movement', 'screen-time', 'activity', 'health', 'payment', 'device', 'custom',
])
const sources = new Set<ContextEventSource>(['selene'])
const valueKey = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const locationKey = /(?:^|[_.-])(?:lat(?:itude)?|lng|lon(?:gitude)?|coord(?:inate)?s?|address|geohash)(?:$|[_.-])/i

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, maximum) : ''
}

function iso(value: unknown) {
  const text = cleanText(value, 64)
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : ''
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function values(value: unknown) {
  const input = object(value)
  if (!input) return undefined
  const output: Record<string, string | number | boolean> = {}
  for (const [key, candidate] of Object.entries(input)) {
    if (!valueKey.test(key)) continue
    if (typeof candidate === 'boolean' || (typeof candidate === 'number' && Number.isFinite(candidate))) {
      output[key] = candidate
    } else if (typeof candidate === 'string') {
      const text = cleanText(candidate, 800)
      if (text) output[key] = text
    }
    if (Object.keys(output).length >= 48) break
  }
  return Object.keys(output).length ? output : undefined
}

function normalizedLocation(value: unknown) {
  const input = object(value)
  if (!input) return undefined
  const latitude = Number(input.latitude)
  const longitude = Number(input.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined
  const accuracy = Number(input.accuracyMeters)
  return {
    latitude,
    longitude,
    ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracyMeters: Math.min(1_000_000, accuracy) } : {}),
  }
}

function normalizedLocationConsent(value: unknown): ContextEvent['locationConsent'] | undefined {
  const input = object(value)
  const grantedAt = iso(input?.grantedAt)
  const captureMode = input?.captureMode
  if (input?.exactLocation !== true || !grantedAt || (captureMode !== 'manual' && captureMode !== 'foreground' && captureMode !== 'background')) return undefined
  return { exactLocation: true, captureMode: captureMode as 'manual' | 'foreground' | 'background', grantedAt }
}

/**
 * Normalizes only the documented interchange contract. Exact coordinate data
 * is retained only when the exporting Android client records explicit consent.
 */
export function normalizeContextEvent(value: unknown, options: { sourceFile?: string; importedAt?: string } = {}): ContextEvent | null {
  const input = object(value)
  if (!input) return null
  const kind = kinds.has(input.kind as ContextEventKind) ? input.kind as ContextEventKind : 'custom'
  if (!sources.has(input.source as ContextEventSource)) return null
  const source = input.source as ContextEventSource
  const startAt = iso(input.startAt)
  if (!startAt) return null
  const possibleEndAt = iso(input.endAt)
  const endAt = possibleEndAt && Date.parse(possibleEndAt) >= Date.parse(startAt) ? possibleEndAt : undefined
  const title = cleanText(input.title, 240) || (kind === 'location' ? 'Location capture' : 'Context event')
  const capturedAt = iso(input.capturedAt) || startAt
  const importedAt = iso(input.importedAt) || options.importedAt || new Date().toISOString()
  const sourceFile = cleanText(options.sourceFile ?? input.sourceFile, 600)
  const locationConsent = normalizedLocationConsent(input.locationConsent)
  const location = kind === 'location' && input.privacy === 'precise' && locationConsent
    ? normalizedLocation(input.location)
    : undefined
  const privacy = location ? 'precise' as const : 'coarse' as const
  const id = cleanText(input.id, 160) || `context-${hash([source, kind, startAt, endAt ?? '', title, sourceFile].join('\u0000'))}`
  return {
    id,
    version: 1,
    kind,
    source,
    startAt,
    ...(endAt ? { endAt } : {}),
    title,
    ...(cleanText(input.summary, 2_400) ? { summary: cleanText(input.summary, 2_400) } : {}),
    ...(values(input.values) ? { values: values(input.values) } : {}),
    ...(sourceFile ? { sourceFile } : {}),
    capturedAt,
    importedAt,
    privacy,
    ...(location ? { location, locationConsent: locationConsent! } : {}),
  }
}

export function normalizeContextEvents(value: unknown, options: { sourceFile?: string; importedAt?: string } = {}) {
  const byId = new Map<string, ContextEvent>()
  for (const candidate of Array.isArray(value) ? value : []) {
    const event = normalizeContextEvent(candidate, options)
    if (!event) continue
    const previous = byId.get(event.id)
    if (!previous || previous.importedAt.localeCompare(event.importedAt) <= 0) byId.set(event.id, event)
  }
  return [...byId.values()].sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id))
}

function hasSeleneEnvelope(input: Record<string, unknown> | null) {
  const producer = object(input?.producer)
  return Boolean(
    input
    && input.schema === SELENE_EVENTS_SCHEMA
    && Array.isArray(input.events)
    && producer?.name === 'SELENE'
    && producer?.layout === 'immutable-snapshot-v1'
    && cleanText(producer?.version, 64),
  )
}

export function parseContextEventDocument(value: unknown, options: { sourceFile?: string; importedAt?: string } = {}) {
  const input = object(value)
  if (!input || !hasSeleneEnvelope(input)) return null
  return normalizeContextEvents(input.events, {
    sourceFile: options.sourceFile,
    importedAt: options.importedAt ?? iso(input.generatedAt) ?? new Date().toISOString(),
  })
}

export function isContextEventDocument(value: unknown) {
  return hasSeleneEnvelope(object(value))
}

/**
 * Models receive temporal background only. Exact coordinates, address-like
 * fields, and the explicit-consent token never leave the client.
 */
export function projectContextEventsForModel(events: ContextEvent[]): ModelContextEvent[] {
  return events.map((event) => {
    if (event.kind === 'location') {
      const placeTag = typeof event.values?.placeTag === 'string' ? cleanText(event.values.placeTag, 120) : ''
      return {
        id: event.id,
        kind: event.kind,
        source: event.source,
        startAt: event.startAt,
        ...(event.endAt ? { endAt: event.endAt } : {}),
        title: 'Location capture',
        ...(placeTag ? { values: { placeTag } } : {}),
        privacy: 'coarse',
      }
    }
    const safeValues = event.values
      ? Object.fromEntries(Object.entries(event.values).filter(([key]) => !locationKey.test(key)))
      : undefined
    return {
      id: event.id,
      kind: event.kind,
      source: event.source,
      startAt: event.startAt,
      ...(event.endAt ? { endAt: event.endAt } : {}),
      title: event.title,
      ...(event.summary ? { summary: event.summary } : {}),
      ...(safeValues && Object.keys(safeValues).length ? { values: safeValues } : {}),
      privacy: 'coarse',
    }
  })
}

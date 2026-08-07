import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { writeFileAtomically } from './atomicFile.mjs'

export const SELENE_EVENTS_SCHEMA = 'selene-context-events/v1'

const supportedKinds = new Set([
  'calendar', 'location', 'movement', 'screen-time', 'activity', 'health', 'payment', 'device', 'custom',
])
const valueKey = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const snapshotDirectory = /^SELENE-v1-/

function cleanText(value, maximum) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, maximum) : ''
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function iso(value) {
  const text = cleanText(value, 64)
  if (!text || !Number.isFinite(Date.parse(text))) return ''
  return new Date(text).toISOString()
}

function scalarValues(value) {
  const input = record(value)
  if (!input) return undefined
  const output = {}
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

function normalizedLocation(value) {
  const input = record(value)
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

function normalizedLocationConsent(value) {
  const input = record(value)
  const grantedAt = iso(input?.grantedAt)
  const captureMode = input?.captureMode
  if (input?.exactLocation !== true || !grantedAt || !['manual', 'foreground', 'background'].includes(captureMode)) return undefined
  return { exactLocation: true, captureMode, grantedAt }
}

function fallbackId(source, kind, startAt, endAt, title, sourceFile) {
  const input = [source, kind, startAt, endAt ?? '', title, sourceFile].join('\u0000')
  return `context-${createHash('sha256').update(input).digest('hex').slice(0, 20)}`
}

export function normalizeSeleneEvent(value, options = {}) {
  const input = record(value)
  if (!input || input.source !== 'selene') return null
  const kind = supportedKinds.has(input.kind) ? input.kind : 'custom'
  const startAt = iso(input.startAt)
  if (!startAt) return null
  const possibleEndAt = iso(input.endAt)
  const endAt = possibleEndAt && Date.parse(possibleEndAt) >= Date.parse(startAt) ? possibleEndAt : undefined
  const title = cleanText(input.title, 240) || (kind === 'location' ? 'Location capture' : 'Context event')
  const capturedAt = iso(input.capturedAt) || startAt
  const importedAt = iso(options.importedAt) || new Date().toISOString()
  const sourceFile = cleanText(options.sourceFile, 600)
  const locationConsent = normalizedLocationConsent(input.locationConsent)
  const location = kind === 'location' && input.privacy === 'precise' && locationConsent
    ? normalizedLocation(input.location)
    : undefined
  const privacy = location ? 'precise' : 'coarse'
  const id = cleanText(input.id, 160) || fallbackId('selene', kind, startAt, endAt, title, sourceFile)
  return {
    id,
    version: 1,
    kind,
    source: 'selene',
    startAt,
    ...(endAt ? { endAt } : {}),
    title,
    ...(cleanText(input.summary, 2_400) ? { summary: cleanText(input.summary, 2_400) } : {}),
    ...(scalarValues(input.values) ? { values: scalarValues(input.values) } : {}),
    ...(sourceFile ? { sourceFile } : {}),
    capturedAt,
    importedAt,
    privacy,
    ...(location ? { location, locationConsent } : {}),
  }
}

export function normalizeSeleneDocument(value, options = {}) {
  const input = record(value)
  const producer = record(input?.producer)
  const platform = input?.device?.platform
  if (
    !input
    || input.schema !== SELENE_EVENTS_SCHEMA
    || !Array.isArray(input.events)
    || producer?.name !== 'SELENE'
    || producer?.layout !== 'immutable-snapshot-v1'
    || !cleanText(producer?.version, 64)
    || !['android', 'windows'].includes(platform)
  ) return null

  const sourceFile = cleanText(options.sourceFile, 600)
  const importedAt = options.importedAt || new Date().toISOString()
  const byId = new Map()
  for (const candidate of input.events) {
    const event = normalizeSeleneEvent(candidate, { sourceFile, importedAt })
    if (!event) continue
    const previous = byId.get(event.id)
    if (!previous || previous.importedAt.localeCompare(event.importedAt) <= 0) byId.set(event.id, event)
  }
  return {
    platform,
    generatedAt: iso(input.generatedAt),
    events: [...byId.values()].sort((left, right) => left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id)),
  }
}

export function mergeContextEvents(existing, incoming) {
  const retained = Array.isArray(existing) ? existing.filter((item) => item && typeof item === 'object' && typeof item.id === 'string') : []
  const output = new Map(retained.map((item) => [item.id, item]))
  let added = 0
  let updated = 0
  let duplicates = 0
  for (const event of incoming) {
    const previous = output.get(event.id)
    if (!previous) {
      output.set(event.id, event)
      added += 1
    } else if (JSON.stringify(previous) === JSON.stringify(event)) {
      duplicates += 1
    } else {
      output.set(event.id, event)
      updated += 1
    }
  }
  return {
    events: [...output.values()].sort((left, right) => String(left.startAt).localeCompare(String(right.startAt)) || String(left.id).localeCompare(String(right.id))),
    added,
    updated,
    duplicates,
  }
}

function cleanState(value) {
  const files = record(value?.files) ?? {}
  const output = {}
  for (const [path, entry] of Object.entries(files)) {
    if (typeof path !== 'string' || path.length > 700) continue
    const input = record(entry)
    if (!input || !/^[a-f0-9]{64}$/i.test(input.hash)) continue
    output[path] = {
      hash: input.hash.toLowerCase(),
      size: Number.isFinite(Number(input.size)) ? Number(input.size) : 0,
      mtimeMs: Number.isFinite(Number(input.mtimeMs)) ? Number(input.mtimeMs) : 0,
      importedAt: iso(input.importedAt) || new Date(0).toISOString(),
      eventCount: Number.isFinite(Number(input.eventCount)) ? Number(input.eventCount) : 0,
    }
  }
  return { version: 1, files: output }
}

async function readState(path) {
  try {
    return cleanState(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return cleanState(null)
    throw error
  }
}

function relativeSourcePath(root, candidate) {
  const path = relative(root, candidate).replace(/\\/g, '/')
  if (!path || path.startsWith('../') || path.includes('/../')) throw new Error('SELENE inbox file is outside the configured directory')
  return path
}

async function snapshotFiles(root, maximum) {
  const entries = await readdir(root, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !snapshotDirectory.test(entry.name)) continue
    const path = resolve(root, entry.name, 'context-events.json')
    if (!path.startsWith(`${root}${sep}`)) continue
    try {
      const details = await lstat(path)
      if (details.isFile() && !details.isSymbolicLink()) candidates.push({ path, details })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path)).slice(0, maximum)
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback
}

/**
 * Watches an explicitly configured, Syncthing-populated SELENE inbox. It reads
 * only complete immutable snapshots and retains no coordinate data in its
 * bookkeeping file.
 */
export function createSeleneInboxWatcher(options) {
  const root = resolve(String(options?.directory || ''))
  const statePath = resolve(String(options?.statePath || ''))
  const onImport = options?.onImport
  if (!options?.directory || !options?.statePath || typeof onImport !== 'function') throw new Error('SELENE inbox watcher requires directory, statePath, and onImport')

  const intervalMs = boundedNumber(options.intervalMs, 30_000, 5_000, 15 * 60_000)
  const settleMs = boundedNumber(options.settleMs, 4_000, 1_000, 60_000)
  const maximumFileBytes = boundedNumber(options.maximumFileBytes, 4 * 1024 * 1024, 1_024, 64 * 1024 * 1024)
  const maximumSnapshots = boundedNumber(options.maximumSnapshots, 10_000, 1, 100_000)
  const logger = typeof options.logger === 'function' ? options.logger : () => undefined
  let timer = null
  let state = null
  let scanPromise = null
  let status = {
    enabled: true,
    directory: root,
    intervalMs,
    pendingFiles: 0,
    processedFiles: 0,
    importedEvents: 0,
    lastScanAt: null,
    lastSuccessAt: null,
    lastError: null,
  }

  async function persist() {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
    await writeFileAtomically(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  }

  async function scan() {
    if (scanPromise) return scanPromise
    scanPromise = (async () => {
      try {
        const rootDetails = await stat(root)
        if (!rootDetails.isDirectory()) throw new Error('HYPERION_SELENE_INBOX is not a directory')
        if (!state) state = await readState(statePath)
        const now = Date.now()
        const files = await snapshotFiles(root, maximumSnapshots)
        let pendingFiles = 0
        let processedFiles = 0
        let importedEvents = 0
        for (const candidate of files) {
          const sourcePath = relativeSourcePath(root, candidate.path)
          const previous = state.files[sourcePath]
          const fingerprint = `${candidate.details.size}:${Math.floor(candidate.details.mtimeMs)}`
          if (previous && `${previous.size}:${Math.floor(previous.mtimeMs)}` === fingerprint) continue
          if (candidate.details.size > maximumFileBytes || now - candidate.details.mtimeMs < settleMs) {
            pendingFiles += 1
            continue
          }

          const raw = await readFile(candidate.path)
          const afterRead = await lstat(candidate.path)
          if (!afterRead.isFile() || afterRead.isSymbolicLink() || afterRead.size !== candidate.details.size || Math.floor(afterRead.mtimeMs) !== Math.floor(candidate.details.mtimeMs)) {
            pendingFiles += 1
            continue
          }
          const hash = createHash('sha256').update(raw).digest('hex')
          if (previous?.hash === hash) {
            state.files[sourcePath] = { ...previous, size: afterRead.size, mtimeMs: afterRead.mtimeMs }
            await persist()
            continue
          }

          let document
          try {
            document = JSON.parse(raw.toString('utf8'))
          } catch {
            pendingFiles += 1
            continue
          }
          const platform = document?.device?.platform
          const normalized = normalizeSeleneDocument(document, {
            sourceFile: `${platform}/${sourcePath}`,
            importedAt: new Date().toISOString(),
          })
          if (!normalized) {
            logger('warn', `ignored invalid SELENE snapshot: ${sourcePath}`)
            state.files[sourcePath] = {
              hash,
              size: afterRead.size,
              mtimeMs: afterRead.mtimeMs,
              importedAt: new Date().toISOString(),
              eventCount: 0,
            }
            await persist()
            continue
          }
          const outcome = await onImport(normalized.events, {
            platform: normalized.platform,
            sourceFile: `${normalized.platform}/${sourcePath}`,
            generatedAt: normalized.generatedAt,
          })
          state.files[sourcePath] = {
            hash,
            size: afterRead.size,
            mtimeMs: afterRead.mtimeMs,
            importedAt: new Date().toISOString(),
            eventCount: normalized.events.length,
          }
          await persist()
          processedFiles += 1
          importedEvents += Number(outcome?.added) || 0
          logger('info', `imported SELENE snapshot ${sourcePath}: ${normalized.events.length} events`)
        }
        status = {
          ...status,
          pendingFiles,
          processedFiles,
          importedEvents,
          lastScanAt: new Date().toISOString(),
          ...(processedFiles ? { lastSuccessAt: new Date().toISOString() } : {}),
          lastError: null,
        }
      } catch (error) {
        // The desktop renderer creates the shared state on first launch. Keep
        // an incoming immutable snapshot pending until then without treating
        // normal startup ordering as a data error.
        if (error?.code === 'HYPERION_STATE_UNINITIALIZED') {
          status = { ...status, lastScanAt: new Date().toISOString(), lastError: null }
          return status
        }
        status = { ...status, lastScanAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) }
        logger('warn', `SELENE inbox scan failed: ${status.lastError}`)
      } finally {
        scanPromise = null
      }
      return status
    })()
    return scanPromise
  }

  return {
    async start() {
      await scan()
      if (!timer) {
        timer = setInterval(() => { void scan() }, intervalMs)
        timer.unref?.()
      }
      return status
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    scan,
    status: () => ({ ...status }),
  }
}

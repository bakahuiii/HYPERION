import { access, mkdir, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, sep } from 'node:path'

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const applicationRoot = resolve(serverDirectory, '..')

function environmentPath(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() ? resolve(value.trim()) : ''
}

function releaseRuntimePaths(root) {
  const dataDirectory = resolve(root, 'data')
  const logDirectory = resolve(root, 'logs')
  const imageDirectory = resolve(root, 'assets', 'img')
  return {
    workspace: root,
    sharedStatePath: resolve(dataDirectory, 'state.json'),
    sharedIntelPath: resolve(dataDirectory, 'chat-archive.json.gz'),
    sharedIntelStoreDirectoryPath: resolve(dataDirectory, 'chat-archive'),
    sharedIntelMetaPath: resolve(dataDirectory, 'chat-archive.meta.json'),
    sharedIntelLegacyPath: resolve(dataDirectory, 'chat-archive.json'),
    seleneInboxStatePath: resolve(dataDirectory, 'selene-inbox-state.json'),
    mnemoInboxDirectoryPath: resolve(dataDirectory, 'mnemo-inbox'),
    mnemoInboxStatePath: resolve(dataDirectory, 'mnemo-inbox-state.json'),
    mnemoExportDirectoryPath: resolve(dataDirectory, 'mnemo-export'),
    settingsPath: resolve(dataDirectory, 'settings.ini'),
    credentialStorePath: resolve(dataDirectory, 'credentials.json'),
    legacyProviderPath: resolve(dataDirectory, 'legacy-provider.json'),
    aiDebugLogPath: resolve(logDirectory, 'ai-debug.jsonl'),
    taskLogDirectoryPath: resolve(logDirectory, 'tasks'),
    crashLogPath: resolve(logDirectory, 'crash-recovery.jsonl'),
    serviceSessionPath: resolve(dataDirectory, 'runtime', 'service-session.json'),
    avatarCacheDirectoryPath: resolve(imageDirectory, 'avatars'),
    mapTileCacheDirectoryPath: resolve(dataDirectory, 'cache', 'map-tiles'),
    backgroundDirectoryPath: resolve(imageDirectory, 'backgrounds'),
    electronUserDataPath: resolve(dataDirectory, 'electron'),
    desktopPidPath: resolve(dataDirectory, 'runtime', 'desktop.pid'),
    migrationDirectoryPath: resolve(dataDirectory, 'migrations'),
    dataDirectory,
    logDirectory,
    imageDirectory,
  }
}

function developmentRuntimePaths(root, prefix) {
  return {
    workspace: root,
    sharedStatePath: resolve(root, `${prefix}-shared-state.json`),
    sharedIntelPath: resolve(root, `${prefix}-shared-intel.json.gz`),
    sharedIntelStoreDirectoryPath: resolve(root, `${prefix}-intel-store`),
    sharedIntelMetaPath: resolve(root, `${prefix}-shared-intel.meta.json`),
    sharedIntelLegacyPath: resolve(root, `${prefix}-shared-intel.json`),
    seleneInboxStatePath: resolve(root, `${prefix}-selene-inbox-state.json`),
    mnemoInboxDirectoryPath: resolve(root, `${prefix}-mnemo-inbox`),
    mnemoInboxStatePath: resolve(root, `${prefix}-mnemo-inbox-state.json`),
    mnemoExportDirectoryPath: resolve(root, `${prefix}-mnemo-export`),
    settingsPath: resolve(root, `${prefix}-settings.ini`),
    credentialStorePath: resolve(root, `${prefix}-credentials.json`),
    legacyProviderPath: resolve(root, '.ai-provider.json'),
    aiDebugLogPath: resolve(root, `${prefix}-ai-debug.log`),
    taskLogDirectoryPath: resolve(root, `${prefix}-task-logs`),
    crashLogPath: resolve(root, `${prefix}-crash-recovery.log`),
    serviceSessionPath: resolve(root, `${prefix}-service-session.json`),
    avatarCacheDirectoryPath: resolve(root, `${prefix}-avatar-cache`),
    mapTileCacheDirectoryPath: resolve(root, `${prefix}-map-tile-cache`),
    backgroundDirectoryPath: resolve(root, `${prefix}-backgrounds`),
    electronUserDataPath: resolve(root, `${prefix}-user-data`),
    desktopPidPath: resolve(root, `${prefix}-desktop.pid`),
    migrationDirectoryPath: resolve(root, `${prefix}-migrations`),
    dataDirectory: root,
    logDirectory: root,
    imageDirectory: root,
  }
}

export const releaseLayoutEnabled = process.env.HYPERION_RELEASE_LAYOUT === '1'
export const runtimeRoot = environmentPath('HYPERION_RUNTIME_ROOT') || applicationRoot
export const runtimePaths = releaseLayoutEnabled
  ? releaseRuntimePaths(runtimeRoot)
  : developmentRuntimePaths(runtimeRoot, '.hyperion')

const legacyRuntimeRoot = environmentPath('THEIA_RUNTIME_ROOT')
  || (releaseLayoutEnabled ? resolve(dirname(runtimeRoot), 'THEIA') : applicationRoot)
const legacyReleaseLayoutEnabled = process.env.THEIA_RELEASE_LAYOUT === '1' || releaseLayoutEnabled
export const legacyRuntimePaths = legacyReleaseLayoutEnabled
  ? releaseRuntimePaths(legacyRuntimeRoot)
  : developmentRuntimePaths(legacyRuntimeRoot, '.theia')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Moves legacy mutable state only when the HYPERION destination is absent.
 * The caller owns when this runs so tests and a concurrently running old app
 * never relocate live state behind each other's backs.
 */
export async function migrateRuntimePaths(legacyPaths, currentPaths) {
  const candidates = Object.entries(currentPaths)
    .filter(([name, destination]) => name !== 'workspace' && typeof destination === 'string')
    .map(([name, destination]) => ({ name, source: legacyPaths[name], destination }))
    .filter((entry) => typeof entry.source === 'string' && resolve(entry.source) !== resolve(entry.destination))
    .sort((left, right) => left.source.split(sep).length - right.source.split(sep).length)
  const migrated = []
  const skipped = []
  const handledSources = new Set()

  for (const entry of candidates) {
    const source = resolve(entry.source)
    const destination = resolve(entry.destination)
    if (handledSources.has(source)) continue
    handledSources.add(source)
    if (!await exists(source)) continue
    if (await exists(destination)) {
      skipped.push(entry.name)
      continue
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await rename(source, destination)
    migrated.push(entry.name)
  }
  return { migrated, skipped }
}

export function migrateLegacyRuntimeData() {
  return migrateRuntimePaths(legacyRuntimePaths, runtimePaths)
}

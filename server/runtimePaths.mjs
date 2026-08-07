import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const applicationRoot = resolve(serverDirectory, '..')
const requestedRuntimeRoot = typeof process.env.THEIA_RUNTIME_ROOT === 'string'
  ? process.env.THEIA_RUNTIME_ROOT.trim()
  : ''

export const releaseLayoutEnabled = process.env.THEIA_RELEASE_LAYOUT === '1'
export const runtimeRoot = requestedRuntimeRoot ? resolve(requestedRuntimeRoot) : applicationRoot

const releasePaths = {
  dataDirectory: resolve(runtimeRoot, 'data'),
  logDirectory: resolve(runtimeRoot, 'logs'),
  imageDirectory: resolve(runtimeRoot, 'assets', 'img'),
}

/**
 * Keeps the development workspace backward compatible while allowing the
 * distributable to place all mutable data in explicit, reviewable folders.
 */
export const runtimePaths = releaseLayoutEnabled ? {
  workspace: runtimeRoot,
  sharedStatePath: resolve(releasePaths.dataDirectory, 'state.json'),
  sharedIntelPath: resolve(releasePaths.dataDirectory, 'chat-archive.json.gz'),
  sharedIntelStoreDirectoryPath: resolve(releasePaths.dataDirectory, 'chat-archive'),
  sharedIntelMetaPath: resolve(releasePaths.dataDirectory, 'chat-archive.meta.json'),
  sharedIntelLegacyPath: resolve(releasePaths.dataDirectory, 'chat-archive.json'),
  seleneInboxStatePath: resolve(releasePaths.dataDirectory, 'selene-inbox-state.json'),
  mnemoInboxDirectoryPath: resolve(releasePaths.dataDirectory, 'mnemo-inbox'),
  mnemoInboxStatePath: resolve(releasePaths.dataDirectory, 'mnemo-inbox-state.json'),
  mnemoExportDirectoryPath: resolve(releasePaths.dataDirectory, 'mnemo-export'),
  settingsPath: resolve(releasePaths.dataDirectory, 'settings.ini'),
  credentialStorePath: resolve(releasePaths.dataDirectory, 'credentials.json'),
  legacyProviderPath: resolve(releasePaths.dataDirectory, 'legacy-provider.json'),
  aiDebugLogPath: resolve(releasePaths.logDirectory, 'ai-debug.jsonl'),
  taskLogDirectoryPath: resolve(releasePaths.logDirectory, 'tasks'),
  crashLogPath: resolve(releasePaths.logDirectory, 'crash-recovery.jsonl'),
  serviceSessionPath: resolve(releasePaths.dataDirectory, 'runtime', 'service-session.json'),
  avatarCacheDirectoryPath: resolve(releasePaths.imageDirectory, 'avatars'),
  mapTileCacheDirectoryPath: resolve(releasePaths.dataDirectory, 'cache', 'map-tiles'),
  backgroundDirectoryPath: resolve(releasePaths.imageDirectory, 'backgrounds'),
  electronUserDataPath: resolve(releasePaths.dataDirectory, 'electron'),
  desktopPidPath: resolve(releasePaths.dataDirectory, 'runtime', 'desktop.pid'),
  migrationDirectoryPath: resolve(releasePaths.dataDirectory, 'migrations'),
  ...releasePaths,
} : {
  workspace: applicationRoot,
  sharedStatePath: resolve(applicationRoot, '.theia-shared-state.json'),
  sharedIntelPath: resolve(applicationRoot, '.theia-shared-intel.json.gz'),
  sharedIntelStoreDirectoryPath: resolve(applicationRoot, '.theia-intel-store'),
  sharedIntelMetaPath: resolve(applicationRoot, '.theia-shared-intel.meta.json'),
  sharedIntelLegacyPath: resolve(applicationRoot, '.theia-shared-intel.json'),
  seleneInboxStatePath: resolve(applicationRoot, '.theia-selene-inbox-state.json'),
  mnemoInboxDirectoryPath: resolve(applicationRoot, '.theia-mnemo-inbox'),
  mnemoInboxStatePath: resolve(applicationRoot, '.theia-mnemo-inbox-state.json'),
  mnemoExportDirectoryPath: resolve(applicationRoot, '.theia-mnemo-export'),
  settingsPath: resolve(applicationRoot, '.theia-settings.ini'),
  credentialStorePath: resolve(applicationRoot, '.theia-credentials.json'),
  legacyProviderPath: resolve(applicationRoot, '.ai-provider.json'),
  aiDebugLogPath: resolve(applicationRoot, '.theia-ai-debug.log'),
  taskLogDirectoryPath: resolve(applicationRoot, '.theia-task-logs'),
  crashLogPath: resolve(applicationRoot, '.theia-crash-recovery.log'),
  serviceSessionPath: resolve(applicationRoot, '.theia-service-session.json'),
  avatarCacheDirectoryPath: resolve(applicationRoot, '.theia-avatar-cache'),
  mapTileCacheDirectoryPath: resolve(applicationRoot, '.theia-map-tile-cache'),
  backgroundDirectoryPath: resolve(applicationRoot, '.theia-backgrounds'),
  electronUserDataPath: resolve(applicationRoot, '.theia-user-data'),
  desktopPidPath: resolve(applicationRoot, '.theia-desktop.pid'),
  migrationDirectoryPath: resolve(applicationRoot, '.theia-migrations'),
  dataDirectory: applicationRoot,
  logDirectory: applicationRoot,
  imageDirectory: applicationRoot,
}

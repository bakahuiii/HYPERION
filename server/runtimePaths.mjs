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
  sharedIntelMetaPath: resolve(releasePaths.dataDirectory, 'chat-archive.meta.json'),
  sharedIntelLegacyPath: resolve(releasePaths.dataDirectory, 'chat-archive.json'),
  settingsPath: resolve(releasePaths.dataDirectory, 'settings.ini'),
  legacyProviderPath: resolve(releasePaths.dataDirectory, 'legacy-provider.json'),
  aiDebugLogPath: resolve(releasePaths.logDirectory, 'ai-debug.jsonl'),
  taskLogDirectoryPath: resolve(releasePaths.logDirectory, 'tasks'),
  avatarCacheDirectoryPath: resolve(releasePaths.imageDirectory, 'avatars'),
  backgroundDirectoryPath: resolve(releasePaths.imageDirectory, 'backgrounds'),
  electronUserDataPath: resolve(releasePaths.dataDirectory, 'electron'),
  desktopPidPath: resolve(releasePaths.dataDirectory, 'runtime', 'desktop.pid'),
  ...releasePaths,
} : {
  workspace: applicationRoot,
  sharedStatePath: resolve(applicationRoot, '.theia-shared-state.json'),
  sharedIntelPath: resolve(applicationRoot, '.theia-shared-intel.json.gz'),
  sharedIntelMetaPath: resolve(applicationRoot, '.theia-shared-intel.meta.json'),
  sharedIntelLegacyPath: resolve(applicationRoot, '.theia-shared-intel.json'),
  settingsPath: resolve(applicationRoot, '.theia-settings.ini'),
  legacyProviderPath: resolve(applicationRoot, '.ai-provider.json'),
  aiDebugLogPath: resolve(applicationRoot, '.theia-ai-debug.log'),
  taskLogDirectoryPath: resolve(applicationRoot, '.theia-task-logs'),
  avatarCacheDirectoryPath: resolve(applicationRoot, '.theia-avatar-cache'),
  backgroundDirectoryPath: resolve(applicationRoot, '.theia-backgrounds'),
  electronUserDataPath: resolve(applicationRoot, '.theia-user-data'),
  desktopPidPath: resolve(applicationRoot, '.theia-desktop.pid'),
  dataDirectory: applicationRoot,
  logDirectory: applicationRoot,
  imageDirectory: applicationRoot,
}

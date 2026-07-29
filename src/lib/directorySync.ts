const DB_NAME = 'theia-automation'
const STORE_NAME = 'handles'
const HANDLE_KEY = 'export-directory'

type LocalPermissionState = 'granted' | 'denied' | 'prompt'

interface LocalFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
}

export interface LocalDirectoryHandle {
  kind: 'directory'
  name: string
  entries(): AsyncIterableIterator<[string, LocalFileHandle | LocalDirectoryHandle]>
  queryPermission(options?: { mode: 'read' }): Promise<LocalPermissionState>
  requestPermission(options?: { mode: 'read' }): Promise<LocalPermissionState>
}

export interface WatchedFile {
  file: File
  path: string
  signature: string
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function supportsDirectorySync() {
  return typeof indexedDB !== 'undefined' && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

export async function chooseExportDirectory() {
  const picker = (window as unknown as {
    showDirectoryPicker: (options: { id: string; mode: 'read'; startIn: 'documents' }) => Promise<LocalDirectoryHandle>
  }).showDirectoryPicker
  return picker({ id: 'theia-exports', mode: 'read', startIn: 'documents' })
}

export async function saveDirectoryHandle(handle: LocalDirectoryHandle) {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(handle, HANDLE_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export async function loadDirectoryHandle() {
  const database = await openDatabase()
  const handle = await new Promise<LocalDirectoryHandle | undefined>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(HANDLE_KEY)
    request.onsuccess = () => resolve(request.result as LocalDirectoryHandle | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return handle
}

export async function ensureDirectoryPermission(handle: LocalDirectoryHandle, requestAccess = false) {
  const current = await handle.queryPermission({ mode: 'read' })
  if (current === 'granted') return true
  if (!requestAccess) return false
  return (await handle.requestPermission({ mode: 'read' })) === 'granted'
}

const supportedExtensions = ['.json', '.csv', '.txt']
/** Bump when the importer gains non-text metadata that needs one safe backfill pass. */
export const DIRECTORY_IMPORT_SIGNATURE_VERSION = 'session-avatar-v1'

export async function scanExportDirectory(root: LocalDirectoryHandle, maxFiles = 20_000): Promise<WatchedFile[]> {
  const found: WatchedFile[] = []

  const visit = async (directory: LocalDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > 24 || found.length >= maxFiles) return
    for await (const [name, entry] of directory.entries()) {
      if (found.length >= maxFiles) break
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.kind === 'directory') {
        await visit(entry, path, depth + 1)
        continue
      }
      if (!supportedExtensions.some((extension) => name.toLowerCase().endsWith(extension))) continue
      const file = await entry.getFile()
      if (file.size > 50 * 1024 * 1024) continue
      found.push({
        file,
        path,
        signature: `${path}:${file.size}:${file.lastModified}`,
      })
    }
  }

  await visit(root, '', 0)
  return found.sort((a, b) => b.file.lastModified - a.file.lastModified)
}

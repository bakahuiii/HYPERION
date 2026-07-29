import type { IntelItem } from '../types'

const DB_NAME = 'theia-data'
const STORE_NAME = 'snapshots'
const INTEL_KEY = 'intel'

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

export async function loadIntelSnapshot(): Promise<IntelItem[] | null> {
  if (typeof indexedDB === 'undefined') return null
  const database = await openDatabase()
  try {
    const result = await new Promise<IntelItem[] | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(INTEL_KEY)
      request.onsuccess = () => resolve(request.result as IntelItem[] | undefined)
      request.onerror = () => reject(request.error)
    })
    return Array.isArray(result) ? result : null
  } finally {
    database.close()
  }
}

export async function saveIntelSnapshot(items: IntelItem[]) {
  if (typeof indexedDB === 'undefined') return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(items, INTEL_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

const DB_NAME = 'theia-assets'
const STORE_NAME = 'backgrounds'

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

export async function saveBackgroundAsset(file: File) {
  if (file.size > 8 * 1024 * 1024) throw new Error('背景图片不能超过 8MB')
  const imageId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(file, imageId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    return imageId
  } finally {
    database.close()
  }
}

export async function loadBackgroundAsset(imageId: string) {
  if (typeof indexedDB === 'undefined') return undefined
  const database = await openDatabase()
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(imageId)
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

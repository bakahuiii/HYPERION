import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { runtimePaths } from './runtimePaths.mjs'
import { writeFileAtomically } from './atomicFile.mjs'

const { credentialStorePath } = runtimePaths
const SERVICE_NAME = 'THEIA'
let backendPromise
let credentialCache = new Map()
let writeQueue = Promise.resolve()

async function backend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      try {
        const electron = await import('electron')
        const safeStorage = electron.safeStorage
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null
        return safeStorage
      } catch {
        return null
      }
    })()
  }
  return backendPromise
}
async function readStore() {
  try {
    const value = JSON.parse(await readFile(credentialStorePath, 'utf8'))
    if (value?.credentials && typeof value.credentials === 'object' && !Array.isArray(value.credentials)) return value.credentials
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

export async function credentialStoreAvailable() {
  return Boolean(await backend())
}

export async function loadCredential(reference) {
  const safeReference = typeof reference === 'string' ? reference.trim().slice(0, 160) : ''
  if (!safeReference || !(await credentialStoreAvailable())) return null
  if (credentialCache.has(safeReference)) return credentialCache.get(safeReference) || null
  const encrypted = (await readStore())[safeReference]
  if (typeof encrypted !== 'string' || !encrypted) return null
  try {
    const value = (await backend()).decryptString(Buffer.from(encrypted, 'base64'))
    credentialCache.set(safeReference, value)
    return value
  } catch {
    return null
  }
}

export async function saveCredential(reference, value) {
  const safeReference = typeof reference === 'string' ? reference.trim().slice(0, 160) : ''
  const secret = typeof value === 'string' ? value.trim().slice(0, 1000) : ''
  const safeStorage = await backend()
  if (!safeReference || !secret || !safeStorage) return null
  const encrypted = safeStorage.encryptString(secret).toString('base64')
  const write = writeQueue.then(async () => {
    const store = await readStore()
    store[safeReference] = encrypted
    await mkdir(dirname(credentialStorePath), { recursive: true, mode: 0o700 })
    await writeFileAtomically(credentialStorePath, JSON.stringify({ service: SERVICE_NAME, version: 1, credentials: store }), { encoding: 'utf8', mode: 0o600 })
    credentialCache.set(safeReference, secret)
    return safeReference
  })
  writeQueue = write.catch(() => undefined)
  return write
}

export async function deleteCredential(reference) {
  const safeReference = typeof reference === 'string' ? reference.trim().slice(0, 160) : ''
  if (!safeReference || !(await credentialStoreAvailable())) return false
  const write = writeQueue.then(async () => {
    const store = await readStore()
    if (!Object.hasOwn(store, safeReference)) return false
    delete store[safeReference]
    await writeFileAtomically(credentialStorePath, JSON.stringify({ service: SERVICE_NAME, version: 1, credentials: store }), { encoding: 'utf8', mode: 0o600 })
    credentialCache.delete(safeReference)
    return true
  })
  writeQueue = write.catch(() => undefined)
  return write
}

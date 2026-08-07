import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const transientRenameCodes = new Set(['EACCES', 'EBUSY', 'EPERM', 'ENOTEMPTY'])
const lockRetryDelayMs = 100
const lockTimeoutMs = 60_000
const staleLockMs = 300_000

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function isTransientRenameError(error) {
  return transientRenameCodes.has(error?.code)
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function lockOwnerExited(path) {
  try {
    const owner = Number.parseInt((await readFile(path, 'utf8')).trim(), 10)
    return Number.isSafeInteger(owner) && owner > 0 && !processIsRunning(owner)
  } catch {
    return false
  }
}

/**
 * Replaces a file without sharing a fixed `.tmp` path between processes.
 * Windows can briefly deny a rename while antivirus/indexing/another reader
 * still has the destination open, so retry only those transient failures.
 */
export async function writeFileAtomically(path, data, options) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, data, options)
    let lastError
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rename(temporary, path)
        return
      } catch (error) {
        if (!isTransientRenameError(error)) throw error
        lastError = error
        if (attempt < 7) await sleep(Math.min(750, 50 * (2 ** attempt)))
      }
    }
    throw lastError
  } catch (error) {
    // Keep the previous destination untouched when replacement fails. The
    // unique temporary is safe to remove and will never collide with a
    // concurrent writer from another HYPERION process.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function removeLockIfStale(path) {
  try {
    const details = await stat(path)
    if (Date.now() - details.mtimeMs <= staleLockMs && !await lockOwnerExited(path)) return false
    await unlink(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  }
}

/** Serializes archive writes across separate local proxy processes. */
export async function withFileLock(path, task) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const startedAt = Date.now()
  let handle
  while (!handle) {
    try {
      handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`, 'utf8')
    } catch (error) {
      await handle?.close().catch(() => undefined)
      handle = undefined
      if (error?.code !== 'EEXIST') throw error
      await removeLockIfStale(path)
      if (Date.now() - startedAt >= lockTimeoutMs) {
        const timeoutError = new Error(`文件锁等待超时：${path}`)
        timeoutError.code = 'ELOCKED'
        throw timeoutError
      }
      await sleep(lockRetryDelayMs)
    }
  }

  try {
    return await task()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(path).catch(() => undefined)
  }
}

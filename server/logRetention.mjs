import { readdir, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Removes oldest inactive files until both count and byte limits are met. */
export async function pruneLogDirectory(directory, { maxFiles, maxBytes, exclude = new Set() }) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return { removedFiles: 0, removedBytes: 0, retainedFiles: 0, retainedBytes: 0 }
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = resolve(directory, entry.name)
    if (exclude.has(path)) continue
    try {
      const details = await stat(path)
      files.push({ path, mtimeMs: details.mtimeMs, size: details.size })
    } catch { /* A concurrently rotated file no longer needs retention work. */ }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))
  let retainedBytes = 0
  let retainedFiles = 0
  let removedFiles = 0
  let removedBytes = 0
  for (const file of files) {
    const keep = retainedFiles < Math.max(1, maxFiles) && retainedBytes + file.size <= Math.max(1, maxBytes)
    if (keep) {
      retainedFiles += 1
      retainedBytes += file.size
      continue
    }
    await unlink(file.path).catch((error) => { if (error?.code !== 'ENOENT') throw error })
    removedFiles += 1
    removedBytes += file.size
  }
  return { removedFiles, removedBytes, retainedFiles, retainedBytes }
}

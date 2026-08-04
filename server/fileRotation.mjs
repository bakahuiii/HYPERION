import { rename, unlink } from 'node:fs/promises'

async function removeIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function moveIfPresent(source, target) {
  try {
    await rename(source, target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** Rotates path to path.1 while shifting existing copies up to copyCount. */
export async function rotateFileCopies(path, copyCount) {
  const copies = Math.max(1, Math.floor(Number(copyCount) || 1))
  for (let index = copies - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`
    const target = `${path}.${index + 1}`
    await removeIfPresent(target)
    await moveIfPresent(source, target)
  }
  await removeIfPresent(`${path}.1`)
  await moveIfPresent(path, `${path}.1`)
}

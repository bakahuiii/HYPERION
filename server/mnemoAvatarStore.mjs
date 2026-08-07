import { lstat, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const maximumAvatarBytes = 5 * 1024 * 1024
const avatarIdPattern = /^[a-f0-9]{64}$/i
const avatarFilePattern = /^mnemo-([a-f0-9]{64})\.(avif|gif|jpg|png|webp)$/i

function imageMimeType(content) {
  if (content.length >= 3 && content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (content.subarray(0, 6).toString('ascii') === 'GIF87a' || content.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (content.length >= 12 && content.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(content.subarray(8, 12).toString('ascii'))) return 'image/avif'
  return ''
}

function localPath(root, name) {
  const path = resolve(root, name)
  if (!path.startsWith(`${root}${sep}`)) throw new Error('MNEMO avatar path is outside THEIA cache')
  return path
}

async function regularFile(path, maximum) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > maximum) throw new Error('MNEMO avatar cache entry is invalid')
  return details
}

/** Validates and reads a locally captured MNEMO avatar from THEIA-owned storage. */
export async function readMnemoAvatar(directory, value) {
  const id = typeof value === 'string' && avatarIdPattern.test(value) ? value.toLowerCase() : ''
  if (!id) throw new Error('MNEMO avatar id is invalid')
  const root = resolve(String(directory || ''))
  const metadataPath = localPath(root, `mnemo-${id}.json`)
  await regularFile(metadataPath, 8 * 1024)
  let metadata
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')) } catch { throw new Error('MNEMO avatar metadata is invalid') }
  const file = typeof metadata?.file === 'string' ? metadata.file : ''
  const match = file.match(avatarFilePattern)
  if (!match || match[1].toLowerCase() !== id) throw new Error('MNEMO avatar metadata does not match its id')
  const path = localPath(root, file)
  await regularFile(path, maximumAvatarBytes)
  const content = await readFile(path)
  const mimeType = imageMimeType(content)
  if (!mimeType || metadata?.mimeType !== mimeType) throw new Error('MNEMO avatar image signature is invalid')
  return { mimeType, content }
}

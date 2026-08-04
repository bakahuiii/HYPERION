import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeFileAtomically } from './atomicFile.mjs'
import { rotateFileCopies } from './fileRotation.mjs'

const crashLogMaxBytes = 2 * 1024 * 1024
let writeQueue = Promise.resolve()

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown runtime failure')
  const stack = error instanceof Error && error.stack ? error.stack : ''
  return { message: message.slice(0, 2_000), stack: stack.slice(0, 12_000) }
}
async function appendRecoveryEvent(logPath, event) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
  const write = writeQueue.then(async () => {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
    try {
      const details = await import('node:fs/promises').then(({ stat }) => stat(logPath))
      if (details.size + Buffer.byteLength(line) > crashLogMaxBytes) await rotateFileCopies(logPath, 2)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 })
  })
  writeQueue = write.catch(() => undefined)
  return write
}

export async function startRecoverySession(markerPath, logPath, context = {}) {
  let previous = null
  try { previous = JSON.parse(await readFile(markerPath, 'utf8')) } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  if (previous) await appendRecoveryEvent(logPath, { event: 'unclean_shutdown_detected', previous })
  const session = { schema: 'theia-runtime-session/v1', pid: process.pid, startedAt: new Date().toISOString(), ...context }
  await writeFileAtomically(markerPath, JSON.stringify(session), { encoding: 'utf8', mode: 0o600 })
  return { uncleanShutdownDetected: Boolean(previous), previous, session }
}

export async function finishRecoverySession(markerPath) {
  await unlink(markerPath).catch((error) => { if (error?.code !== 'ENOENT') throw error })
}

export function recordRuntimeFailure(logPath, origin, error) {
  return appendRecoveryEvent(logPath, { event: 'runtime_failure', origin: String(origin).slice(0, 120), error: cleanError(error) })
}

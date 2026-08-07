import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function environmentValue(name) {
  return process.env[`HYPERION_${name}`] ?? process.env[`THEIA_${name}`]
}

/** Starts the independent MNEMO process while keeping lifecycle ownership in HYPERION. */
export function createMnemoAgentController(options = {}) {
  const workspace = resolve(clean(options.workspace) || process.cwd())
  const outboxDirectory = resolve(clean(options.outboxDirectory) || resolve(workspace, 'mnemo-inbox'))
  const archiveDirectory = resolve(clean(options.archiveDirectory || environmentValue('MNEMO_ARCHIVE')) || resolve(workspace, 'mnemo-export'))
  const avatarDirectory = resolve(clean(options.avatarDirectory || environmentValue('MNEMO_AVATAR_DIRECTORY')) || resolve(workspace, 'avatars'))
  const configuredHome = clean(options.home || environmentValue('MNEMO_HOME'))
  const home = configuredHome ? resolve(configuredHome) : resolve(workspace, '..', '..', 'MNEMO')
  const script = resolve(clean(options.script || environmentValue('MNEMO_SCRIPT')) || resolve(home, 'python', 'mnemo_agent.py'))
  const python = clean(options.python || environmentValue('MNEMO_PYTHON')) || 'python'
  const account = clean(options.account || environmentValue('MNEMO_ACCOUNT'))
  const interval = Math.min(900, Math.max(10, Math.round(Number(options.interval || environmentValue('MNEMO_INTERVAL_SECONDS')) || 30)))
  const enabled = options.enabled !== false && environmentValue('MNEMO_DISABLED') !== '1'
  let child = null
  let stopping = false
  let status = {
    enabled,
    available: existsSync(script),
    script,
    outboxDirectory,
    archiveDirectory,
    avatarDirectory,
    intervalSeconds: interval,
    processId: null,
    startedAt: null,
    runtimeState: enabled ? 'starting' : 'disabled',
    lastExit: null,
    lastError: null,
    lastEvent: null,
  }

  function recordAgentLine(line, isError) {
    const message = clean(line)
    if (!message) return
    if (isError) {
      // Python reserves stderr for exceptional local processing failures.
      // Ignore unrelated runtime notices, which must not surface as a data
      // error in HYPERION's otherwise silent intake.
      if (!message.startsWith('MNEMO:')) return
      const detail = clean(message.slice('MNEMO:'.length)).slice(0, 320)
      status = {
        ...status,
        runtimeState: 'error',
        lastError: detail ? `MNEMO local processing failed: ${detail}` : 'MNEMO agent reported a local processing error',
      }
      return
    }
    try {
      const event = JSON.parse(message)
      if (event?.type === 'mnemo-status' && (event.state === 'waiting' || event.state === 'ready')) {
        status = { ...status, runtimeState: event.state, lastError: null, lastEvent: event.state === 'ready' ? 'MNEMO local database is ready' : null }
        return
      }
    } catch {
      // Normal sync payloads are still accepted below without exposing data.
    }
    status = { ...status, runtimeState: 'ready', lastError: null, lastEvent: 'MNEMO incremental sync completed' }
  }

  function attachOutput(stream, isError) {
    if (!stream) return
    let buffered = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buffered = `${buffered}${chunk}`.slice(-2_048)
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() || ''
      for (const line of lines) recordAgentLine(line, isError)
    })
    stream.on('end', () => recordAgentLine(buffered, isError))
  }

  async function start() {
    if (!enabled) return { ...status }
    if (child && child.exitCode === null) return { ...status }
    stopping = false
    await Promise.all([
      mkdir(outboxDirectory, { recursive: true, mode: 0o700 }),
      mkdir(archiveDirectory, { recursive: true, mode: 0o700 }),
      mkdir(avatarDirectory, { recursive: true, mode: 0o700 }),
    ])
    if (!existsSync(script)) {
      status = { ...status, available: false, runtimeState: 'error', lastError: `MNEMO agent was not found: ${script}` }
      return { ...status }
    }
    const args = [
      script, 'serve', '--outbox', outboxDirectory,
      '--archive-directory', archiveDirectory,
      '--avatar-directory', avatarDirectory,
      '--interval', String(interval),
    ]
    if (account) args.push('--account', account)
    try {
      child = spawn(python, args, {
        cwd: dirname(script),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HYPERION_MNEMO_OUTBOX: outboxDirectory },
      })
      attachOutput(child.stdout, false)
      attachOutput(child.stderr, true)
      status = { ...status, available: true, processId: child.pid ?? null, startedAt: new Date().toISOString(), runtimeState: 'starting', lastError: null }
      child.once('error', () => { status = { ...status, processId: null, runtimeState: 'error', lastError: 'Unable to start the MNEMO agent' } })
      child.once('exit', (code, signal) => {
        status = stopping
          ? { ...status, processId: null, runtimeState: 'stopped', lastExit: { at: new Date().toISOString(), code, signal }, lastError: null }
          : { ...status, processId: null, runtimeState: 'error', lastExit: { at: new Date().toISOString(), code, signal }, lastError: code && code !== 0 ? `MNEMO agent exited with code ${code}` : 'MNEMO agent exited unexpectedly' }
        child = null
      })
    } catch (error) {
      status = { ...status, processId: null, runtimeState: 'error', lastError: error instanceof Error ? error.message : String(error) }
    }
    return { ...status }
  }

  function stop() {
    stopping = true
    if (child && child.exitCode === null) child.kill()
    child = null
    status = { ...status, processId: null, runtimeState: 'stopped' }
  }

  return { start, stop, status: () => ({ ...status }) }
}

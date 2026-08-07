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

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
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
  const onReady = typeof options.onReady === 'function' ? options.onReady : null
  const onSync = typeof options.onSync === 'function' ? options.onSync : null
  let child = null
  let childExitPromise = null
  let stopping = false
  let forceSyncPromise = null
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
    totalRecordCount: null,
    accountId: null,
    lastSyncAt: null,
    lastExit: null,
    lastError: null,
    lastEvent: null,
  }

  function snapshot() {
    return { ...status }
  }

  function updateStatus(update) {
    status = { ...status, ...update }
    return snapshot()
  }

  function eventStatusFields(event) {
    const totalRecordCount = nonNegativeInteger(event?.totalRecordCount)
    return {
      ...(totalRecordCount !== null ? { totalRecordCount } : {}),
      ...(clean(event?.accountId).slice(0, 180) ? { accountId: clean(event.accountId).slice(0, 180) } : {}),
      ...(clean(event?.lastSyncAt).slice(0, 80) ? { lastSyncAt: clean(event.lastSyncAt).slice(0, 80) } : {}),
    }
  }

  function notifyReady() {
    if (!onReady) return
    Promise.resolve(onReady(snapshot())).catch((error) => {
      console.warn(`[HYPERION] MNEMO startup reconciliation could not begin: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  function notifySync() {
    if (!onSync) return
    Promise.resolve(onSync(snapshot())).catch((error) => {
      console.warn(`[HYPERION] MNEMO incremental import could not begin: ${error instanceof Error ? error.message : String(error)}`)
    })
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
      updateStatus({
        runtimeState: 'error',
        lastError: detail ? `MNEMO local processing failed: ${detail}` : 'MNEMO agent reported a local processing error',
      })
      return
    }
    try {
      const event = JSON.parse(message)
      const eventFields = eventStatusFields(event)
      if (event?.type === 'mnemo-status' && (event.state === 'waiting' || event.state === 'ready')) {
        updateStatus({
          ...eventFields,
          runtimeState: event.state,
          lastError: null,
          lastEvent: event.state === 'ready' ? 'MNEMO local database is ready' : null,
        })
        if (event.state === 'ready') notifyReady()
        return
      }
      if (event && typeof event === 'object') {
        updateStatus({
          ...eventFields,
          runtimeState: 'ready',
          lastError: null,
          lastEvent: event.changed ? 'MNEMO incremental sync completed' : status.lastEvent,
        })
        if (event.changed) notifySync()
        return
      }
    } catch {
      // Normal sync payloads are still accepted below without exposing data.
    }
    updateStatus({ runtimeState: 'ready', lastError: null, lastEvent: 'MNEMO incremental sync completed' })
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

  async function ensureDirectories() {
    await Promise.all([
      mkdir(outboxDirectory, { recursive: true, mode: 0o700 }),
      mkdir(archiveDirectory, { recursive: true, mode: 0o700 }),
      mkdir(avatarDirectory, { recursive: true, mode: 0o700 }),
    ])
  }

  function commandArguments(command) {
    const args = [
      script, command, '--outbox', outboxDirectory,
      '--archive-directory', archiveDirectory,
      '--avatar-directory', avatarDirectory,
    ]
    if (command === 'serve') args.push('--interval', String(interval))
    if (account) args.push('--account', account)
    return args
  }

  async function start() {
    if (!enabled) return snapshot()
    if (child && child.exitCode === null) return snapshot()
    stopping = false
    await ensureDirectories()
    if (!existsSync(script)) {
      updateStatus({ available: false, runtimeState: 'error', lastError: `MNEMO agent was not found: ${script}` })
      return snapshot()
    }
    try {
      child = spawn(python, commandArguments('serve'), {
        cwd: dirname(script),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HYPERION_MNEMO_OUTBOX: outboxDirectory },
      })
      const runningChild = child
      childExitPromise = new Promise((resolveExit) => {
        runningChild.once('exit', (code, signal) => {
          const stopped = stopping
          if (child === runningChild) child = null
          childExitPromise = null
          updateStatus(stopped
            ? { processId: null, runtimeState: 'stopped', lastExit: { at: new Date().toISOString(), code, signal }, lastError: null }
            : { processId: null, runtimeState: 'error', lastExit: { at: new Date().toISOString(), code, signal }, lastError: code && code !== 0 ? `MNEMO agent exited with code ${code}` : 'MNEMO agent exited unexpectedly' })
          resolveExit()
        })
      })
      attachOutput(runningChild.stdout, false)
      attachOutput(runningChild.stderr, true)
      updateStatus({ available: true, processId: runningChild.pid ?? null, startedAt: new Date().toISOString(), runtimeState: 'starting', lastError: null })
      runningChild.once('error', () => updateStatus({ processId: null, runtimeState: 'error', lastError: 'Unable to start the MNEMO agent' }))
    } catch (error) {
      updateStatus({ processId: null, runtimeState: 'error', lastError: error instanceof Error ? error.message : String(error) })
    }
    return snapshot()
  }

  async function stop() {
    stopping = true
    const runningChild = child
    const exit = childExitPromise
    if (runningChild && runningChild.exitCode === null) {
      runningChild.kill()
      const stopped = await Promise.race([exit?.then(() => true), wait(15_000).then(() => false)])
      if (!stopped) {
        updateStatus({ runtimeState: 'error', lastError: 'MNEMO agent did not stop before the import timeout' })
        throw new Error(status.lastError)
      }
    } else {
      updateStatus({ processId: null, runtimeState: 'stopped' })
    }
    return snapshot()
  }

  function runOnce() {
    return new Promise((resolveOnce, rejectOnce) => {
      const onceChild = spawn(python, commandArguments('once'), {
        cwd: dirname(script),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HYPERION_MNEMO_OUTBOX: outboxDirectory },
      })
      let stdout = ''
      let stderr = ''
      onceChild.stdout?.setEncoding('utf8')
      onceChild.stderr?.setEncoding('utf8')
      onceChild.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-16_384) })
      onceChild.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096) })
      onceChild.once('error', rejectOnce)
      onceChild.once('close', (code) => {
        if (code !== 0) {
          rejectOnce(new Error(clean(stderr).replace(/^MNEMO:\s*/m, '').slice(0, 1_000) || `MNEMO full import exited with code ${code}`))
          return
        }
        const result = stdout.split(/\r?\n/).map((line) => clean(line)).filter(Boolean).map((line) => {
          try { return JSON.parse(line) } catch { return null }
        }).filter(Boolean).at(-1)
        if (!result || typeof result !== 'object') {
          rejectOnce(new Error('MNEMO full import returned no valid status'))
          return
        }
        resolveOnce(result)
      })
    })
  }

  async function forceSync() {
    if (!enabled) throw new Error('MNEMO integration is disabled')
    if (forceSyncPromise) return forceSyncPromise
    forceSyncPromise = (async () => {
      await stop()
      await ensureDirectories()
      if (!existsSync(script)) throw new Error(`MNEMO agent was not found: ${script}`)
      updateStatus({ runtimeState: 'syncing', lastError: null, lastEvent: 'MNEMO full import is running' })
      const result = await runOnce()
      updateStatus({
        ...eventStatusFields(result),
        runtimeState: 'starting',
        lastError: null,
        lastEvent: 'MNEMO full import completed; importing records into HYPERION',
      })
      await start()
      return { agent: snapshot(), result }
    })()
    try {
      return await forceSyncPromise
    } finally {
      forceSyncPromise = null
    }
  }

  return { start, stop, forceSync, status: snapshot }
}

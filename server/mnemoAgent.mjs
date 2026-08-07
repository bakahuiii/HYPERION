import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Starts the independent MNEMO process while keeping lifecycle ownership in THEIA. */
export function createMnemoAgentController(options = {}) {
  const workspace = resolve(clean(options.workspace) || process.cwd())
  const outboxDirectory = resolve(clean(options.outboxDirectory) || resolve(workspace, 'mnemo-inbox'))
  const archiveDirectory = resolve(clean(options.archiveDirectory || process.env.THEIA_MNEMO_ARCHIVE) || resolve(workspace, 'mnemo-export'))
  const avatarDirectory = resolve(clean(options.avatarDirectory || process.env.THEIA_MNEMO_AVATAR_DIRECTORY) || resolve(workspace, 'avatars'))
  const configuredHome = clean(options.home || process.env.THEIA_MNEMO_HOME)
  const home = configuredHome ? resolve(configuredHome) : resolve(workspace, '..', '..', 'WECHAT-Exporter')
  const script = resolve(clean(options.script || process.env.THEIA_MNEMO_SCRIPT) || resolve(home, 'python', 'mnemo_agent.py'))
  const python = clean(options.python || process.env.THEIA_MNEMO_PYTHON) || 'python'
  const account = clean(options.account || process.env.THEIA_MNEMO_ACCOUNT)
  const interval = Math.min(900, Math.max(10, Math.round(Number(options.interval || process.env.THEIA_MNEMO_INTERVAL_SECONDS) || 30)))
  const enabled = options.enabled !== false && process.env.THEIA_MNEMO_DISABLED !== '1'
  let child = null
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
    lastExit: null,
    lastError: null,
    lastEvent: null,
  }

  function recordAgentLine(line, isError) {
    const message = clean(line)
    if (!message) return
    if (message.includes('MNEMO setup required')) {
      status = { ...status, lastError: 'MNEMO setup required: capture the WeChat key once in the MNEMO GUI' }
      return
    }
    if (isError) status = { ...status, lastError: 'MNEMO agent reported a local processing error' }
    else status = { ...status, lastEvent: 'MNEMO incremental sync completed' }
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
    await Promise.all([
      mkdir(outboxDirectory, { recursive: true, mode: 0o700 }),
      mkdir(archiveDirectory, { recursive: true, mode: 0o700 }),
      mkdir(avatarDirectory, { recursive: true, mode: 0o700 }),
    ])
    if (!existsSync(script)) {
      status = { ...status, available: false, lastError: `MNEMO agent was not found: ${script}` }
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
        env: { ...process.env, THEIA_MNEMO_OUTBOX: outboxDirectory },
      })
      attachOutput(child.stdout, false)
      attachOutput(child.stderr, true)
      status = { ...status, available: true, processId: child.pid ?? null, startedAt: new Date().toISOString(), lastError: null }
      child.once('error', () => { status = { ...status, processId: null, lastError: 'Unable to start the MNEMO agent' } })
      child.once('exit', (code, signal) => {
        status = { ...status, processId: null, lastExit: { at: new Date().toISOString(), code, signal }, lastError: code && code !== 0 ? `MNEMO agent exited with code ${code}` : status.lastError }
        child = null
      })
    } catch (error) {
      status = { ...status, processId: null, lastError: error instanceof Error ? error.message : String(error) }
    }
    return { ...status }
  }

  function stop() {
    if (child && child.exitCode === null) child.kill()
    child = null
    status = { ...status, processId: null }
  }

  return { start, stop, status: () => ({ ...status }) }
}

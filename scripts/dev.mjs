import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import process from 'node:process'

const root = process.cwd()
const envPath = `${root}/.env`
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

const env = { ...process.env }
const api = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: 'inherit' })
// Electron checks the local Vite URL through IPv4, so keep the development
// server on the same loopback address instead of the Windows IPv6 default.
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: root, env, stdio: 'inherit' })

let stopping = false
let exitedChildren = 0
let forceExitTimer

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode

  if (api.exitCode === null && api.signalCode === null) api.kill('SIGTERM')
  if (web.exitCode === null && web.signalCode === null) web.kill('SIGTERM')

  forceExitTimer = setTimeout(() => {
    if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL')
    if (web.exitCode === null && web.signalCode === null) web.kill('SIGKILL')
    process.exit(process.exitCode || 1)
  }, 5_000)
}

function childExited(code, sibling) {
  exitedChildren += 1
  if (!stopping) {
    stop(code ?? 1)
    if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGTERM')
  }
  if (exitedChildren === 2) {
    clearTimeout(forceExitTimer)
    process.exit(process.exitCode ?? 0)
  }
}

process.on('SIGINT', () => stop(130))
process.on('SIGTERM', () => stop(143))
api.on('exit', (code) => childExited(code, web))
web.on('exit', (code) => childExited(code, api))

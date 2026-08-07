import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = process.env.HYPERION_RUNTIME_ROOT || resolve(appRoot, '..')
const command = process.platform === 'win32' ? 'electron.cmd' : 'electron'
const child = spawn(command, ['electron/main.mjs'], {
  cwd: appRoot,
  env: { ...process.env, HYPERION_RELEASE_LAYOUT: '1', HYPERION_RUNTIME_ROOT: runtimeRoot },
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => {
  console.error(`Unable to start HYPERION desktop: ${error.message}`)
  process.exitCode = 1
})

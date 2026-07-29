import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = process.env.THEIA_RUNTIME_ROOT || resolve(appRoot, '..')
const child = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: appRoot,
  env: { ...process.env, THEIA_RELEASE_LAYOUT: '1', THEIA_RUNTIME_ROOT: runtimeRoot },
  stdio: 'inherit',
})

child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => {
  console.error(`Unable to start THEIA web mode: ${error.message}`)
  process.exitCode = 1
})

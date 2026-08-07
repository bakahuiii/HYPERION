import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const runtimeRoot = await mkdtemp(resolve(tmpdir(), 'hyperion-e2e-'))
process.env.AI_PORT = '18787'
process.env.VITE_HYPERION_API_PORT = '18787'
process.env.HYPERION_RUNTIME_ROOT = runtimeRoot
process.env.HYPERION_RELEASE_LAYOUT = '1'
process.env.HYPERION_SELENE_AUTO_DISCOVERY = '0'
process.env.HYPERION_MNEMO_DISABLED = '1'

const [{ startAiProxy, server }, { createServer }] = await Promise.all([
  import('../server/index.mjs'),
  import('vite'),
])
await startAiProxy()
const vite = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 15173, strictPort: true },
})
await vite.listen()

let stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  await vite.close().catch(() => undefined)
  await new Promise((resolveClose) => server.close(resolveClose))
  const expectedPrefix = resolve(tmpdir(), 'hyperion-e2e-')
  if (runtimeRoot.startsWith(expectedPrefix)) await rm(runtimeRoot, { recursive: true, force: true })
  process.exit(code)
}

process.on('SIGINT', () => { void stop(130) })
process.on('SIGTERM', () => { void stop(143) })

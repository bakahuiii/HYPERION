import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { _electron as electron } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const executablePath = resolve(root, 'release-bin', 'installer', 'win-unpacked', 'THEIA.exe')
const runtimeRoot = await mkdtemp(resolve(tmpdir(), 'theia-unpacked-smoke-'))
let application

try {
  application = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      AI_PORT: '0',
      THEIA_RUNTIME_ROOT: runtimeRoot,
      THEIA_RELEASE_LAYOUT: '1',
      THEIA_SOFTWARE_RENDERING: '1',
    },
    timeout: 60_000,
  })
  const page = await application.firstWindow()
  await page.getByRole('region', { name: '按主题组织的任务图' }).waitFor({ state: 'visible', timeout: 60_000 })
  if (!(await page.title()).startsWith('THEIA')) throw new Error(`unpacked 桌面窗口标题异常：${await page.title()}`)
  console.log('Packaged win-unpacked startup smoke test passed.')
} finally {
  await application?.close().catch(() => undefined)
  const expectedPrefix = resolve(tmpdir(), 'theia-unpacked-smoke-')
  if (runtimeRoot.startsWith(expectedPrefix)) await rm(runtimeRoot, { recursive: true, force: true })
}

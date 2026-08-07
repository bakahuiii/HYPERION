import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { _electron as electron } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const runtimeRoot = await mkdtemp(resolve(tmpdir(), 'hyperion-desktop-smoke-'))
const dataDirectory = resolve(runtimeRoot, 'data')
const secret = `smoke-${Date.now()}-only`
await mkdir(dataDirectory, { recursive: true })
await writeFile(resolve(dataDirectory, 'settings.ini'), [
  '[meta]',
  'version=4',
  'appSettingsInitialized=true',
  '[provider]',
  'id=primary',
  'name=Smoke',
  'enabled=true',
  'url=https%3A%2F%2Fexample.invalid%2Fv1',
  `key=${secret}`,
  'model=smoke-model',
  'apiMode=auto',
  'models=%5B%22smoke-model%22%5D',
  'maxConcurrency=1',
  '[providers]',
  'primaryId=primary',
  'channels=%5B%5D',
  '',
].join('\n'), 'utf8')

let application
try {
  application = await electron.launch({
    args: ['electron/main.mjs'],
    cwd: root,
    env: {
      ...process.env,
      AI_PORT: '18788',
      VITE_HYPERION_API_PORT: '18788',
      HYPERION_RUNTIME_ROOT: runtimeRoot,
      HYPERION_RELEASE_LAYOUT: '1',
      HYPERION_SELENE_AUTO_DISCOVERY: '0',
      HYPERION_MNEMO_DISABLED: '1',
      HYPERION_SOFTWARE_RENDERING: '1',
    },
    timeout: 60_000,
  })
  const page = await application.firstWindow()
  await page.getByRole('region', { name: '按主题组织的任务图' }).waitFor({ state: 'visible', timeout: 60_000 })
  if (!(await page.title()).startsWith('HYPERION')) throw new Error(`桌面窗口标题异常：${await page.title()}`)
  const safeStorageAvailable = await application.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
  if (!safeStorageAvailable) throw new Error('当前 Electron 会话无法使用系统 safeStorage')
  const credentialPath = resolve(dataDirectory, 'credentials.json')
  let rewrittenIni = ''
  let credentialBlob = ''
  let migrationComplete = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      ;[rewrittenIni, credentialBlob] = await Promise.all([
        readFile(resolve(dataDirectory, 'settings.ini'), 'utf8'),
        readFile(credentialPath, 'utf8'),
      ])
      migrationComplete = !rewrittenIni.includes(secret)
        && !credentialBlob.includes(secret)
        && /credentialRef=/.test(rewrittenIni)
      if (migrationComplete) break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (!migrationComplete) throw new Error('safeStorage 迁移没有在等待期内完成')
  await application.close()
  application = undefined

  rewrittenIni = await readFile(resolve(dataDirectory, 'settings.ini'), 'utf8')
  credentialBlob = await readFile(credentialPath, 'utf8')
  if (rewrittenIni.includes(secret) || credentialBlob.includes(secret)) throw new Error('safeStorage 迁移后仍发现明文测试密钥')
  if (!/credentialRef=/.test(rewrittenIni)) throw new Error('safeStorage 迁移没有写入 credentialRef')
  console.log('Electron startup and safeStorage plaintext migration smoke test passed.')
} finally {
  await application?.close().catch(() => undefined)
  const expectedPrefix = resolve(tmpdir(), 'hyperion-desktop-smoke-')
  if (runtimeRoot.startsWith(expectedPrefix)) await rm(runtimeRoot, { recursive: true, force: true })
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const edgeCandidate = process.env['ProgramFiles(x86)']
  ? join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  : ''
const edgePath = process.platform === 'win32' && edgeCandidate && existsSync(edgeCandidate)
  ? edgeCandidate
  : undefined

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:15173',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: edgePath ? { executablePath: edgePath } : undefined,
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:15173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})

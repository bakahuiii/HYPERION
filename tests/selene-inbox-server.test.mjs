import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function document() {
  return {
    schema: 'selene-context-events/v1',
    device: { platform: 'android' },
    generatedAt: '2026-08-07T02:00:00.000+08:00',
    producer: { name: 'SELENE', version: '0.3.0', layout: 'immutable-snapshot-v1' },
    events: [{
      id: 'movement-server-test', version: 1, kind: 'movement', source: 'selene',
      startAt: '2026-08-07T01:00:00.000+08:00', endAt: '2026-08-07T01:20:00.000+08:00',
      title: 'Continuous movement', capturedAt: '2026-08-07T01:20:00.000+08:00', privacy: 'coarse',
      values: { distanceMeters: 1800, averageSpeedMps: 1.5 },
    }],
  }
}

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for SELENE inbox import')
}

test('THEIA imports a configured SELENE inbox through the shared-state lock', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'theia-selene-server-'))
  const inbox = join(root, 'selene-inbox')
  const snapshotDirectory = join(inbox, 'SELENE-v1-20260807T010000000Z')
  await mkdir(snapshotDirectory, { recursive: true })
  const snapshotPath = join(snapshotDirectory, 'context-events.json')
  await writeFile(snapshotPath, JSON.stringify(document()), 'utf8')
  const old = new Date(Date.now() - 3_000)
  await utimes(snapshotPath, old, old)

  process.env.THEIA_RUNTIME_ROOT = root
  process.env.THEIA_RELEASE_LAYOUT = '1'
  process.env.THEIA_SELENE_INBOX = inbox
  process.env.THEIA_SELENE_SYNC_SETTLE_MS = '1000'
  process.env.AI_PORT = '0'

  const { versionSharedState } = await import('../server/schemaMigrations.mjs')
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(join(root, 'data', 'state.json'), JSON.stringify(versionSharedState({
    updatedAt: '2026-08-07T00:00:00.000Z',
    data: { quests: [], people: [], dailyCheckins: [], contextEvents: [], archive: {} },
  })), 'utf8')

  const { server, startAiProxy } = await import('../server/index.mjs')
  await startAiProxy()
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const state = await waitFor(async () => {
    const response = await fetch(`${base}/api/sync/snapshot`)
    const payload = await response.json()
    return payload.data?.contextEvents?.find((event) => event.id === 'movement-server-test')
  })
  assert.equal(state.kind, 'movement')
  assert.equal(state.sourceFile, 'android/SELENE-v1-20260807T010000000Z/context-events.json')

  const status = await fetch(`${base}/api/selene-sync/status`).then((response) => response.json())
  assert.equal(status.enabled, true)
  assert.equal(status.lastError, null)
})

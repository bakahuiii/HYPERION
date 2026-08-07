import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSeleneInboxWatcher, normalizeSeleneDocument } from '../server/seleneInbox.mjs'

function snapshot(events, platform = 'android') {
  return {
    schema: 'selene-context-events/v1',
    device: { platform },
    generatedAt: '2026-08-07T02:00:00.000+08:00',
    producer: { name: 'SELENE', version: '0.3.0', layout: 'immutable-snapshot-v1' },
    events,
  }
}

function movementEvent() {
  return {
    id: 'movement-1', version: 1, kind: 'movement', source: 'selene',
    startAt: '2026-08-07T01:00:00.000+08:00', endAt: '2026-08-07T01:30:00.000+08:00',
    title: 'Continuous movement', capturedAt: '2026-08-07T01:30:00.000+08:00', privacy: 'coarse',
    values: { distanceMeters: 2400, averageSpeedMps: 1.33 },
  }
}

test('normalizes SELENE movement while retaining precise coordinates only behind consent', () => {
  const normalized = normalizeSeleneDocument(snapshot([movementEvent(), {
    id: 'point-1', version: 1, kind: 'location', source: 'selene', startAt: '2026-08-07T01:02:00.000+08:00',
    title: 'Movement track point', capturedAt: '2026-08-07T01:02:00.000+08:00', privacy: 'precise',
    location: { latitude: 31.2, longitude: 121.4, accuracyMeters: 8 },
    locationConsent: { exactLocation: true, captureMode: 'foreground', grantedAt: '2026-08-07T00:00:00.000+08:00' },
  }]), { sourceFile: 'android/SELENE-v1-1/context-events.json', importedAt: '2026-08-07T02:00:00.000Z' })

  assert.ok(normalized)
  assert.equal(normalized.events[0].kind, 'movement')
  assert.equal(normalized.events[0].sourceFile, 'android/SELENE-v1-1/context-events.json')
  assert.equal(normalized.events[1].privacy, 'precise')
  assert.deepEqual(normalized.events[1].location, { latitude: 31.2, longitude: 121.4, accuracyMeters: 8 })

  const withoutConsent = normalizeSeleneDocument(snapshot([{
    id: 'point-2', version: 1, kind: 'location', source: 'selene', startAt: '2026-08-07T01:03:00.000+08:00',
    title: 'Movement track point', capturedAt: '2026-08-07T01:03:00.000+08:00', privacy: 'precise',
    location: { latitude: 31.2, longitude: 121.4 },
  }]), { sourceFile: 'android/SELENE-v1-2/context-events.json' })
  assert.equal(withoutConsent.events[0].privacy, 'coarse')
  assert.equal(withoutConsent.events[0].location, undefined)
})

test('imports a completed immutable snapshot once and retries a partial file', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-selene-inbox-'))
  const inbox = join(root, 'inbox')
  const statePath = join(root, 'state', 'selene-inbox.json')
  const firstDirectory = join(inbox, 'SELENE-v1-20260806T170000000Z')
  const partialDirectory = join(inbox, 'SELENE-v1-20260806T170100000Z')
  await mkdir(firstDirectory, { recursive: true })
  await mkdir(partialDirectory, { recursive: true })
  const firstFile = join(firstDirectory, 'context-events.json')
  const partialFile = join(partialDirectory, 'context-events.json')
  await writeFile(firstFile, JSON.stringify(snapshot([movementEvent()])), 'utf8')
  await writeFile(partialFile, '{', 'utf8')
  const old = new Date(Date.now() - 3_000)
  await utimes(firstFile, old, old)
  await utimes(partialFile, old, old)

  const imported = []
  const watcher = createSeleneInboxWatcher({
    directory: inbox,
    statePath,
    settleMs: 1_000,
    intervalMs: 5_000,
    onImport: async (events, metadata) => {
      imported.push({ events, metadata })
      return { added: events.length }
    },
  })
  context.after(() => {
    watcher.stop()
    return rm(root, { recursive: true, force: true })
  })

  const firstStatus = await watcher.start()
  assert.equal(imported.length, 1)
  assert.equal(imported[0].events[0].kind, 'movement')
  assert.equal(imported[0].metadata.platform, 'android')
  assert.equal(firstStatus.pendingFiles, 1)
  assert.equal(firstStatus.processedFiles, 1)

  await watcher.scan()
  assert.equal(imported.length, 1)

  await writeFile(partialFile, JSON.stringify(snapshot([{
    ...movementEvent(), id: 'movement-2', startAt: '2026-08-07T03:00:00.000+08:00', endAt: '2026-08-07T03:20:00.000+08:00',
  }])), 'utf8')
  await utimes(partialFile, old, old)
  const secondStatus = await watcher.scan()
  assert.equal(imported.length, 2)
  assert.equal(secondStatus.processedFiles, 1)

  const persisted = await readFile(statePath, 'utf8')
  assert.doesNotMatch(persisted, /latitude|longitude|distanceMeters/)

  const restartedImports = []
  const restarted = createSeleneInboxWatcher({
    directory: inbox,
    statePath,
    settleMs: 1_000,
    intervalMs: 5_000,
    onImport: async (events) => {
      restartedImports.push(events)
      return { added: events.length }
    },
  })
  context.after(() => restarted.stop())
  await restarted.start()
  assert.equal(restartedImports.length, 0)
})

test('keeps a completed snapshot pending while HYPERION shared state initializes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-selene-startup-'))
  const inbox = join(root, 'inbox')
  const statePath = join(root, 'state', 'selene-inbox.json')
  const snapshotDirectory = join(inbox, 'SELENE-v1-20260807T020000000Z')
  const snapshotPath = join(snapshotDirectory, 'context-events.json')
  await mkdir(snapshotDirectory, { recursive: true })
  await writeFile(snapshotPath, JSON.stringify(snapshot([movementEvent()])), 'utf8')
  const old = new Date(Date.now() - 3_000)
  await utimes(snapshotPath, old, old)

  let ready = false
  let imports = 0
  const warnings = []
  const watcher = createSeleneInboxWatcher({
    directory: inbox,
    statePath,
    settleMs: 1_000,
    intervalMs: 5_000,
    logger: (level, message) => warnings.push({ level, message }),
    onImport: async (events) => {
      imports += 1
      if (!ready) throw Object.assign(new Error('Shared state is starting'), { code: 'HYPERION_STATE_UNINITIALIZED' })
      return { added: events.length }
    },
  })
  context.after(() => {
    watcher.stop()
    return rm(root, { recursive: true, force: true })
  })

  const waiting = await watcher.start()
  assert.equal(imports, 1)
  assert.equal(waiting.lastError, null)
  assert.equal(waiting.processedFiles, 0)
  assert.equal(warnings.length, 0)

  ready = true
  const imported = await watcher.scan()
  assert.equal(imports, 2)
  assert.equal(imported.processedFiles, 1)
  assert.equal(imported.lastError, null)
})

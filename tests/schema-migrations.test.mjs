import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSharedStateBackups, migrateSharedStateFile, restoreSharedStateBackup, SHARED_STATE_SCHEMA } from '../server/schemaMigrations.mjs'
import { migrateRuntimePaths } from '../server/runtimePaths.mjs'

test('shared state migration creates a rollback backup and is idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-schema-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, 'state.json')
  const backupDirectory = join(root, 'migrations')
  const legacy = { updatedAt: '2026-08-04T00:00:00.000Z', data: { quests: [{ id: 'q1' }] } }
  await writeFile(statePath, JSON.stringify(legacy))
  const migrated = await migrateSharedStateFile(statePath, backupDirectory)
  assert.equal(migrated.migrated, true)
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schema, SHARED_STATE_SCHEMA)
  assert.equal((await listSharedStateBackups(backupDirectory)).length, 1)
  assert.deepEqual(await migrateSharedStateFile(statePath, backupDirectory), { migrated: false, reason: 'current' })
})
test('rollback restores the selected legacy snapshot and preserves the current state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-schema-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, 'state.json')
  const backupDirectory = join(root, 'migrations')
  await writeFile(statePath, JSON.stringify({ updatedAt: 'old', data: { quests: [{ id: 'old' }] } }))
  await migrateSharedStateFile(statePath, backupDirectory)
  const [backup] = await listSharedStateBackups(backupDirectory)
  await writeFile(statePath, JSON.stringify({ schema: SHARED_STATE_SCHEMA, schemaVersion: 1, updatedAt: 'new', data: { quests: [{ id: 'new' }] } }))
  const restored = await restoreSharedStateBackup(statePath, backupDirectory, backup)
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).data.quests[0].id, 'old')
  assert.equal(JSON.parse(await readFile(restored.safetyPath, 'utf8')).data.quests[0].id, 'new')
})

test('runtime migration moves only missing HYPERION destinations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldState = join(root, '.theia-state.json')
  const newState = join(root, '.hyperion-state.json')
  const oldSettings = join(root, '.theia-settings.ini')
  const newSettings = join(root, '.hyperion-settings.ini')
  await writeFile(oldState, 'legacy state')
  await writeFile(oldSettings, 'legacy settings')
  await writeFile(newSettings, 'new settings')

  const result = await migrateRuntimePaths(
    { sharedStatePath: oldState, settingsPath: oldSettings },
    { sharedStatePath: newState, settingsPath: newSettings },
  )

  assert.deepEqual(result.migrated, ['sharedStatePath'])
  assert.deepEqual(result.skipped, ['settingsPath'])
  assert.equal(await readFile(newState, 'utf8'), 'legacy state')
  assert.equal(await readFile(newSettings, 'utf8'), 'new settings')
})

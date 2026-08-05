import assert from 'node:assert/strict'
import test from 'node:test'

import { createSeedData } from '../src/seed.ts'
import { APP_STORAGE_SCHEMA, APP_STORAGE_SCHEMA_VERSION, unwrapAppStorage, wrapAppStorage } from '../src/lib/storageSchema.ts'
import { loadData, resetData, restoreRollbackData, saveData } from '../src/lib/storage.ts'
import { compactIntelItem, compactIntelItems } from '../src/lib/intelPersistence.ts'
import { planIntelDelta } from '../src/lib/intelDelta.ts'
import { PERSON_PORTRAIT_PIPELINE_VERSION } from '../src/lib/personTemporal.ts'

const values = new Map()
globalThis.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null },
  setItem(key, value) { values.set(key, String(value)) },
  removeItem(key) { values.delete(key) },
  clear() { values.clear() },
}

test.beforeEach(() => values.clear())

test('storage envelope is versioned and preserves legacy payloads', () => {
  const payload = { profile: { name: 'A' } }
  const envelope = wrapAppStorage(payload, '2026-08-04T00:00:00.000Z')
  assert.equal(envelope.schema, APP_STORAGE_SCHEMA)
  assert.equal(envelope.schemaVersion, APP_STORAGE_SCHEMA_VERSION)
  assert.deepEqual(unwrapAppStorage(envelope), { data: payload, schemaVersion: 1 })
  assert.deepEqual(unwrapAppStorage(payload), { data: payload, schemaVersion: 1, migratedFrom: 0 })
})

test('saveData writes a versioned compact dashboard snapshot', () => {
  const data = createSeedData()
  data.intel = [{ id: 'raw', source: 'test', content: 'secret', summary: 'secret', title: 'secret', capturedAt: '', status: 'new' }]
  saveData(data)
  const stored = JSON.parse(values.get('theia:v1'))
  assert.equal(stored.schema, APP_STORAGE_SCHEMA)
  assert.equal(stored.schemaVersion, 1)
  assert.deepEqual(stored.data.intel, [])
})

test('loading a legacy payload keeps a rollback copy before migration', () => {
  const legacy = createSeedData()
  legacy.profile.name = 'Legacy user'
  values.set('theia:v1', JSON.stringify(legacy))
  const loaded = loadData()
  assert.equal(loaded.profile.name, 'Legacy user')
  assert.equal(JSON.parse(values.get('theia:v1:rollback')).profile.name, 'Legacy user')
  assert.equal(restoreRollbackData(), true)
  assert.equal(JSON.parse(values.get('theia:v1')).profile.name, 'Legacy user')
})

test('current structured person portraits survive a storage round trip', () => {
  const data = createSeedData()
  const person = data.people[0]
  person.evidence = [{
    id: 'claim-current',
    kind: 'preference',
    text: '对方曾表示喜欢散步',
    quote: '我喜欢散步',
    sourceIds: ['message-current', 'message-supporting'],
    category: 'preference',
    portraitEligible: true,
  }]
  person.portrait = '对方平时愿意通过散步放松，也会在聊天里直接表达自己的偏好。'
  person.portraitBlocks = [{
    text: person.portrait,
    claimIds: ['claim-current'],
    sourceIds: ['message-current', 'message-supporting'],
    reason: 'preference',
  }]
  person.portraitSchemaVersion = PERSON_PORTRAIT_PIPELINE_VERSION
  person.portraitSourceIds = ['message-current', 'message-supporting']
  person.portraitEvidenceSignature = 'portrait-v4-signature'

  saveData(data)
  const loaded = loadData()
  const restored = loaded.people.find((item) => item.id === person.id)

  assert.equal(restored?.portrait, person.portrait)
  assert.equal(restored?.portraitSchemaVersion, PERSON_PORTRAIT_PIPELINE_VERSION)
  assert.equal(restored?.portraitEvidenceSignature, 'portrait-v4-signature')
  assert.equal(restored?.portraitBlocks?.length, 1)
})

test('resetData clears the current snapshot and rollback copy', () => {
  saveData(createSeedData())
  values.set('theia:v1:rollback', '{}')
  resetData()
  assert.equal(values.get('theia:v1'), undefined)
  assert.equal(values.get('theia:v1:rollback'), undefined)
})

test('single-record signatures use the same compact form as bulk archive writes', () => {
  const item = {
    id: 'message-1',
    source: 'wechat',
    content: 'hello',
    title: 'derived title',
    summary: 'derived summary',
    capturedAt: '2026-08-04T10:00:00.000Z',
    status: 'new',
  }
  assert.deepEqual(compactIntelItems([item]), [compactIntelItem(item)])
})

test('intel delta planning emits only changed and removed records', () => {
  const previous = new Map([
    ['a', JSON.stringify({ id: 'a', content: 'one' })],
    ['b', JSON.stringify({ id: 'b', content: 'two' })],
  ])
  const plan = planIntelDelta(previous, [
    { id: 'a', content: 'updated' },
    { id: 'c', content: 'new' },
  ])
  assert.deepEqual(plan.upserts.map((item) => item.id), ['a', 'c'])
  assert.deepEqual(plan.deleteIds, ['b'])
  assert.deepEqual([...plan.nextSignatures.keys()], ['a', 'c'])
})

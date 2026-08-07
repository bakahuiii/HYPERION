import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { ARCHIVE_STORE_SCHEMA, createAppendOnlyArchiveStore } from '../server/archiveStore.mjs'

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-archive-store-'))
  const directory = join(root, 'archive')
  const metadataPath = join(root, 'archive.meta.json')
  const legacyCompressedPath = join(root, 'legacy.json.gz')
  const legacyJsonPath = join(root, 'legacy.json')
  const store = createAppendOnlyArchiveStore({ directory, metadataPath, legacyCompressedPath, legacyJsonPath, ...options })
  return { root, directory, metadataPath, legacyCompressedPath, legacyJsonPath, store }
}

test('append-only archive writes deltas and preserves current snapshot', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const first = await scope.store.commit({ items: [{ id: 'a', content: 'one', title: 'derived', summary: 'derived' }], sourceFingerprint: 'v1' })
  const second = await scope.store.commit({ expectedUpdatedAt: first.updatedAt, items: [{ id: 'a', content: 'two' }, { id: 'b', content: 'three' }], sourceFingerprint: 'v2' })
  assert.equal(second.recordCount, 2)
  assert.equal(second.updatedAt > first.updatedAt, true)
  assert.equal((await readdir(scope.directory)).filter((name) => name.endsWith('.jsonl.gz')).length, 2)
  assert.deepEqual((await scope.store.loadSnapshot()).items, [{ id: 'a', content: 'two' }, { id: 'b', content: 'three' }])
  const metadata = JSON.parse(await readFile(scope.metadataPath, 'utf8'))
  assert.equal(metadata.schema, ARCHIVE_STORE_SCHEMA)
  assert.equal(metadata.storageEngine, 'append-only-jsonl-gzip')
})

test('optimistic writes reject a stale archive version', async (t) => {
  const scope = await fixture()
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const first = await scope.store.commit({ items: [{ id: 'a', content: 'one' }] })
  await assert.rejects(
    scope.store.commit({ expectedUpdatedAt: null, items: [{ id: 'b', content: 'two' }] }),
    (error) => error?.statusCode === 409 && error?.currentUpdatedAt === first.updatedAt,
  )
})

test('delta commits append only changed records and preserve deletions', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const first = await scope.store.commit({ items: [
    { id: 'a', content: 'one' },
    { id: 'b', content: 'two' },
  ], sourceFingerprint: 'v1' })
  const second = await scope.store.commitDelta({
    expectedUpdatedAt: first.updatedAt,
    upserts: [{ id: 'a', content: 'updated' }],
    deleteIds: ['b'],
    sourceFingerprint: 'v2',
  })
  assert.equal(second.recordCount, 1)
  assert.deepEqual((await scope.store.loadSnapshot()).items, [{ id: 'a', content: 'updated' }])
  assert.equal((await readdir(scope.directory)).filter((name) => name.endsWith('.jsonl.gz')).length, 2)
})

test('archives MNEMO counts in metadata and ignores transport envelope changes', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const initial = await scope.store.commitDelta({
    upserts: [
      { id: 'mnemo:wxid_owner:messages:1', sourceFile: 'mnemo://wxid_owner/old-batch', content: 'Hello' },
      { id: 'journal-1', sourceFile: 'hyperion://self-journal', content: 'Keep this note' },
    ],
    deleteIds: [],
  })
  assert.equal(initial.mnemoRecordCount, 1)
  assert.equal((await scope.store.loadMeta()).mnemoRecordCount, 1)

  const repeated = await scope.store.commitDelta({
    expectedUpdatedAt: initial.updatedAt,
    upserts: [{ id: 'mnemo:wxid_owner:messages:1', sourceFile: 'mnemo://wxid_owner/new-batch', content: 'Hello' }],
    deleteIds: [],
  })
  assert.equal(repeated.updatedAt, initial.updatedAt)
  assert.equal(repeated.mnemoRecordCount, 1)
  assert.equal((await readdir(scope.directory)).filter((name) => name.endsWith('.jsonl.gz')).length, 1)
})

test('authoritative chat snapshots preserve local manual records until an explicit delta delete', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const first = await scope.store.commit({ items: [
    { id: 'chat-1', source: 'wechat', sourceFile: 'chat.json', content: 'Imported chat row.' },
    { id: 'journal-1', source: 'manual', sourceFile: 'hyperion://self-journal', conversationId: 'self-journal', content: 'Keep this journal entry.' },
  ] })
  const refreshed = await scope.store.commit({
    expectedUpdatedAt: first.updatedAt,
    items: [{ id: 'chat-2', source: 'wechat', sourceFile: 'chat.json', content: 'Replacement directory row.' }],
  })
  assert.equal(refreshed.recordCount, 2)
  assert.deepEqual((await scope.store.loadSnapshot()).items.map((item) => item.id).sort(), ['chat-2', 'journal-1'])
  const removed = await scope.store.commitDelta({
    expectedUpdatedAt: refreshed.updatedAt,
    upserts: [],
    deleteIds: ['journal-1'],
  })
  assert.equal(removed.recordCount, 1)
  assert.deepEqual((await scope.store.loadSnapshot()).items.map((item) => item.id), ['chat-2'])
})

test('archive changes return only delta operations after a watermark', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const first = await scope.store.commit({ items: [{ id: 'old', content: 'kept' }] })
  const second = await scope.store.commitDelta({
    expectedUpdatedAt: first.updatedAt,
    upserts: [{ id: 'journal', content: 'new self note', conversationId: 'self-journal', speakerRole: 'self' }],
    deleteIds: ['old'],
  })
  const changes = await scope.store.loadChanges({ since: first.updatedAt })
  assert.equal(changes.requiresReload, false)
  assert.equal(changes.updatedAt, second.updatedAt)
  assert.deepEqual(changes.upserts, [{ id: 'journal', content: 'new self note', conversationId: 'self-journal', speakerRole: 'self' }])
  assert.deepEqual(changes.deleteIds, ['old'])
})

test('archive changes require a safe reload across a snapshot boundary', async (t) => {
  const scope = await fixture({ compactionSegments: 2 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const first = await scope.store.commit({ items: [{ id: 'a', content: 'one' }] })
  await scope.store.commit({ expectedUpdatedAt: first.updatedAt, items: [{ id: 'a', content: 'two' }] })
  const changes = await scope.store.loadChanges({ since: first.updatedAt })
  assert.equal(changes.requiresReload, true)
  assert.deepEqual(changes.upserts, [])
})

test('unchanged delta is a no-op and does not create an empty archive segment', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const first = await scope.store.commit({ items: [{ id: 'a', content: 'one' }], sourceFingerprint: 'v1' })
  const repeated = await scope.store.commitDelta({
    expectedUpdatedAt: first.updatedAt,
    upserts: [{ id: 'a', content: 'one' }],
    deleteIds: ['missing', 'a'],
    sourceFingerprint: 'v1',
  })
  assert.deepEqual(repeated, first)
  assert.equal((await readdir(scope.directory)).filter((name) => name.endsWith('.jsonl.gz')).length, 1)
})

test('archive rebuilds its checksum index when metadata is absent', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  await scope.store.commit({ items: [{ id: 'a', content: 'one' }] })
  await unlink(scope.metadataPath)
  const recovered = createAppendOnlyArchiveStore({
    directory: scope.directory,
    metadataPath: scope.metadataPath,
    legacyCompressedPath: scope.legacyCompressedPath,
    legacyJsonPath: scope.legacyJsonPath,
    compactionSegments: 20,
  })
  const recoveredMeta = await recovered.loadMeta()
  assert.equal(recoveredMeta.integrity.status, 'recovered-unindexed')
  await recovered.commitDelta({ upserts: [{ id: 'b', content: 'two' }], deleteIds: [] })
  const verified = await recovered.verifyIntegrity()
  assert.equal(verified.integrity.status, 'verified')
  assert.deepEqual((await recovered.loadSnapshot()).items, [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }])
})

test('loads a verified THEIA v1 segment after the HYPERION rename', async (t) => {
  const scope = await fixture()
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  await mkdir(scope.directory, { recursive: true })
  await writeFile(join(scope.directory, '0000000001-20260807000000000.jsonl.gz'), gzipSync(Buffer.from([
    JSON.stringify({ schema: 'theia-intel-archive/v1', schemaVersion: 1, kind: 'snapshot', updatedAt: '2026-08-07T00:00:00.000Z', sourceFingerprint: 'legacy' }),
    JSON.stringify({ op: 'upsert', item: { id: 'legacy-a', content: 'kept' } }),
    '',
  ].join('\n'))))
  assert.deepEqual((await scope.store.loadSnapshot()).items, [{ id: 'legacy-a', content: 'kept' }])
})

test('rejects an archive segment with an unknown schema', async (t) => {
  const scope = await fixture()
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  await mkdir(scope.directory, { recursive: true })
  await writeFile(join(scope.directory, '0000000001-20260807000000000.jsonl.gz'), gzipSync(Buffer.from([
    JSON.stringify({ schema: 'unknown-intel-archive/v1', schemaVersion: 1, kind: 'snapshot', updatedAt: '2026-08-07T00:00:00.000Z', sourceFingerprint: null }),
    JSON.stringify({ op: 'upsert', item: { id: 'invalid', content: 'not accepted' } }),
    '',
  ].join('\n'))))
  await assert.rejects(scope.store.loadSnapshot(), /schema/)
})

test('checksum index detects a valid-looking but replaced segment before serving data', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  await scope.store.commit({ items: [{ id: 'a', content: 'one' }] })
  const name = (await readdir(scope.directory)).find((entry) => entry.endsWith('.jsonl.gz'))
  assert.ok(name)
  // This remains valid gzip and JSONL, so a checksum is needed to distinguish
  // an unexpected replacement from ordinary compression corruption.
  await writeFile(join(scope.directory, name), gzipSync(Buffer.from([
    JSON.stringify({ schema: ARCHIVE_STORE_SCHEMA, schemaVersion: 1, kind: 'snapshot', updatedAt: '2026-08-05T00:00:00.000Z', sourceFingerprint: null }),
    JSON.stringify({ op: 'upsert', item: { id: 'a', content: 'tampered' } }),
    '',
  ].join('\n'))))
  const reopened = createAppendOnlyArchiveStore({
    directory: scope.directory,
    metadataPath: scope.metadataPath,
    legacyCompressedPath: scope.legacyCompressedPath,
    legacyJsonPath: scope.legacyJsonPath,
  })
  await assert.rejects(reopened.loadSnapshot(), /校验和不匹配/)
})

test('conversation index and pages keep large archive reads bounded', async (t) => {
  const scope = await fixture({ compactionSegments: 20 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  await scope.store.commit({ items: [
    { id: 'a1', source: 'wechat', conversationId: 'alice', conversationName: 'Alice', conversationKind: 'direct', capturedAt: '2026-08-01T09:00:00.000Z', speakerRole: 'other', content: 'counterpart preview' },
    { id: 'a2', source: 'wechat', conversationId: 'alice', conversationName: 'Alice', conversationKind: 'direct', capturedAt: '2026-08-03T09:00:00.000Z', speakerRole: 'self', content: 'self last message' },
    { id: 'b1', source: 'qq', conversationId: 'group', conversationName: 'Study group', conversationKind: 'group', capturedAt: '2026-08-02T09:00:00.000Z', content: 'group' },
  ] })
  const firstPage = await scope.store.loadConversationIndex({ limit: 1 })
  assert.equal(firstPage.totalConversations, 2)
  assert.equal(firstPage.items[0].id, 'alice')
  assert.equal(firstPage.items[0].latestPreview.content, 'counterpart preview')
  assert.ok(firstPage.nextCursor)
  const secondPage = await scope.store.loadConversationIndex({ limit: 1, cursor: firstPage.nextCursor })
  assert.deepEqual(secondPage.items.map((item) => item.id), ['group'])
  const records = await scope.store.loadConversationPage('alice', { limit: 1 })
  assert.equal(records.totalRecords, 2)
  assert.deepEqual(records.items.map((item) => item.id), ['a1'])
  assert.ok(records.nextCursor)
  const laterRecords = await scope.store.loadConversationPage('alice', { limit: 1, cursor: records.nextCursor })
  assert.deepEqual(laterRecords.items.map((item) => item.id), ['a2'])
})

test('legacy gzip migration keeps the rollback file and creates a v1 segment', async (t) => {
  const scope = await fixture()
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  await writeFile(scope.legacyCompressedPath, gzipSync(Buffer.from(JSON.stringify({
    updatedAt: '2026-08-04T00:00:00.000Z',
    sourceFingerprint: 'legacy',
    items: [{ id: 'legacy-a', content: 'kept' }],
  }))))
  assert.equal((await scope.store.loadMeta()).recordCount, 1)
  assert.equal(await scope.store.migrate(), true)
  assert.equal((await readFile(scope.legacyCompressedPath)).length > 0, true)
  assert.equal((await readdir(scope.directory)).filter((name) => name.endsWith('.jsonl.gz')).length, 1)
  assert.deepEqual((await scope.store.loadSnapshot()).items, [{ id: 'legacy-a', content: 'kept' }])
})

test('compaction replaces many deltas with one complete snapshot', async (t) => {
  const scope = await fixture({ compactionSegments: 3 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  let updatedAt = null
  for (let index = 0; index < 3; index += 1) {
    const saved = await scope.store.commit({ expectedUpdatedAt: updatedAt, items: [{ id: 'a', content: `value-${index}` }] })
    updatedAt = saved.updatedAt
  }
  assert.equal((await readdir(scope.directory)).filter((name) => name.endsWith('.jsonl.gz')).length, 1)
  assert.deepEqual((await scope.store.loadSnapshot()).items, [{ id: 'a', content: 'value-2' }])
})

test('clearing a large archive compacts obsolete chat segments immediately', async (t) => {
  const scope = await fixture({ compactionSegments: 99 })
  t.after(() => rm(scope.root, { recursive: true, force: true }))
  const items = Array.from({ length: 10_000 }, (_, index) => ({ id: `message-${index}`, content: `message ${index}` }))
  const first = await scope.store.commit({ items })
  await scope.store.commit({ expectedUpdatedAt: first.updatedAt, items: [] })
  assert.equal((await readdir(scope.directory)).filter((name) => name.endsWith('.jsonl.gz')).length, 1)
  assert.deepEqual((await scope.store.loadSnapshot()).items, [])
})

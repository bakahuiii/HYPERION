import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { ARCHIVE_STORE_SCHEMA, createAppendOnlyArchiveStore } from '../server/archiveStore.mjs'

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'theia-archive-store-'))
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

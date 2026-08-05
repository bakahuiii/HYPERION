import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createAppendOnlyArchiveStore } from '../server/archiveStore.mjs'

function argument(name, fallback) {
  const prefix = `--${name}=`
  const value = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length)
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function bytes(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

const records = Math.min(1_000_000, argument('records', 25_000))
const batchSize = Math.min(25_000, argument('batch-size', 5_000))
const root = await mkdtemp(join(tmpdir(), 'theia-archive-benchmark-'))
const options = {
  directory: join(root, 'archive'),
  metadataPath: join(root, 'archive.meta.json'),
  legacyCompressedPath: join(root, 'legacy.json.gz'),
  legacyJsonPath: join(root, 'legacy.json'),
}

function batch(start, count) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset
    const conversation = `direct-${Math.floor(index / 240)}`
    return {
      id: `benchmark-${index}`,
      source: 'benchmark',
      conversationId: conversation,
      conversationName: `Benchmark ${Math.floor(index / 240)}`,
      conversationKind: 'direct',
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 60), index % 60)).toISOString(),
      content: `Synthetic message ${index}; generated only for THEIA archive throughput measurement.`,
      speakerRole: index % 2 ? 'other' : 'self',
      status: 'new',
    }
  })
}

try {
  const startedAt = performance.now()
  const store = createAppendOnlyArchiveStore(options)
  let saved = await store.commit({ items: batch(0, Math.min(records, batchSize)), sourceFingerprint: `benchmark-${records}` })
  for (let start = batchSize; start < records; start += batchSize) {
    const upserts = batch(start, Math.min(batchSize, records - start))
    saved = await store.commitDelta({ expectedUpdatedAt: saved.updatedAt, upserts, deleteIds: [] })
  }
  const writeMs = performance.now() - startedAt
  const coldStartAt = performance.now()
  const reopened = createAppendOnlyArchiveStore(options)
  const meta = await reopened.loadMeta()
  const conversations = await reopened.loadConversationIndex({ limit: 25 })
  const firstConversation = conversations.items[0]
  const firstPage = firstConversation ? await reopened.loadConversationPage(firstConversation.id, { limit: 200 }) : null
  const verified = await reopened.verifyIntegrity()
  const readMs = performance.now() - coldStartAt
  const memory = process.memoryUsage()
  console.log(JSON.stringify({
    records,
    batchSize,
    writeMs: Math.round(writeMs),
    coldReadAndVerifyMs: Math.round(readMs),
    recordCount: meta.recordCount,
    segmentCount: meta.segmentCount,
    integrity: verified.integrity.status,
    conversationPageRecords: firstPage?.items.length ?? 0,
    heapUsed: bytes(memory.heapUsed),
    rss: bytes(memory.rss),
  }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}

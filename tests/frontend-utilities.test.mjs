import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateAttachmentQueue } from '../src/lib/attachmentQueue.ts'
import { parseIntelFile } from '../src/lib/importer.ts'
import { incrementalConversationRecords } from '../src/lib/intelConversationView.ts'
import { relativeInteractionLabel, summarizePersonInteraction } from '../src/lib/personInteraction.ts'
import { isHumanCenteredAdvice, interpersonalAdviceRisk } from '../src/lib/interpersonalSafety.ts'
import { normalizeMapSettings } from '../server/settings.mjs'

test('attachment queue separates text estimates from provider-priced media', () => {
  const estimate = estimateAttachmentQueue([
    { name: 'chat.json', size: 3_001, type: 'application/json' },
    { name: 'notes.md', size: 300, type: '' },
    { name: 'photo.PNG', size: 8_000, type: '' },
    { name: 'archive.pdf', size: 12_000, type: 'application/pdf' },
    { name: 'negative.txt', size: -1, type: 'text/plain' },
  ])

  assert.deepEqual(estimate, {
    fileCount: 5,
    totalBytes: 23_301,
    estimatedTextTokens: 1_101,
    imageCount: 1,
    binaryDocumentCount: 1,
  })
})

test('map configuration rejects unknown providers and clamps cache limits', () => {
  const low = normalizeMapSettings({
    tileProvider: 'unknown',
    searchProvider: 'unknown',
    cacheMaxMb: -200,
  })
  assert.equal(low.tileProvider, 'osm-de')
  assert.equal(low.searchProvider, 'balanced')
  assert.equal(low.cacheMaxMb, 32)
  assert.equal(normalizeMapSettings({ cacheMaxMb: 2_000 }).cacheMaxMb, 1024)
  assert.equal(normalizeMapSettings({ cacheMaxMb: 127.6 }).cacheMaxMb, 128)
})

test('large imports use the worker path and terminate it after a response', async () => {
  const previousWorker = globalThis.Worker
  let terminated = false
  let posted
  class FakeWorker {
    constructor(url, options) {
      assert.match(String(url), /intelParser\.worker\.ts$/)
      assert.deepEqual(options, { type: 'module', name: 'theia-intel-parser' })
    }

    postMessage(payload) {
      posted = payload
      queueMicrotask(() => this.onmessage({ data: { items: [{ id: 'from-worker' }] } }))
    }

    terminate() { terminated = true }
  }
  globalThis.Worker = FakeWorker

  try {
    const file = { name: 'large.json', size: 1024 * 1024, async text() { return 'unused' } }
    const items = await parseIntelFile(file, { path: '私聊/A/messages.json' })
    assert.deepEqual(items, [{ id: 'from-worker' }])
    assert.equal(posted.file, file)
    assert.deepEqual(posted.context, { path: '私聊/A/messages.json' })
    assert.equal(terminated, true)
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = previousWorker
  }
})

test('small imports stay on the direct parser path', async () => {
  const previousWorker = globalThis.Worker
  let constructed = false
  globalThis.Worker = class { constructor() { constructed = true } }
  const raw = JSON.stringify([{
    formattedTime: '2026-08-03 10:00:00',
    type: 'incoming',
    content: 'direct parser',
    senderDisplayName: 'A',
  }])

  try {
    const file = { name: 'small.json', size: raw.length, async text() { return raw } }
    const items = await parseIntelFile(file, { path: '私聊/A/messages.json' })
    assert.equal(constructed, false)
    assert.equal(items.length, 1)
    assert.equal(items[0].content, 'direct parser')
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = previousWorker
  }
})

test('incremental people analysis sends only new records and bounded prior context', () => {
  const conversation = Array.from({ length: 30 }, (_, index) => ({
    id: `a-${index}`,
    source: '微信导出',
    conversationId: 'direct:a',
    capturedAt: `2026-08-03T10:${String(index).padStart(2, '0')}:00.000Z`,
  }))
  const unrelated = [{
    id: 'b-0',
    source: '微信导出',
    conversationId: 'direct:b',
    capturedAt: '2026-08-03T11:00:00.000Z',
  }]

  const selected = incrementalConversationRecords([...conversation, ...unrelated], [conversation[29]], 16)
  assert.deepEqual(selected.map((item) => item.id), conversation.slice(13).map((item) => item.id))
  assert.ok(selected.some((item) => item.id === 'a-29'))
  assert.ok(selected.every((item) => item.conversationId === 'direct:a'))
})

test('person interaction summary is factual, deduplicated, and direction-aware', () => {
  const records = [
    { id: 'm-1', conversationId: 'direct:a', capturedAt: '2026-08-01T10:00:00Z', speakerRole: 'other' },
    { id: 'm-2', conversationId: 'direct:a', capturedAt: '2026-08-01T10:01:00Z', speakerRole: 'self' },
    { id: 'm-3', conversationId: 'direct:b', capturedAt: '2026-08-02T10:00:00Z', speakerRole: 'unknown' },
    { id: 'm-3', conversationId: 'direct:b', capturedAt: '2026-08-02T10:00:00Z', speakerRole: 'unknown' },
  ]
  assert.deepEqual(summarizePersonInteraction(records), {
    firstAt: '2026-08-01T10:00:00Z',
    lastAt: '2026-08-02T10:00:00Z',
    totalMessages: 3,
    selfMessages: 1,
    otherMessages: 1,
    unknownMessages: 1,
    conversationCount: 2,
  })
  assert.equal(relativeInteractionLabel('2026-08-05T12:00:00Z', Date.parse('2026-08-05T23:00:00Z')), '今天')
  assert.equal(relativeInteractionLabel('2026-08-01T12:00:00Z', Date.parse('2026-08-05T23:00:00Z')), '4 天前')
  assert.equal(relativeInteractionLabel('2026-08-06T12:00:00Z', Date.parse('2026-08-05T12:00:00Z')), '明天')
})

test('interpersonal advice rejects manipulation and unsupported certainty', () => {
  assert.equal(isHumanCenteredAdvice('先确认对方现在是否方便，并给对方一个拒绝或改期的选择。'), true)
  assert.equal(interpersonalAdviceRisk('故意冷处理几天，让对方吃醋后再联系。'), 'manipulative_or_overconfident')
  assert.equal(interpersonalAdviceRisk('对方肯定喜欢你，可以直接逼对方答应。'), 'manipulative_or_overconfident')
})

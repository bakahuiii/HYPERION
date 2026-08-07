import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateAttachmentQueue } from '../src/lib/attachmentQueue.ts'
import { parseIntelFile } from '../src/lib/importer.ts'
import { incrementalConversationRecords } from '../src/lib/intelConversationView.ts'
import { automaticTriggerIsDue } from '../src/lib/automaticAnalysis.ts'
import { relativeInteractionLabel, summarizePersonInteraction } from '../src/lib/personInteraction.ts'
import { isHumanCenteredAdvice, interpersonalAdviceRisk } from '../src/lib/interpersonalSafety.ts'
import { counterpartIdentityEvidence } from '../src/lib/personCounterpart.ts'
import {
  historicalPortraitTextIsQualified,
  personEvidenceTemporalScope,
  portraitBlockTemporalMetadata,
  selectProfileEvidence,
  summarizePersonEvidenceTime,
} from '../src/lib/personTemporal.ts'
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

test('automatic incremental analysis honors the selected time and message triggers', () => {
  assert.equal(automaticTriggerIsDue('time', true, 0, 50), true)
  assert.equal(automaticTriggerIsDue('time', false, 500, 50), false)
  assert.equal(automaticTriggerIsDue('message-count', true, 49, 50), false)
  assert.equal(automaticTriggerIsDue('message-count', false, 50, 50), true)
  assert.equal(automaticTriggerIsDue('either', true, 0, 50), true)
  assert.equal(automaticTriggerIsDue('either', false, 50, 50), true)
  assert.equal(automaticTriggerIsDue('either', false, 49, 50), false)
  assert.equal(automaticTriggerIsDue('message-count', false, 50, undefined), true)
})

test('large imports use the worker path and terminate it after a response', async () => {
  const previousWorker = globalThis.Worker
  let terminated = false
  let posted
  class FakeWorker {
    constructor(url, options) {
      assert.match(String(url), /intelParser\.worker\.ts$/)
      assert.deepEqual(options, { type: 'module', name: 'hyperion-intel-parser' })
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

test('person portrait time boundaries keep old evidence out of the current profile', () => {
  const analysisAsOf = '2026-08-05T12:00:00.000Z'
  const recent = {
    id: 'recent',
    kind: 'preference',
    text: '曾表示最近在看电影',
    quote: '最近在看电影',
    sourceIds: ['recent-source'],
    evidenceStrength: 'single',
    category: 'preference',
    portraitEligible: true,
    firstObservedAt: '2026-07-30T12:00:00.000Z',
    lastObservedAt: '2026-07-30T12:00:00.000Z',
  }
  const historical = {
    ...recent,
    id: 'historical',
    text: '曾表示过去喜欢跑步',
    quote: '那时候喜欢跑步',
    sourceIds: ['historical-source'],
    firstObservedAt: '2025-05-01T12:00:00.000Z',
    lastObservedAt: '2025-05-01T12:00:00.000Z',
  }

  assert.equal(personEvidenceTemporalScope(recent, analysisAsOf), 'recent')
  assert.equal(personEvidenceTemporalScope(historical, analysisAsOf), 'historical')
  assert.deepEqual(portraitBlockTemporalMetadata([recent], analysisAsOf), {
    temporalScope: 'recent',
    observedFrom: '2026-07-30T12:00:00.000Z',
    observedTo: '2026-07-30T12:00:00.000Z',
  })
  assert.equal(portraitBlockTemporalMetadata([recent, historical], analysisAsOf).temporalScope, 'change')
  assert.equal(historicalPortraitTextIsQualified('她喜欢跑步。'), false)
  assert.equal(historicalPortraitTextIsQualified('她曾表示当时喜欢跑步。'), true)

  const summary = summarizePersonEvidenceTime([recent, historical], analysisAsOf, '2026-08-02T12:00:00.000Z')
  assert.equal(summary.recentClaimCount, 1)
  assert.equal(summary.historicalClaimCount, 1)
  assert.equal(summary.recentEvidenceStatus, 'limited')
  assert.equal(summary.latestInteractionAgeDays, 3)
})

test('person portrait workset retains meaningful middle-period events without truncating the archive', () => {
  const analysisAsOf = '2026-08-05T12:00:00.000Z'
  const routineClaims = Array.from({ length: 140 }, (_, index) => ({
    id: `routine-${index}`,
    kind: index % 2 ? 'fact' : 'preference',
    text: `已核验线索 ${index}`,
    quote: `线索 ${index}`,
    sourceIds: [`source-${index}`],
    evidenceStrength: 'single',
    category: index % 2 ? 'background' : 'preference',
    portraitEligible: true,
    firstObservedAt: `2026-07-${String(1 + (index % 28)).padStart(2, '0')}T12:00:00.000Z`,
    lastObservedAt: `2026-07-${String(1 + (index % 28)).padStart(2, '0')}T12:00:00.000Z`,
  }))
  const mayEvent = {
    id: 'may-27-care-event',
    kind: 'event',
    text: '2026年5月27日，对方曾提醒你不要继续吃坏掉的荔枝，并要求拍照确认',
    quote: '你拍一张我看看',
    sourceIds: ['source-may-27'],
    evidenceStrength: 'single',
    category: 'interaction',
    stability: 'single',
    portraitEligible: true,
    firstObservedAt: '2026-05-27T12:00:00.000Z',
    lastObservedAt: '2026-05-27T12:00:00.000Z',
  }
  const completeArchive = [...routineClaims, mayEvent]
  const workset = selectProfileEvidence(completeArchive, 96, analysisAsOf)

  assert.equal(completeArchive.length, 141)
  assert.equal(workset.length, 96)
  assert.equal(workset.some((claim) => claim.id === mayEvent.id), true)
})

test('interpersonal advice rejects manipulation and unsupported certainty', () => {
  assert.equal(isHumanCenteredAdvice('先确认对方现在是否方便，并给对方一个拒绝或改期的选择。'), true)
  assert.equal(interpersonalAdviceRisk('故意冷处理几天，让对方吃醋后再联系。'), 'manipulative_or_overconfident')
  assert.equal(interpersonalAdviceRisk('对方肯定喜欢你，可以直接逼对方答应。'), 'manipulative_or_overconfident')
})

test('conversation-level counterpart identity supports nameless direct-chat rows without merging named senders', () => {
  const nameless = [
    { speakerRole: 'self' },
    { speakerRole: 'other' },
    { speakerRole: 'other' },
  ]
  const resolved = counterpartIdentityEvidence(nameless, '林晓', '林晓')
  assert.equal(resolved.valid, true)
  assert.equal(resolved.basis, 'conversation')
  assert.equal(resolved.records.length, 2)

  const ambiguous = counterpartIdentityEvidence([
    { speakerRole: 'other', speaker: 'Alice' },
    { speakerRole: 'other', speaker: 'Bob' },
  ], 'Direct folder', 'Direct folder')
  assert.equal(ambiguous.valid, false)

  const named = counterpartIdentityEvidence([
    { speakerRole: 'other', speaker: ' 林晓 ' },
    { speakerRole: 'self', speaker: '你' },
  ], '林晓', 'Direct folder')
  assert.equal(named.valid, true)
  assert.equal(named.basis, 'speaker')
})

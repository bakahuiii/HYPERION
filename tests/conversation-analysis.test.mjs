import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConversationAnalysisPlan, buildPeopleConversationAnalysisPlan } from '../src/lib/conversationAnalysis.ts'
import { buildConversationTimeline, fullConversationRecords, withinStrictTimeRange } from '../src/lib/intelConversationView.ts'

function record(index, conversationId = 'direct:A') {
  return {
    id: `${conversationId}-${index}`,
    source: 'wechat',
    conversationId,
    conversationName: conversationId,
    conversationKind: 'direct',
    capturedAt: `2026-08-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    messageType: 'text',
    content: `message ${index} ${'x'.repeat(index % 19)}`,
    summary: `message ${index}`,
    speaker: index % 2 ? 'A' : '你',
    speakerRole: index % 2 ? 'other' : 'self',
    status: 'new',
  }
}

test('conversation browser groups legacy records by source month and preserves full-session selection', () => {
  const records = [
    record(0, 'direct:A'),
    { ...record(1, ''), id: 'legacy-1', conversationId: '', capturedAt: '2026-07-01T10:00:00.000Z' },
    { ...record(2, ''), id: 'legacy-2', conversationId: '', capturedAt: '2026-07-02T10:00:00.000Z' },
    { ...record(3, ''), id: 'legacy-3', conversationId: '', capturedAt: '2026-08-01T10:00:00.000Z' },
  ]
  const timeline = buildConversationTimeline(records)
  assert.equal(timeline.length, 3)
  const july = timeline.find((conversation) => conversation.id === 'legacy:wechat:2026-07')
  assert.equal(july?.records.length, 2)
  assert.deepEqual(fullConversationRecords(records, [july.records[0]]).map((item) => item.id), ['legacy-1', 'legacy-2'])
  assert.equal(withinStrictTimeRange(july.records[0], '2026-07-01', '2026-07-01'), true)
  assert.equal(withinStrictTimeRange(july.records[1], '2026-07-01', '2026-07-01'), false)
})

test('task segmentation preserves every core record and bounds each request', () => {
  const records = Array.from({ length: 257 }, (_, index) => record(index))
  const plan = buildConversationAnalysisPlan(records, Date.parse('2026-08-20T00:00:00.000Z'))
  const jobs = plan.jobs.filter((job) => job.id === 'direct:A')
  assert.equal(plan.totalConversations, 1)
  assert.equal(plan.recordCount, records.length)
  assert.ok(jobs.length >= 6)
  assert.ok(jobs.every((job) => job.coreRecordCount <= 48 && job.recordCount <= 54))
  assert.deepEqual(new Set(jobs.flatMap((job) => job.coreRecordIds)), new Set(records.map((item) => item.id)))
})

test('custom segment options remain deterministic for tiny conversations', () => {
  const records = Array.from({ length: 7 }, (_, index) => record(index))
  const plan = buildConversationAnalysisPlan(records, Date.parse('2026-08-20T00:00:00.000Z'), {
    coreRecords: 3,
    coreChars: 1_000,
    overlapRecords: 1,
    overlapChars: 200,
  })
  assert.equal(plan.totalSegments, 3)
  assert.deepEqual(plan.jobs.map((job) => job.segmentIndex).sort((a, b) => a - b), [1, 2, 3])
  assert.deepEqual(new Set(plan.jobs.flatMap((job) => job.coreRecordIds)), new Set(records.map((item) => item.id)))
})

test('planner keeps summary-only and non-text rows in the full conversation coverage', () => {
  const records = [
    { ...record(0), content: '', summary: 'summary-only row' },
    { ...record(1), content: 42, summary: 7, title: '' },
  ]
  const plan = buildConversationAnalysisPlan(records, Date.parse('2026-08-20T00:00:00.000Z'))
  assert.equal(plan.recordCount, records.length)
  assert.deepEqual(new Set(plan.jobs.flatMap((job) => job.coreRecordIds)), new Set(records.map((item) => item.id)))
})

test('people segmentation widens the window without changing coverage semantics', () => {
  const records = Array.from({ length: 901 }, (_, index) => record(index, 'direct:people'))
  const plan = buildPeopleConversationAnalysisPlan(records, Date.parse('2026-08-20T00:00:00.000Z'))
  assert.equal(plan.recordCount, records.length)
  assert.ok(plan.jobs.length < 10)
  assert.ok(plan.jobs.every((job) => job.coreRecordCount <= 320 && job.overlapRecordCount <= 16))
  assert.deepEqual(new Set(plan.jobs.flatMap((job) => job.coreRecordIds)), new Set(records.map((item) => item.id)))
})

test('different conversations can be scheduled independently', () => {
  const records = [...Array.from({ length: 3 }, (_, index) => record(index, 'direct:A')), ...Array.from({ length: 3 }, (_, index) => record(index, 'direct:B'))]
  const plan = buildConversationAnalysisPlan(records, Date.parse('2026-08-20T00:00:00.000Z'))
  assert.equal(plan.totalConversations, 2)
  assert.deepEqual(new Set(plan.jobs.map((job) => job.id)), new Set(['direct:A', 'direct:B']))
})

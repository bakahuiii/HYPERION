import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analysisRange,
  buildSelfAnalysisPlan,
  groupSelfObservationsForMerge,
  mergeSelfObservations,
} from '../src/lib/selfAnalysis.ts'

function record(index, content = `record ${index}`) {
  return {
    id: `self-${index}`,
    capturedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    content,
    summary: content,
    source: 'test',
  }
}

function observation(id, observedFrom, sourceId = id) {
  return {
    id,
    kind: 'event',
    text: `Observation ${id}`,
    evidence: [{ sourceId, quote: id }],
    sourceIds: [sourceId],
    observedFrom,
    observedTo: observedFrom,
  }
}

test('self analysis plan covers every chronological core row exactly once while preserving overlap', () => {
  const records = Array.from({ length: 130 }, (_, index) => record(index, `${index} ${'x'.repeat(68)}`))
  const plan = buildSelfAnalysisPlan({ analysisTarget: 'self', generatedAt: '2026-08-06T00:00:00.000Z', records, dailyCheckins: [] })

  const coreIds = plan.jobs.flatMap((job) => job.coreRecordIds)
  assert.equal(plan.recordCount, 130)
  assert.equal(coreIds.length, 130)
  assert.deepEqual(coreIds, records.map((item) => item.id))
  assert.equal(new Set(coreIds).size, 130)
  assert.ok(plan.jobs.length > 1)
  assert.ok(plan.jobs.every((job) => job.coreRecordCount <= 56))
  assert.ok(plan.jobs.slice(1).every((job) => job.overlapRecordCount > 0 && job.overlapRecordCount <= 8))
  assert.equal(plan.jobs[0].overlapRecordCount, 0)
})

test('self analysis plan assigns daily anchors only to their chronological windows', () => {
  const records = [
    { ...record(1), capturedAt: '2026-01-01T08:00:00.000Z' },
    { ...record(2), capturedAt: '2026-01-10T08:00:00.000Z' },
  ]
  const plan = buildSelfAnalysisPlan({
    analysisTarget: 'self', generatedAt: '2026-08-06T00:00:00.000Z', records,
    dailyCheckins: [
      { id: 'jan-1', date: '2026-01-01', medication: 'unknown', alcohol: 'unknown', updatedAt: '2026-01-01T12:00:00.000Z' },
      { id: 'jan-11', date: '2026-01-11', medication: 'unknown', alcohol: 'unknown', updatedAt: '2026-01-11T12:00:00.000Z' },
    ],
  })

  assert.deepEqual(plan.jobs[0].checkIns.map((item) => item.id), ['jan-1'])
})

test('overlapping and retried self observations merge source evidence idempotently', () => {
  const first = observation('same', '2026-01-02T08:00:00.000Z', 'message-a')
  const retried = {
    ...first,
    evidence: [...first.evidence, { sourceId: 'message-b', quote: 'same' }],
    sourceIds: ['message-a', 'message-b'],
    observedTo: '2026-01-03T08:00:00.000Z',
  }
  const merged = mergeSelfObservations([first, retried, observation('different', '2026-01-01T08:00:00.000Z')])

  assert.deepEqual(merged.map((item) => item.id), ['different', 'same'])
  assert.deepEqual(merged[1].sourceIds, ['message-a', 'message-b'])
  assert.equal(merged[1].evidence.length, 2)
  assert.equal(merged[1].observedTo, '2026-01-03T08:00:00.000Z')
})

test('quarterly consolidation groups are chronological and preserve dense observation ranges', () => {
  const january = Array.from({ length: 123 }, (_, index) => observation(`jan-${index}`, `2026-01-${String((index % 28) + 1).padStart(2, '0')}T08:00:00.000Z`))
  const april = [observation('apr-1', '2026-04-01T08:00:00.000Z')]
  const ordered = [...january, ...april].sort((left, right) => left.observedFrom.localeCompare(right.observedFrom) || left.id.localeCompare(right.id))
  const groups = groupSelfObservationsForMerge(ordered)

  assert.deepEqual(groups.map((group) => group.length), [120, 3, 1])
  assert.equal(groups.flat().length, ordered.length)
  assert.deepEqual(analysisRange(groups[0]), { startAt: groups[0][0].observedFrom, endAt: groups[0].at(-1).observedTo })
})

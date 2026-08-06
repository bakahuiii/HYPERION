import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SELENE_EVENTS_SCHEMA,
  normalizeContextEvents,
  parseContextEventDocument,
  projectContextEventsForModel,
} from '../src/lib/contextEvents.ts'
import { mergeSharedChanges } from '../src/lib/sharedStateMerge.ts'

function shared(overrides = {}) {
  return {
    quests: [], places: [], people: [], dismissedPersonConversationIds: [], peopleDismissalVersion: 5,
    peopleModelVersion: 5, dailyCheckins: [], contextEvents: [], selfAnalysis: undefined, aiCandidates: [], atlas: { categoryPositions: {} },
    ...overrides,
  }
}

test('precise coordinates require explicit local consent and remain local to the model projection', () => {
  const events = normalizeContextEvents([{
    id: 'location-1', version: 1, kind: 'location', source: 'selene',
    startAt: '2026-08-06T10:00:00.000Z', title: 'Current position', capturedAt: '2026-08-06T10:00:00.000Z', importedAt: '2026-08-06T10:01:00.000Z',
    privacy: 'precise', location: { latitude: 31.2, longitude: 121.4, accuracyMeters: 8 },
    locationConsent: { exactLocation: true, captureMode: 'manual', grantedAt: '2026-08-06T10:00:00.000Z' },
  }, {
    id: 'location-without-consent', version: 1, kind: 'location', source: 'selene',
    startAt: '2026-08-06T11:00:00.000Z', title: 'Position', capturedAt: '2026-08-06T11:00:00.000Z', importedAt: '2026-08-06T11:01:00.000Z',
    privacy: 'precise', location: { latitude: 30, longitude: 120 },
  }])

  assert.equal(events[0].privacy, 'precise')
  assert.deepEqual(events[0].location, { latitude: 31.2, longitude: 121.4, accuracyMeters: 8 })
  assert.equal(events[1].privacy, 'coarse')
  assert.equal(events[1].location, undefined)
  assert.deepEqual(projectContextEventsForModel(events)[0], {
    id: 'location-1', kind: 'location', source: 'selene', startAt: '2026-08-06T10:00:00.000Z', title: 'Location capture', privacy: 'coarse',
  })
})

test('background location consent is retained locally but never projected to the model', () => {
  const events = normalizeContextEvents([{
    id: 'location-background', version: 1, kind: 'location', source: 'selene',
    startAt: '2026-08-06T12:00:00.000Z', title: 'Background location observation', capturedAt: '2026-08-06T12:01:00.000Z', importedAt: '2026-08-06T12:01:00.000Z',
    privacy: 'precise', values: { placeTag: '学校 · 图书馆', latitude: 31.2, address: 'Never project' }, location: { latitude: 31.2, longitude: 121.4, accuracyMeters: 80 },
    locationConsent: { exactLocation: true, captureMode: 'background', grantedAt: '2026-08-01T09:00:00.000Z' },
  }])
  assert.equal(events[0].privacy, 'precise')
  assert.equal(events[0].locationConsent?.captureMode, 'background')
  assert.equal(projectContextEventsForModel(events)[0].location, undefined)
  assert.equal(projectContextEventsForModel(events)[0].title, 'Location capture')
  assert.deepEqual(projectContextEventsForModel(events)[0].values, { placeTag: '学校 · 图书馆' })
})

test('confirmed movement keeps its dedicated SELENE event kind', () => {
  const events = normalizeContextEvents([{
    id: 'movement-1', version: 1, kind: 'movement', source: 'selene',
    startAt: '2026-08-06T20:00:00.000+08:00', endAt: '2026-08-06T20:15:00.000+08:00',
    title: 'Continuous movement', capturedAt: '2026-08-06T20:15:00.000+08:00',
    privacy: 'coarse', values: { distanceMeters: 900, averageSpeedMps: 1 },
  }], { importedAt: '2026-08-06T12:15:00.000Z' })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'movement')
  assert.equal(events[0].importedAt, '2026-08-06T12:15:00.000Z')
})

test('context document validates its envelope, normalizes duplicate ids, and strips coordinate-like value fields from model input', () => {
  const events = parseContextEventDocument({
    schema: SELENE_EVENTS_SCHEMA,
    device: { platform: 'windows' },
    generatedAt: '2026-08-06T20:00:00.000Z',
    producer: { name: 'SELENE', version: '0.1.0', layout: 'immutable-snapshot-v1' },
    events: [
      { id: 'screen', version: 1, kind: 'screen-time', source: 'selene', startAt: '2026-08-06T00:00:00.000Z', title: 'Screen usage', values: { foregroundMinutes: 180, latitude: 31.2 }, capturedAt: '2026-08-06T20:00:00.000Z', importedAt: '2026-08-06T20:00:00.000Z', privacy: 'coarse' },
      { id: 'screen', version: 1, kind: 'screen-time', source: 'selene', startAt: '2026-08-06T00:00:00.000Z', title: 'Screen usage updated', values: { foregroundMinutes: 200 }, capturedAt: '2026-08-06T21:00:00.000Z', importedAt: '2026-08-06T21:00:00.000Z', privacy: 'coarse' },
    ],
  })
  assert.ok(events)
  assert.equal(events.length, 1)
  assert.equal(events[0].title, 'Screen usage updated')
  assert.deepEqual(projectContextEventsForModel(events)[0].values, { foregroundMinutes: 200 })
  assert.equal(parseContextEventDocument({ schema: 'other', events: [] }), null)
  assert.equal(parseContextEventDocument({ schema: SELENE_EVENTS_SCHEMA, events: [] }), null)
})

test('three-way shared sync retains independent context imports and honors a local deletion', () => {
  const base = shared({ contextEvents: [{ id: 'base', startAt: '2026-08-01T00:00:00.000Z' }] })
  const local = shared({ contextEvents: [{ id: 'local', startAt: '2026-08-02T00:00:00.000Z' }] })
  const remote = shared({ contextEvents: [
    { id: 'base', startAt: '2026-08-01T00:00:00.000Z' },
    { id: 'remote', startAt: '2026-08-03T00:00:00.000Z' },
  ] })
  const merged = mergeSharedChanges(base, local, remote)
  assert.deepEqual(merged.contextEvents.map((item) => item.id).sort(), ['local', 'remote'])
})

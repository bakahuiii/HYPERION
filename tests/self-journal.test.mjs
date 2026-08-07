import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SELF_JOURNAL_CONVERSATION_ID,
  buildSelfAnalysisInput,
  checkInJournalEntry,
  journalEntry,
  normalizeDailyCheckIns,
  retainManualIntelRecords,
} from '../src/lib/selfJournal.ts'

const profile = { name: 'Test user' }

test('journal entry is a timestamped self message in a stable self conversation', () => {
  const entry = journalEntry(profile, 'A short note.', new Date('2026-08-06T08:20:00.000Z'))
  assert.equal(entry?.conversationId, SELF_JOURNAL_CONVERSATION_ID)
  assert.equal(entry?.conversationKind, 'direct')
  assert.equal(entry?.speakerRole, 'self')
  assert.equal(entry?.source, '手动记录')
  assert.equal(entry?.status, 'reviewed')
  assert.equal(entry?.capturedAt, '2026-08-06T08:20:00.000Z')
})

test('daily snapshots normalize bounds, collapse to one record per day, and mirror to the archive', () => {
  const checkIns = normalizeDailyCheckIns([
    { date: '2026-08-06', mood: 9, sleepHours: 30, medication: 'invalid', alcohol: 'low', note: 'old', updatedAt: '2026-08-06T08:00:00.000Z' },
    { date: '2026-08-06', mood: 4, sleepHours: 7.25, medication: 'reduced', alcohol: 'none', note: 'new', updatedAt: '2026-08-06T09:00:00.000Z' },
  ])

  assert.equal(checkIns.length, 1)
  assert.equal(checkIns[0].id, 'self-checkin-2026-08-06')
  assert.equal(checkIns[0].mood, 4)
  assert.equal(checkIns[0].sleepHours, 7.5)
  assert.equal(checkIns[0].medication, 'reduced')
  assert.equal(checkIns[0].note, 'new')

  const archiveRow = checkInJournalEntry(profile, checkIns[0])
  assert.equal(archiveRow.id, checkIns[0].id)
  assert.equal(archiveRow.conversationId, SELF_JOURNAL_CONVERSATION_ID)
  assert.equal(archiveRow.speakerRole, 'self')
  assert.equal(archiveRow.messageType, 'daily-checkin')
  assert.match(archiveRow.capturedAt, /^2026-08-06T12:00:00\.000$/)
})

test('self analysis input only includes self-authored messages in chronological order plus separate context events', () => {
  const contextEvents = [{ id: 'screen-day', version: 1, kind: 'screen-time', source: 'selene', startAt: '2026-08-06T00:00:00.000Z', title: 'Screen usage', capturedAt: '2026-08-06T20:00:00.000Z', importedAt: '2026-08-06T20:00:00.000Z', privacy: 'coarse' }]
  const result = buildSelfAnalysisInput([
    { id: 'other', source: 'AI 对话导入', summary: 'assistant reply', content: 'assistant reply', conversationId: 'ai-a', capturedAt: '2026-08-05T10:00:00.000Z', speakerRole: 'other', status: 'reviewed' },
    { id: 'self-late', source: 'AI 对话导入', summary: 'later user message', content: 'later user message', conversationId: 'ai-a', capturedAt: '2026-08-06T10:00:00.000Z', speakerRole: 'self', status: 'reviewed' },
    { id: 'self-early', source: '微信导出', summary: 'earlier user message', content: 'earlier user message', conversationId: 'direct-a', capturedAt: '2026-08-04T10:00:00.000Z', speakerRole: 'self', status: 'reviewed' },
  ], contextEvents, new Date('2026-08-06T12:00:00.000Z'))

  assert.equal(result.analysisTarget, 'self')
  assert.deepEqual(result.records.map((item) => item.id), ['self-early', 'self-late'])
  assert.deepEqual(result.contextEvents, contextEvents)
})

test('authoritative directory replacements retain manual rows and let them win ID collisions', () => {
  const manual = journalEntry(profile, 'Keep this.', new Date('2026-08-06T08:20:00.000Z'))
  assert.ok(manual)
  const imported = [
    { id: 'imported', source: '微信导出', summary: 'imported', content: 'imported', capturedAt: '', status: 'new' },
    { ...manual, source: '微信导出', content: 'stale export must not overwrite the journal' },
  ]
  const result = retainManualIntelRecords(imported, [manual])

  assert.equal(result.length, 2)
  assert.equal(result.find((item) => item.id === manual.id)?.source, '手动记录')
  assert.equal(result.find((item) => item.id === manual.id)?.content, 'Keep this.')
})

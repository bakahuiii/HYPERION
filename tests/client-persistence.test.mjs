import assert from 'node:assert/strict'
import test from 'node:test'

import { planDirectoryImport } from '../src/lib/directoryManifest.ts'
import { compactIntelItem, compactIntelItems, hydrateIntelItem } from '../src/lib/intelPersistence.ts'
import { mergeSharedChanges, toSharedData } from '../src/lib/sharedStateMerge.ts'
import { hydrateSharedSnapshot } from '../src/lib/sharedStateHydration.ts'
import { filterDismissedPeople, removePeopleCards, resolvePersonDismissals } from '../src/lib/peopleState.ts'
import { scanExportDirectory } from '../src/lib/directorySync.ts'
import { parseIntelFile } from '../src/lib/importer.ts'
import { recoverArray } from '../src/lib/storageRecovery.ts'
import { removeQuestAndDetachChildren } from '../src/lib/questState.ts'
import { portraitUsesProfileNotes } from '../src/lib/peoplePortraitValidation.ts'
import { shouldLoadSharedIntelSnapshot } from '../src/lib/intelSnapshotSelection.ts'
import { checkpointForRetry } from '../src/lib/analysisCheckpoint.ts'
import { taskGuidanceRequestIsCurrent, taskGuidanceSignature } from '../src/lib/questGuidance.ts'
import { editableSettingsSignature } from '../src/lib/settingsState.ts'
import { analysisConversationFingerprint, completedConversationWatermarks } from '../src/lib/analysisWatermark.ts'
import { buildConversationAnalysisPlan, buildPeopleConversationAnalysisPlan } from '../src/lib/conversationAnalysis.ts'
import { summarizeArchive } from '../src/lib/archiveSummary.ts'
import { aiTaskCandidatesDuplicate, mergeAiTaskCandidates } from '../src/lib/aiCandidateDedup.ts'
import { personEvidenceIdentityKey } from '../src/lib/personEvidenceIdentity.ts'
import { createSeedData } from '../src/seed.ts'

const file = (path, signature) => ({ path, signature })

test('archive summary counts distinct direct and group conversations', () => {
  const record = (id, conversationId, conversationKind) => ({
    id,
    title: id,
    summary: id,
    source: '本地文件',
    conversationId,
    conversationKind,
    capturedAt: '2026-08-05T00:00:00.000Z',
    status: 'new',
  })
  const summary = summarizeArchive([
    record('direct-a-1', 'direct:a', 'direct'),
    record('direct-a-2', 'direct:a', 'direct'),
    record('direct-b-1', 'direct:b', 'direct'),
    record('group-a-1', 'group:a', 'group'),
    record('unknown-a-1', 'unknown:a', 'unknown'),
  ])

  assert.equal(summary.conversationCount, 4)
  assert.equal(summary.identifiedConversationCount, 4)
  assert.equal(summary.directConversationCount, 2)
  assert.equal(summary.groupConversationCount, 1)
})

test('overlap task results merge despite punctuation and optional-field drift', () => {
  const candidate = (overrides = {}) => ({
    id: 'candidate',
    title: '确认咖啡安排',
    description: '和 A 确认咖啡时间',
    sourceIds: ['record-1'],
    people: ['A'],
    tags: [],
    guidance: [],
    model: 'test-model',
    createdAt: '2026-08-05T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  })
  const first = candidate()
  const repeated = candidate({
    id: 'candidate-repeat',
    title: '确认咖啡安排！',
    description: '和 A 确认咖啡时间。',
    sourceIds: ['record-1', 'record-2'],
    guidance: ['先确认日期'],
    status: 'dismissed',
  })
  assert.equal(aiTaskCandidatesDuplicate(first, repeated), true)
  const merged = mergeAiTaskCandidates([first, repeated])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].sourceIds, ['record-1', 'record-2'])
  assert.deepEqual(merged[0].guidance, ['先确认日期'])
  assert.equal(merged[0].status, 'dismissed')
})

test('same task wording remains separate when target dates or exact places conflict', () => {
  const candidate = (overrides = {}) => ({
    id: 'candidate',
    title: '参加课程',
    description: '按时参加课程',
    sourceIds: ['record-1'],
    people: [],
    tags: [],
    model: 'test-model',
    createdAt: '2026-08-05T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  })
  const monday = candidate({ startAt: '2026-08-10T09:00:00+08:00' })
  const tuesday = candidate({ id: 'candidate-tuesday', startAt: '2026-08-11T09:00:00+08:00' })
  const eastCampus = candidate({ id: 'candidate-east', place: '东校区', locationPrecision: 'exact' })
  const westCampus = candidate({ id: 'candidate-west', place: '西校区', locationPrecision: 'exact' })

  assert.equal(aiTaskCandidatesDuplicate(monday, tuesday), false)
  assert.equal(aiTaskCandidatesDuplicate(eastCampus, westCampus), false)
  assert.equal(mergeAiTaskCandidates([monday, tuesday]).length, 2)
  assert.equal(mergeAiTaskCandidates([eastCampus, westCampus]).length, 2)
})

test('person evidence identity ignores overlap-only punctuation drift', () => {
  const first = personEvidenceIdentityKey({ kind: 'preference', text: '喜欢蛋挞', quote: '蛋挞好吃' })
  const repeated = personEvidenceIdentityKey({ kind: 'preference', text: '喜欢蛋挞。', quote: '蛋挞好吃！' })
  const distinct = personEvidenceIdentityKey({ kind: 'preference', text: '喜欢咖啡', quote: '咖啡好喝' })

  assert.equal(first, repeated)
  assert.notEqual(first, distinct)
})

test('bulk person removal suppresses passive restoration and cleans task references', () => {
  const current = {
    quests: [{ id: 'quest-1', characterIds: ['person-a', 'person-b'] }],
    people: [
      { id: 'person-a', conversationIds: ['conversation-a'] },
      { id: 'person-b', conversationIds: ['conversation-b'] },
    ],
    dismissedPersonConversationIds: ['older-conversation'],
  }

  const result = removePeopleCards(current, current.people.map((person) => person.id), 5)
  assert.deepEqual(result.people, [])
  assert.deepEqual(result.quests[0].characterIds, [])
  assert.deepEqual(new Set(result.dismissedPersonConversationIds), new Set(['older-conversation', 'conversation-a', 'conversation-b']))
  assert.equal(result.peopleDismissalVersion, 5)
})

test('passive fallback respects deletion while explicit extraction can restore it', () => {
  const additions = [{ id: 'person-a', conversationIds: ['conversation-a'] }]
  const passive = resolvePersonDismissals(additions, ['conversation-a'])
  assert.deepEqual(passive.additions, [])
  assert.deepEqual(passive.restoredConversationIds, [])

  const explicit = resolvePersonDismissals(additions, ['conversation-a'], true)
  assert.deepEqual(explicit.additions, additions)
  assert.deepEqual(explicit.restoredConversationIds, ['conversation-a'])
})

test('conversation-level deletion also suppresses stale people from a shared snapshot', () => {
  const deleted = { id: 'person-a', conversationIds: ['conversation-a'] }
  const kept = { id: 'person-b', conversationIds: ['conversation-b'] }
  assert.deepEqual(filterDismissedPeople([deleted, kept], ['conversation-a']), [kept])
  assert.deepEqual(filterDismissedPeople([deleted, kept], []), [deleted, kept])
})

test('manual portrait text must retain a concrete profile-note anchor', () => {
  assert.equal(portraitUsesProfileNotes('对方喜欢蛋挞，也会关注甜点。', '对方明确写过：喜欢蛋挞。'), true)
  assert.equal(portraitUsesProfileNotes('目前信息不足，需要更多信息。', '对方明确写过：喜欢蛋挞。'), false)
})

test('shared archive selection uses timestamps instead of record counts', () => {
  const expected = 'directory-new'
  const local = { sourceFingerprint: expected, updatedAt: '2026-08-03T10:00:00.000Z', recordCount: 100 }
  const olderLargerShared = { sourceFingerprint: expected, updatedAt: '2026-08-03T09:00:00.000Z', recordCount: 120 }
  assert.equal(shouldLoadSharedIntelSnapshot(expected, local, olderLargerShared), false)
  assert.equal(shouldLoadSharedIntelSnapshot(expected, local, { ...olderLargerShared, updatedAt: '2026-08-03T11:00:00.000Z' }), true)
  assert.equal(shouldLoadSharedIntelSnapshot(null, { sourceFingerprint: null, updatedAt: null }, olderLargerShared), true)
})

test('retry checkpoint keeps the failed workflow stage and only failed conversations', () => {
  const checkpoint = {
    version: 1,
    stage: 'people',
    targets: { tasks: true, people: true },
    scope: 'all',
    timelineMode: 'last-chat',
    conversationIds: ['a', 'b', 'c'],
    completedConversationIds: ['a', 'c'],
    startedAt: '2026-08-03T10:00:00.000Z',
    pausedAt: '2026-08-03T10:01:00.000Z',
  }
  const { pausedAt, ...expected } = checkpoint
  assert.equal(pausedAt, '2026-08-03T10:01:00.000Z')
  assert.deepEqual(checkpointForRetry(checkpoint, ['b', 'missing', 'b']), { ...expected, conversationIds: ['b'], completedConversationIds: [] })
})

test('legacy browser cache without an array falls back without sharing the seed array', () => {
  const fallback = [{ id: 'fallback-place' }]
  const restored = recoverArray(undefined, fallback)
  assert.deepEqual(restored, fallback)
  assert.notEqual(restored, fallback)
})

test('recovered demo workspaces do not share nested seed state', () => {
  const first = createSeedData()
  const second = createSeedData()
  first.places[0].name = 'changed locally'
  first.aiSettings.feedback.push({
    id: 'feedback-test',
    title: 'test',
    description: 'test',
    decision: 'accepted',
    reason: 'useful',
    createdAt: '2026-08-03T00:00:00.000Z',
  })
  assert.notEqual(first.places, second.places)
  assert.notEqual(first.aiSettings.feedback, second.aiSettings.feedback)
  assert.notEqual(first.places[0].name, second.places[0].name)
  assert.equal(second.aiSettings.feedback.length, 0)
})

test('deleting a parent quest detaches and unlocks its children', () => {
  const result = removeQuestAndDetachChildren([
    { id: 'parent', status: 'available' },
    { id: 'locked-child', parentId: 'parent', status: 'locked', previousStatus: 'locked' },
    { id: 'done-child', parentId: 'parent', status: 'done', previousStatus: 'locked', unlockedByParent: true },
    { id: 'unrelated', status: 'active' },
  ], 'parent')
  assert.deepEqual(result, [
    { id: 'locked-child', status: 'available', previousStatus: 'available' },
    { id: 'done-child', status: 'done', previousStatus: 'available' },
    { id: 'unrelated', status: 'active' },
  ])
})

test('directory plan replaces only a modified file', () => {
  const files = [file('direct/A.json', 'a:2'), file('direct/B.json', 'b:1')]
  const result = planDirectoryImport({
    files,
    previousManifest: new Map([['direct/A.json', 'a:1'], ['direct/B.json', 'b:1']]),
    previousFingerprint: 'old',
    currentFingerprint: 'new',
    archiveItemCount: 20,
    completeSourceProvenance: true,
  })
  assert.equal(result.incrementalUpdate, true)
  assert.deepEqual(result.filesToParse.map((entry) => entry.path), ['direct/A.json'])
  assert.deepEqual(result.removedFiles, [])
})

test('directory plan reports removed files without reparsing unchanged files', () => {
  const result = planDirectoryImport({
    files: [file('direct/A.json', 'a:1')],
    previousManifest: new Map([['direct/A.json', 'a:1'], ['direct/B.json', 'b:1']]),
    previousFingerprint: 'old',
    currentFingerprint: 'new',
    archiveItemCount: 20,
    completeSourceProvenance: true,
  })
  assert.deepEqual(result.filesToParse, [])
  assert.deepEqual(result.removedFiles, ['direct/B.json'])
})

test('legacy archive without source provenance is rebuilt once', () => {
  const files = [file('direct/A.json', 'a:1')]
  const result = planDirectoryImport({
    files,
    previousManifest: new Map([['direct/A.json', 'a:1']]),
    previousFingerprint: 'same',
    currentFingerprint: 'same',
    archiveItemCount: 20,
    completeSourceProvenance: false,
  })
  assert.equal(result.rebuildSnapshot, true)
  assert.deepEqual(result.filesToParse, files)
})

test('unchanged authoritative directory does no import work', () => {
  const files = [file('direct/A.json', 'a:1')]
  const result = planDirectoryImport({
    files,
    previousManifest: new Map([['direct/A.json', 'a:1']]),
    previousFingerprint: 'same',
    currentFingerprint: 'same',
    archiveItemCount: 20,
    completeSourceProvenance: true,
  })
  assert.equal(result.rebuildSnapshot, false)
  assert.equal(result.incrementalUpdate, false)
  assert.deepEqual(result.filesToParse, [])
})

test('archive compaction reconstructs display fields from content', () => {
  const original = {
    id: 'message-1',
    title: 'Old title',
    summary: 'Old summary',
    content: 'original message body',
    source: 'local-test',
    speaker: 'A',
    capturedAt: '2026-08-01T10:00:00',
    status: 'reviewed',
  }
  const compacted = compactIntelItem(original)
  assert.equal('title' in compacted, false)
  assert.equal('summary' in compacted, false)
  assert.deepEqual(hydrateIntelItem(compacted), {
    ...compacted,
    title: 'A: original message bo...',
    summary: 'A: original message body',
  })
})

test('archive compaction removes repeated avatar metadata without dropping messages', () => {
  const items = [1, 2, 3].map((index) => ({
    id: `message-${index}`,
    source: 'wechat',
    sourceFile: '私聊/A/messages.json',
    conversationId: 'folder:私聊/A',
    speaker: 'A',
    avatarUrl: 'https://example.invalid/a.jpg',
    content: `message ${index}`,
    capturedAt: '',
    status: 'new',
  }))
  const compacted = compactIntelItems(items)
  assert.equal(compacted.length, 3)
  assert.equal(compacted.filter((item) => item.avatarUrl).length, 1)
  assert.deepEqual(compacted.map((item) => item.content), ['message 1', 'message 2', 'message 3'])
})

test('legacy archive item without content retains its stored display fields', () => {
  const original = {
    id: 'message-2',
    title: 'Retained title',
    summary: 'Retained summary',
    source: 'local-test',
    capturedAt: '',
    status: 'new',
  }
  assert.deepEqual(compactIntelItem(original), original)
  assert.deepEqual(hydrateIntelItem(original), original)
})

const shared = (overrides = {}) => ({
  quests: [],
  places: [],
  people: [],
  dismissedPersonConversationIds: [],
  peopleDismissalVersion: 5,
  peopleModelVersion: 5,
  aiCandidates: [],
  atlas: { categoryPositions: {} },
  ...overrides,
})

test('shared hydration preserves local startup edits and renderer-only intel', () => {
  const current = createSeedData()
  current.intel = [{ id: 'raw-message', source: 'wechat', content: 'local archive', capturedAt: '', status: 'new' }]
  const base = toSharedData(current)
  current.quests = [...current.quests, { id: 'local-quest', title: 'Local edit', description: '', status: 'available', tags: [], characterIds: [] }]
  const remote = {
    ...base,
    places: [...base.places, { id: 'remote-place', name: 'Remote place', category: 'explore', lat: 1, lng: 2, note: '' }],
  }

  const result = hydrateSharedSnapshot(current, base, remote, { peopleModelVersion: 5, peopleDismissalVersion: 5 })
  assert.ok(result.data.quests.some((quest) => quest.id === 'local-quest'))
  assert.ok(result.data.places.some((place) => place.id === 'remote-place'))
  assert.equal(result.data.intel, current.intel)
  assert.equal(result.skipEchoWrite, false)
})

test('shared hydration keeps repaired dismissal semantics and suppresses remote echo writes', () => {
  const current = createSeedData()
  current.peopleDismissalVersion = 5
  current.dismissedPersonConversationIds = ['deleted-locally']
  const base = toSharedData(current)
  const remote = {
    ...base,
    dismissedPersonConversationIds: ['legacy-deletion'],
    peopleDismissalVersion: 4,
    peopleModelVersion: 5,
  }

  const result = hydrateSharedSnapshot(current, base, remote, { peopleModelVersion: 5, peopleDismissalVersion: 5 })
  assert.deepEqual(result.data.dismissedPersonConversationIds, ['deleted-locally'])
  assert.equal(result.data.peopleDismissalVersion, 5)

  const echoBase = toSharedData(result.data)
  const echo = hydrateSharedSnapshot(result.data, echoBase, echoBase, { peopleModelVersion: 5, peopleDismissalVersion: 5 })
  assert.equal(echo.skipEchoWrite, true)
})

test('three-way shared merge preserves remote additions and local deletions', () => {
  const baseQuest = { id: 'base', title: 'Base' }
  const remoteQuest = { id: 'remote', title: 'Remote' }
  const result = mergeSharedChanges(
    shared({ quests: [baseQuest] }),
    shared({ quests: [] }),
    shared({ quests: [baseQuest, remoteQuest] }),
  )
  assert.deepEqual(result.quests, [remoteQuest])
})

test('three-way shared merge keeps independent local and remote edits', () => {
  const basePerson = { id: 'person', name: 'Before' }
  const remotePerson = { id: 'person', name: 'Remote update' }
  const localQuest = { id: 'local', title: 'Local task' }
  const result = mergeSharedChanges(
    shared({ people: [basePerson] }),
    shared({ people: [basePerson], quests: [localQuest] }),
    shared({ people: [remotePerson] }),
  )
  assert.deepEqual(result.people, [remotePerson])
  assert.deepEqual(result.quests, [localQuest])
})

test('three-way shared merge does not revive a remote deletion with a stale local edit', () => {
  const basePerson = { id: 'person', name: 'Before' }
  const result = mergeSharedChanges(
    shared({ people: [basePerson] }),
    shared({ people: [{ ...basePerson, name: 'Stale local edit' }] }),
    shared({ people: [] }),
  )
  assert.deepEqual(result.people, [])
})

test('late task guidance is rejected after task, place, or character edits', () => {
  const quest = { id: 'quest', title: 'Coffee', description: 'Meet', status: 'available', locationId: 'cafe', characterIds: ['person'], tags: [] }
  const person = { id: 'person', name: 'A', facts: [], preferences: ['coffee'], sourceIds: ['record'], platforms: [], model: 'test' }
  const place = { id: 'cafe', name: 'Cafe', category: 'social', lat: 1, lng: 2, note: '' }
  const signature = taskGuidanceSignature(quest, [person], [place])
  assert.equal(taskGuidanceRequestIsCurrent(quest, quest, quest.characterIds, [person], [place], signature), true)
  assert.equal(taskGuidanceRequestIsCurrent({ ...quest, dueAt: '2026-08-05' }, quest, quest.characterIds, [person], [place], signature), false)
  assert.equal(taskGuidanceRequestIsCurrent(quest, quest, quest.characterIds, [person], [{ ...place, lat: 3 }], signature), false)
  assert.equal(taskGuidanceRequestIsCurrent({ ...quest, characterIds: [] }, quest, quest.characterIds, [person], [place], signature), false)
})

test('settings hydration ignores checkpoint churn but detects user edits', () => {
  const base = {
    profile: { name: 'A' },
    appearance: { theme: 'verdant' },
    aiSettings: { interruptedRun: { version: 1 } },
  }
  assert.equal(editableSettingsSignature(base), editableSettingsSignature({ ...base, aiSettings: { interruptedRun: undefined } }))
  assert.notEqual(editableSettingsSignature(base), editableSettingsSignature({ ...base, profile: { name: 'B' } }))
})

test('analysis watermarks are conversation scoped and require complete coverage', () => {
  const records = [
    { id: 'm-1', source: 'wechat', conversationId: 'chat-a', capturedAt: '2026-08-01T10:00:00Z', speaker: 'A', speakerRole: 'other', content: 'hello', summary: 'hello', status: 'new' },
    { id: 'm-2', source: 'wechat', conversationId: 'chat-a', capturedAt: '2026-08-01T10:01:00Z', speaker: '你', speakerRole: 'self', content: 'reply', summary: 'reply', status: 'new' },
  ]
  const fingerprint = analysisConversationFingerprint(records)
  assert.deepEqual(completedConversationWatermarks(records, ['m-1']), {})
  assert.deepEqual(completedConversationWatermarks(records, ['m-1', 'm-2']), { 'chat-a': fingerprint })
  assert.notEqual(fingerprint, analysisConversationFingerprint([{ ...records[1], content: 'changed', summary: 'changed' }, records[0]]) )
})

test('conversation analysis segments cap core and overlap payload sizes without dropping records', () => {
  const records = Array.from({ length: 250 }, (_, index) => ({
    id: `record-${index}`,
    source: 'wechat',
    conversationId: 'direct:large-chat',
    conversationName: 'Large chat',
    conversationKind: 'direct',
    capturedAt: `2026-08-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    messageType: 'text',
    content: `message ${index} ${'x'.repeat(index % 11)}`,
    summary: `message ${index}`,
    speaker: index % 2 ? 'A' : '你',
    speakerRole: index % 2 ? 'other' : 'self',
    status: 'new',
  }))
  const plan = buildConversationAnalysisPlan(records, Date.parse('2026-08-20T00:00:00.000Z'))
  const jobs = plan.jobs.filter((job) => job.id === 'direct:large-chat')

  assert.equal(plan.totalConversations, 1)
  assert.ok(jobs.length > 1)
  assert.equal(plan.recordCount, records.length)
  assert.ok(jobs.every((job) => job.coreRecordCount <= 48))
  assert.ok(jobs.every((job) => job.recordCount <= 54))
  assert.ok(jobs.every((job) => job.coreRecordCount === job.coreRecordIds.length))

  const coreIds = new Set(jobs.flatMap((job) => job.coreRecordIds))
  assert.equal(coreIds.size, records.length)
  assert.deepEqual(new Set(records.map((record) => record.id)), coreIds)
  assert.ok(jobs.every((job) => job.records.length === job.recordCount))
  assert.ok(jobs.every((job) => job.overlapRecordCount <= 6))
})

test('people analysis uses wider chronological windows without dropping core records', () => {
  const records = Array.from({ length: 900 }, (_, index) => ({
    id: `people-record-${index}`,
    source: 'wechat',
    conversationId: 'direct:people-chat',
    conversationName: '私聊 A',
    conversationKind: 'direct',
    capturedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000).toISOString(),
    messageType: 'text',
    content: `message ${index} ${'x'.repeat(index % 17)}`,
    summary: `message ${index}`,
    speaker: index % 2 ? 'A' : '你',
    speakerRole: index % 2 ? 'other' : 'self',
    status: 'new',
  }))
  const plan = buildPeopleConversationAnalysisPlan(records, Date.parse('2026-08-20T00:00:00.000Z'))
  const jobs = plan.jobs.filter((job) => job.id === 'direct:people-chat')

  assert.ok(jobs.length < 10)
  assert.ok(jobs.every((job) => job.coreRecordCount <= 320))
  assert.ok(jobs.every((job) => job.overlapRecordCount <= 16))
  assert.equal(plan.recordCount, records.length)
  assert.deepEqual(new Set(jobs.flatMap((job) => job.coreRecordIds)), new Set(records.map((record) => record.id)))
})

test('shared snapshot normalization preserves a legacy people model version', () => {
  const normalized = toSharedData(shared({ peopleModelVersion: 4 }))
  assert.equal(normalized.peopleModelVersion, 4)
})

function mockDirectory(entries, name = 'root') {
  return {
    kind: 'directory',
    name,
    async *entries() { for (const entry of entries) yield entry },
    async queryPermission() { return 'granted' },
    async requestPermission() { return 'granted' },
  }
}

function mockFile(name, size = 10, lastModified = 1) {
  return { kind: 'file', name, async getFile() { return { name, size, lastModified } } }
}

test('incomplete file-count scan is reported instead of becoming authoritative', async () => {
  const root = mockDirectory([
    ['A.json', mockFile('A.json')],
    ['B.json', mockFile('B.json')],
  ])
  const result = await scanExportDirectory(root, 1)
  assert.equal(result.complete, false)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.files.map((entry) => entry.path), ['A.json'])
})

test('oversized supported files make a directory scan non-authoritative', async () => {
  const root = mockDirectory([['A.json', mockFile('A.json', 11)]])
  const result = await scanExportDirectory(root, 20_000, 10)
  assert.equal(result.complete, false)
  assert.equal(result.skippedOversizedFiles, 1)
  assert.deepEqual(result.files, [])
})

function jsonFile(name, value) {
  const raw = JSON.stringify(value)
  return { name, size: raw.length, lastModified: 1, async text() { return raw } }
}

test('connected directory ignores non-message JSON metadata', async () => {
  const records = await parseIntelFile(jsonFile('profile.json', {
    session: { content: 'profile metadata rather than a chat message', avatar: 'https://example.invalid/avatar.jpg' },
  }), { path: '私聊/A/profile.json' })
  assert.deepEqual(records, [])
})

test('connected directory retains structured chat JSON records', async () => {
  const records = await parseIntelFile(jsonFile('messages.json', [{
    formattedTime: '2026-08-01 10:00:00',
    type: 'incoming',
    content: 'structured message',
    senderDisplayName: 'A',
  }]), { path: '私聊/A/messages.json' })
  assert.equal(records.length, 1)
  assert.equal(records[0].content, 'structured message')
  assert.equal(records[0].speaker, 'A')
  assert.equal(records[0].sourceFile, '私聊/A/messages.json')
})

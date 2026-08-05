import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeMultiModelSettings as normalizeServerMultiModelSettings } from '../server/settings.mjs'
import {
  adjudicateTaskCandidates,
  buildMultiModelConversationPlans,
  buildPeopleJudgeInput,
  clusterPeopleEvidenceObservations,
  normalizeMultiModelSettings,
  planMultiModelPasses,
} from '../src/lib/multiModel.ts'

function candidate(id, title, sourceIds) {
  return {
    id,
    title,
    description: `${title} actionable summary`,
    sourceIds,
    people: [],
    tags: [],
    model: 'test-model',
    createdAt: '2026-08-05T00:00:00.000Z',
    status: 'pending',
  }
}

function record(index, conversationId = 'direct:case') {
  return {
    id: `${conversationId}-${index}`,
    source: 'test',
    conversationId,
    conversationName: 'Case',
    conversationKind: 'direct',
    capturedAt: `2026-08-0${Math.floor(index / 24) + 1}T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    messageType: 'text',
    content: `message ${index}`,
    speakerRole: index % 2 ? 'other' : 'self',
    status: 'new',
  }
}

test('multi-model settings migrate legacy roles and preserve explicit capability profiles', () => {
  const normalized = normalizeMultiModelSettings({
    mode: 'ensemble',
    maxExtractorsPerConversation: 99,
    segmentProfiles: [
      { id: 'compact', maxCoreRecords: 12, maxCoreChars: 2_500, overlapRecords: 2, overlapChars: 300, maxOutputTokens: 1_200 },
      // Built-in IDs cannot silently change the established single-model envelope.
      { id: 'task-standard', maxCoreRecords: 999, maxCoreChars: 99_999, overlapRecords: 0, overlapChars: 0 },
    ],
    participants: [
      { id: 'a', workflow: 'tasks', role: 'extractor', channelId: 'fast', model: 'model-a', segmentProfileId: 'compact' },
      { id: 'duplicate', workflow: 'tasks', role: 'extractor', channelId: 'fast', model: 'model-a' },
      { id: 'b', workflow: 'tasks', role: 'task-extractor', channelId: 'careful', model: 'model-b' },
      { id: 'review', workflow: 'tasks', role: 'reviewer', channelId: 'judge', model: 'model-review' },
      { id: 'invalid', workflow: 'tasks', role: 'people-judge', channelId: 'judge', model: 'wrong-workflow' },
    ],
  })
  assert.equal(normalized.maxExtractorsPerConversation, 8)
  assert.deepEqual(normalized.participants.map((entry) => entry.role), ['task-extractor', 'task-extractor', 'task-judge'])
  assert.equal(normalized.participants[0].segmentProfileId, 'compact')
  assert.equal(normalized.segmentProfiles.find((profile) => profile.id === 'task-standard')?.maxCoreRecords, 48)
  assert.ok(normalized.segmentProfiles.some((profile) => profile.id === 'compact'))
  const plan = planMultiModelPasses(normalized, 'tasks')
  assert.deepEqual(plan.extractors.map((entry) => entry.id), ['a', 'b'])
  assert.equal(plan.extractors[0].segmentProfile?.id, 'compact')
  assert.equal(plan.judge?.id, 'review')
  assert.equal(plan.reviewer?.id, 'review')
  assert.deepEqual(planMultiModelPasses({ ...normalized, mode: 'single' }, 'tasks'), { extractors: [] })
  assert.deepEqual(normalizeServerMultiModelSettings(normalized), normalized)
})

test('each extractor receives its own complete deterministic segmentation plan', () => {
  const settings = normalizeMultiModelSettings({
    mode: 'ensemble',
    maxExtractorsPerConversation: 2,
    segmentProfiles: [
      { id: 'short', maxCoreRecords: 2, maxCoreChars: 1_000, overlapRecords: 1, overlapChars: 200 },
      { id: 'long', maxCoreRecords: 5, maxCoreChars: 1_000, overlapRecords: 2, overlapChars: 300 },
    ],
    participants: [
      { id: 'short-reader', workflow: 'people', role: 'people-claim-extractor', channelId: 'one', model: 'model-one', segmentProfileId: 'short' },
      { id: 'long-reader', workflow: 'people', role: 'people-claim-extractor', channelId: 'two', model: 'model-two', segmentProfileId: 'long' },
      { id: 'judge', workflow: 'people', role: 'people-judge', channelId: 'three', model: 'model-three' },
    ],
  })
  const records = Array.from({ length: 7 }, (_, index) => record(index))
  const plans = buildMultiModelConversationPlans(settings, 'people', records, Date.parse('2026-08-20T00:00:00.000Z'), {
    promptVersion: 'prompt-test',
    responseSchemaVersion: 'schema-test',
  })
  assert.equal(plans.length, 1)
  const [conversation] = plans
  assert.equal(conversation.judge?.participantId, 'judge')
  const shortPasses = conversation.extractorPasses.filter((pass) => pass.participantId === 'short-reader')
  const longPasses = conversation.extractorPasses.filter((pass) => pass.participantId === 'long-reader')
  assert.equal(shortPasses.length, 4)
  assert.equal(longPasses.length, 2)
  for (const passes of [shortPasses, longPasses]) {
    assert.deepEqual(new Set(passes.flatMap((pass) => pass.sourceRecordIds)), new Set(records.map((entry) => entry.id)))
    assert.ok(passes.every((pass) => pass.contextRecordIds.every((id) => !pass.sourceRecordIds.includes(id))))
  }
  assert.equal(shortPasses[0].requestBudget.maxCoreRecords, 2)
  assert.equal(longPasses[0].requestBudget.maxCoreRecords, 5)
  assert.equal(shortPasses[0].promptVersion, 'prompt-test')
})

test('people evidence clusters use exact record citations and count distinct models only', () => {
  const observations = [
    { id: 'a-1', passId: 'a-1', participantId: 'a', channelId: 'one', model: 'A', conversationId: 'direct:case', kind: 'preference', text: 'likes coffee', quote: 'coffee', sourceIds: ['m-1'], validation: 'validated' },
    // A second overlapping pass by model A does not corroborate itself.
    { id: 'a-2', passId: 'a-2', participantId: 'a', channelId: 'one', model: 'A', conversationId: 'direct:case', kind: 'preference', text: 'prefers coffee', quote: 'coffee', sourceIds: ['m-1'], validation: 'validated' },
    { id: 'b-1', passId: 'b-1', participantId: 'b', channelId: 'two', model: 'B', conversationId: 'direct:case', kind: 'preference', text: 'enjoys coffee', quote: 'coffee', sourceIds: ['m-1'], validation: 'validated' },
    { id: 'c-1', passId: 'c-1', participantId: 'c', channelId: 'three', model: 'C', conversationId: 'direct:case', kind: 'fact', text: 'works late', quote: 'late', sourceIds: ['m-2'], validation: 'validated' },
    { id: 'd-1', passId: 'd-1', participantId: 'd', channelId: 'four', model: 'D', conversationId: 'direct:case', kind: 'event', text: 'unclear', quote: 'maybe', sourceIds: ['m-3'], validation: 'needs-review' },
    { id: 'e-1', passId: 'e-1', participantId: 'e', channelId: 'five', model: 'E', conversationId: 'direct:case', kind: 'fact', text: 'invalid', quote: '', sourceIds: ['m-4'], validation: 'rejected' },
  ]
  const clusters = clusterPeopleEvidenceObservations(observations)
  assert.equal(clusters.find((cluster) => cluster.sourceId === 'm-1')?.state, 'corroborated')
  assert.deepEqual(clusters.find((cluster) => cluster.sourceId === 'm-1')?.participantIds.sort(), ['a', 'b'])
  assert.equal(clusters.find((cluster) => cluster.sourceId === 'm-2')?.state, 'single-source')
  assert.equal(clusters.find((cluster) => cluster.sourceId === 'm-3')?.state, 'needs-review')
  assert.equal(clusters.find((cluster) => cluster.sourceId === 'm-4')?.state, 'rejected')
  const judgeInput = buildPeopleJudgeInput('direct:case', 'Case', '2026-08-20T00:00:00.000Z', observations)
  assert.equal(judgeInput.protocolVersion, 1)
  assert.equal(judgeInput.instructions.retainSingleSourceAsNeedsVerification, true)
  assert.equal(judgeInput.evidenceClusters.length, 4)
})

test('task adjudication exposes agreement without fabricating a confidence score', () => {
  const results = adjudicateTaskCandidates([
    { passId: 'a', channelId: 'fast', model: 'model-a', candidate: candidate('a', 'Confirm weekend meeting', ['m-1']) },
    { passId: 'b', channelId: 'careful', model: 'model-b', candidate: candidate('b', 'Confirm weekend meeting', ['m-1']) },
    { passId: 'a', channelId: 'fast', model: 'model-a', candidate: candidate('c', 'Prepare return-to-school documents', ['m-2']) },
  ], 2)
  assert.equal(results.length, 2)
  const consensus = results.find((entry) => entry.candidate.title === 'Confirm weekend meeting')
  const independent = results.find((entry) => entry.candidate.title === 'Prepare return-to-school documents')
  assert.equal(consensus?.agreement, 'consensus')
  assert.deepEqual(consensus?.supportingPassIds.sort(), ['a', 'b'])
  assert.equal(independent?.agreement, 'needs-review')
  assert.equal('confidence' in (independent ?? {}), false)
})

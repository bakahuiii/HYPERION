import type {
  AiModelParticipant,
  AiModelParticipantRole,
  AiMultiModelSegmentProfile,
  AiMultiModelSettings,
  AiMultiModelWorkflow,
  AiTaskCandidate,
  IntelItem,
  PersonEvidenceCategory,
  PersonEvidenceKind,
} from '../types.ts'
import {
  buildConversationAnalysisPlanForProfile,
  DEFAULT_PEOPLE_SEGMENT_PROFILE,
  DEFAULT_TASK_SEGMENT_PROFILE,
  type ConversationAnalysisJob,
} from './conversationAnalysis.ts'
import { aiTaskCandidatesDuplicate, mergeAiTaskCandidates } from './aiCandidateDedup.ts'

export const MULTI_MODEL_SETTINGS_VERSION = 1 as const
const MAX_PARTICIPANTS = 24
const MAX_EXTRACTORS = 8
const MAX_SEGMENT_PROFILES = 16
const BUILT_IN_PROFILE_IDS = new Set([DEFAULT_TASK_SEGMENT_PROFILE.id, DEFAULT_PEOPLE_SEGMENT_PROFILE.id])

export type MultiModelEvidenceState = 'single-source' | 'corroborated' | 'needs-review' | 'rejected'
export type MultiModelObservationValidation = 'validated' | 'needs-review' | 'rejected'

export const defaultMultiModelSettings: AiMultiModelSettings = {
  version: MULTI_MODEL_SETTINGS_VERSION,
  mode: 'single',
  maxExtractorsPerConversation: 2,
  segmentProfiles: [
    { ...DEFAULT_TASK_SEGMENT_PROFILE },
    { ...DEFAULT_PEOPLE_SEGMENT_PROFILE },
  ],
  participants: [],
}

function text(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function normalizedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function normalizeProfileId(value: unknown, index: number) {
  return text(value, 80)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `segment-profile-${index + 1}`
}

function normalizedSegmentProfile(value: unknown, index: number): AiMultiModelSegmentProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<AiMultiModelSegmentProfile>
  const maxCoreRecords = normalizedInteger(input.maxCoreRecords, 1, 2_000, 0)
  const maxCoreChars = normalizedInteger(input.maxCoreChars, 256, 160_000, 0)
  if (!maxCoreRecords || !maxCoreChars) return null
  return {
    id: normalizeProfileId(input.id, index),
    maxCoreRecords,
    maxCoreChars,
    overlapRecords: normalizedInteger(input.overlapRecords, 0, maxCoreRecords, 0),
    overlapChars: normalizedInteger(input.overlapChars, 0, maxCoreChars, 0),
    ...(Number.isFinite(Number(input.maxOutputTokens)) ? {
      maxOutputTokens: normalizedInteger(input.maxOutputTokens, 128, 64_000, 3_000),
    } : {}),
  }
}

function roleWorkflow(role: AiModelParticipantRole): AiMultiModelWorkflow {
  return role.startsWith('task-') ? 'tasks' : 'people'
}

function normalizedRole(value: unknown, workflow: unknown): AiModelParticipantRole | null {
  if (value === 'task-extractor' || value === 'task-judge' || value === 'people-claim-extractor' || value === 'people-judge') {
    const explicitWorkflow = workflow === 'tasks' || workflow === 'people' ? workflow : null
    return !explicitWorkflow || explicitWorkflow === roleWorkflow(value) ? value : null
  }
  if (value === 'extractor') return workflow === 'people' ? 'people-claim-extractor' : workflow === 'tasks' ? 'task-extractor' : null
  if (value === 'reviewer') return workflow === 'people' ? 'people-judge' : workflow === 'tasks' ? 'task-judge' : null
  return null
}

function defaultProfileId(workflow: AiMultiModelWorkflow) {
  return workflow === 'people' ? DEFAULT_PEOPLE_SEGMENT_PROFILE.id : DEFAULT_TASK_SEGMENT_PROFILE.id
}

function normalizedProfiles(value: unknown) {
  const profiles = [
    { ...DEFAULT_TASK_SEGMENT_PROFILE },
    { ...DEFAULT_PEOPLE_SEGMENT_PROFILE },
  ]
  const seen = new Set(profiles.map((profile) => profile.id))
  for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
    const profile = normalizedSegmentProfile(item, index)
    // Built-in limits preserve the established single-model request envelope.
    // Custom capability declarations need their own IDs.
    if (!profile || seen.has(profile.id) || BUILT_IN_PROFILE_IDS.has(profile.id)) continue
    seen.add(profile.id)
    profiles.push(profile)
    if (profiles.length >= MAX_SEGMENT_PROFILES) break
  }
  return profiles
}

function normalizedParticipant(value: unknown, index: number, profiles: Map<string, AiMultiModelSegmentProfile>): AiModelParticipant | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<AiModelParticipant> & { role?: string }
  const role = normalizedRole(input.role, input.workflow)
  const channelId = text(input.channelId, 80)
  const model = text(input.model, 200)
  if (!role || !channelId || !model) return null
  const workflow = roleWorkflow(role)
  const requestedProfileId = text(input.segmentProfileId, 80)
  const segmentProfileId = role.endsWith('extractor')
    ? profiles.has(requestedProfileId) ? requestedProfileId : defaultProfileId(workflow)
    : undefined
  const id = text(input.id, 80).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `model-pass-${index + 1}`
  return {
    id,
    workflow,
    role,
    channelId,
    model,
    ...(segmentProfileId ? { segmentProfileId } : {}),
    enabled: input.enabled !== false,
  }
}

/**
 * Normalizes persisted configuration without making any request. Legacy
 * extractor/reviewer roles are mapped from their declared workflow once, then
 * persisted as explicit role names. Built-in profiles cannot be overwritten.
 */
export function normalizeMultiModelSettings(value: unknown): AiMultiModelSettings {
  const input = value && typeof value === 'object' ? value as Partial<AiMultiModelSettings> : {}
  const profiles = normalizedProfiles(input.segmentProfiles)
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]))
  const seen = new Set<string>()
  const participants = (Array.isArray(input.participants) ? input.participants : [])
    .map((participant, index) => normalizedParticipant(participant, index, profileById))
    .filter((participant): participant is AiModelParticipant => Boolean(participant))
    .filter((participant) => {
      const identity = `${participant.role}\u0000${participant.channelId}\u0000${participant.model}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .slice(0, MAX_PARTICIPANTS)
  return {
    version: MULTI_MODEL_SETTINGS_VERSION,
    mode: input.mode === 'ensemble' ? 'ensemble' : 'single',
    maxExtractorsPerConversation: normalizedInteger(input.maxExtractorsPerConversation, 1, MAX_EXTRACTORS, defaultMultiModelSettings.maxExtractorsPerConversation),
    segmentProfiles: profiles,
    participants,
  }
}

export interface MultiModelPlannedParticipant extends AiModelParticipant {
  /** Only extractors carry raw conversation windows. Judges receive verified claims. */
  segmentProfile?: AiMultiModelSegmentProfile
}

export interface MultiModelPassPlan {
  extractors: MultiModelPlannedParticipant[]
  judge?: MultiModelPlannedParticipant
  /** @deprecated Compatibility alias for integrations built before judges were named explicitly. */
  reviewer?: MultiModelPlannedParticipant
}

/**
 * Selects future model passes for one workflow. It has no side effects and is
 * intentionally unused by the existing provider pool until ensemble execution
 * is explicitly implemented.
 */
export function planMultiModelPasses(settings: AiMultiModelSettings, workflow: AiMultiModelWorkflow): MultiModelPassPlan {
  const normalized = normalizeMultiModelSettings(settings)
  if (normalized.mode !== 'ensemble') return { extractors: [] }
  const profileById = new Map(normalized.segmentProfiles.map((profile) => [profile.id, profile]))
  const candidates = normalized.participants.filter((participant) => participant.enabled && participant.workflow === workflow)
  const extractors = candidates
    .filter((participant) => participant.role === (workflow === 'people' ? 'people-claim-extractor' : 'task-extractor'))
    .slice(0, normalized.maxExtractorsPerConversation)
    .map((participant) => ({
      ...participant,
      segmentProfile: profileById.get(participant.segmentProfileId ?? defaultProfileId(workflow)),
    }))
  const judge = candidates.find((participant) => participant.role === (workflow === 'people' ? 'people-judge' : 'task-judge'))
  return {
    extractors,
    ...(judge ? { judge, reviewer: judge } : {}),
  }
}

export interface MultiModelPassRequestBudget {
  maxCoreRecords: number
  maxCoreChars: number
  overlapRecords: number
  overlapChars: number
  maxOutputTokens?: number
}

/** One independent extractor request. The core IDs are the only IDs it may cite. */
export interface MultiModelPass {
  id: string
  workflow: AiMultiModelWorkflow
  role: Extract<AiModelParticipantRole, 'task-extractor' | 'people-claim-extractor'>
  participantId: string
  channelId: string
  model: string
  conversationId: string
  conversationName: string
  conversationKind: ConversationAnalysisJob['kind']
  segmentIndex: number
  segmentCount: number
  totalConversationRecords: number
  sourceRecordIds: string[]
  contextRecordIds: string[]
  promptVersion: string
  responseSchemaVersion: string
  requestBudget: MultiModelPassRequestBudget
}

/** A deferred judge request, created only after every extractor pass settles. */
export interface MultiModelJudgePass {
  id: string
  workflow: AiMultiModelWorkflow
  role: Extract<AiModelParticipantRole, 'task-judge' | 'people-judge'>
  participantId: string
  channelId: string
  model: string
  conversationId: string
  conversationName: string
  promptVersion: string
  responseSchemaVersion: string
}

export interface MultiModelConversationPlan {
  workflow: AiMultiModelWorkflow
  conversationId: string
  conversationName: string
  conversationKind: ConversationAnalysisJob['kind']
  totalConversationRecords: number
  extractorPasses: MultiModelPass[]
  judge?: MultiModelJudgePass
}

export interface MultiModelPlanOptions {
  promptVersion?: string
  responseSchemaVersion?: string
}

function passId(workflow: AiMultiModelWorkflow, participantId: string, job: ConversationAnalysisJob) {
  return `${workflow}:${participantId}:${job.id}:${job.segmentIndex}`
}

/**
 * Expands each extractor with its own declared window. This is the critical
 * distinction from the old global 48-record constant: model A and model B may
 * cover the same conversation with different safe window sizes, while each
 * participant still covers every core record exactly once.
 */
export function buildMultiModelConversationPlans(
  settings: AiMultiModelSettings,
  workflow: AiMultiModelWorkflow,
  items: IntelItem[],
  now = Date.now(),
  options: MultiModelPlanOptions = {},
): MultiModelConversationPlan[] {
  const selected = planMultiModelPasses(settings, workflow)
  if (!selected.extractors.length) return []
  const promptVersion = text(options.promptVersion, 80) || 'multi-model-v1'
  const responseSchemaVersion = text(options.responseSchemaVersion, 80) || 'multi-model-claims-v1'
  const conversations = new Map<string, MultiModelConversationPlan>()

  for (const participant of selected.extractors) {
    const profile = participant.segmentProfile
    if (!profile) continue
    const plan = buildConversationAnalysisPlanForProfile(items, profile, now)
    for (const job of plan.jobs) {
      // A person card represents one counterpart. Group conversations cannot
      // provide that identity boundary and are therefore never judge input.
      if (workflow === 'people' && job.kind !== 'direct') continue
      const existing = conversations.get(job.id) ?? {
        workflow,
        conversationId: job.id,
        conversationName: job.name,
        conversationKind: job.kind,
        totalConversationRecords: job.totalRecords,
        extractorPasses: [],
      }
      const coreIds = new Set(job.coreRecordIds)
      existing.extractorPasses.push({
        id: passId(workflow, participant.id, job),
        workflow,
        role: participant.role as MultiModelPass['role'],
        participantId: participant.id,
        channelId: participant.channelId,
        model: participant.model,
        conversationId: job.id,
        conversationName: job.name,
        conversationKind: job.kind,
        segmentIndex: job.segmentIndex,
        segmentCount: job.segmentCount,
        totalConversationRecords: job.totalRecords,
        sourceRecordIds: [...job.coreRecordIds],
        contextRecordIds: job.records.map((record) => record.id).filter((id) => !coreIds.has(id)),
        promptVersion,
        responseSchemaVersion,
        requestBudget: {
          maxCoreRecords: profile.maxCoreRecords,
          maxCoreChars: profile.maxCoreChars,
          overlapRecords: profile.overlapRecords,
          overlapChars: profile.overlapChars,
          ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
        },
      })
      conversations.set(job.id, existing)
    }
  }

  for (const conversation of conversations.values()) {
    if (!selected.judge) continue
    conversation.judge = {
      id: `${workflow}:${selected.judge.id}:${conversation.conversationId}:judge`,
      workflow,
      role: selected.judge.role as MultiModelJudgePass['role'],
      participantId: selected.judge.id,
      channelId: selected.judge.channelId,
      model: selected.judge.model,
      conversationId: conversation.conversationId,
      conversationName: conversation.conversationName,
      promptVersion,
      responseSchemaVersion,
    }
  }
  return [...conversations.values()].sort((left, right) => left.conversationName.localeCompare(right.conversationName, 'zh-CN'))
}

/**
 * A validated model observation. `sourceIds` are the only evidence that a
 * judge can use; they are exact archive IDs, never semantic similarity keys.
 */
export interface MultiModelClaimObservation {
  id: string
  passId: string
  participantId: string
  channelId: string
  model: string
  conversationId: string
  kind: PersonEvidenceKind
  category?: PersonEvidenceCategory
  text: string
  quote: string
  sourceIds: string[]
  validation: MultiModelObservationValidation
}

/**
 * Groups observations by an exact cited archive message, not by model prose.
 * Multiple windows from one participant still count as one source of support.
 */
export interface MultiModelEvidenceCluster {
  sourceId: string
  observationIds: string[]
  participantIds: string[]
  state: MultiModelEvidenceState
}

/**
 * Deterministic support grouping before an LLM judge. It never performs fuzzy
 * text matching or synthesizes a claim. A future judge receives the original
 * observations plus this provenance map and decides only within that evidence.
 */
export function clusterPeopleEvidenceObservations(observations: MultiModelClaimObservation[]): MultiModelEvidenceCluster[] {
  const clusters = new Map<string, { observationIds: Set<string>; participantIds: Set<string>; validations: Set<MultiModelObservationValidation> }>()
  for (const observation of observations) {
    const observationId = text(observation?.id, 160)
    const participantId = text(observation?.participantId, 80)
    if (!observationId || !participantId || !Array.isArray(observation?.sourceIds)) continue
    for (const sourceId of [...new Set(observation.sourceIds.map((value) => text(value, 240)).filter(Boolean))]) {
      const cluster = clusters.get(sourceId) ?? { observationIds: new Set(), participantIds: new Set(), validations: new Set() }
      cluster.observationIds.add(observationId)
      cluster.participantIds.add(participantId)
      cluster.validations.add(observation.validation)
      clusters.set(sourceId, cluster)
    }
  }
  return [...clusters.entries()]
    .map(([sourceId, cluster]) => {
      const state: MultiModelEvidenceState = cluster.validations.has('rejected') && cluster.validations.size === 1
        ? 'rejected'
        : cluster.validations.has('needs-review')
          ? 'needs-review'
          : cluster.participantIds.size >= 2 ? 'corroborated' : 'single-source'
      return {
        sourceId,
        observationIds: [...cluster.observationIds],
        participantIds: [...cluster.participantIds],
        state,
      }
    })
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'zh-CN'))
}

export interface MultiModelJudgeInput {
  protocolVersion: 1
  conversationId: string
  conversationName: string
  analysisAsOf: string
  observations: MultiModelClaimObservation[]
  evidenceClusters: MultiModelEvidenceCluster[]
  instructions: {
    preferCorroboratedEvidence: true
    retainSingleSourceAsNeedsVerification: true
    rejectUnsupportedClaims: true
    separateTransientFromDurable: true
  }
}

export interface MultiModelJudgePortraitBlock {
  text: string
  claimIds: string[]
  sourceIds: string[]
  state: Exclude<MultiModelEvidenceState, 'rejected'>
}

export interface MultiModelJudgeDecision {
  protocolVersion: 1
  conversationId: string
  portraitBlocks: MultiModelJudgePortraitBlock[]
  acceptedClaimIds: string[]
  needsVerificationClaimIds: string[]
  rejectedClaimIds: string[]
  /** Metadata only. It is deliberately kept out of readable portrait prose. */
  coverageNote?: string
}

/** Builds the complete, auditable evidence package for a future people judge. */
export function buildPeopleJudgeInput(
  conversationId: string,
  conversationName: string,
  analysisAsOf: string,
  observations: MultiModelClaimObservation[],
): MultiModelJudgeInput {
  const scoped = observations.filter((observation) => observation.conversationId === conversationId)
  return {
    protocolVersion: 1,
    conversationId,
    conversationName,
    analysisAsOf,
    observations: scoped,
    evidenceClusters: clusterPeopleEvidenceObservations(scoped),
    instructions: {
      preferCorroboratedEvidence: true,
      retainSingleSourceAsNeedsVerification: true,
      rejectUnsupportedClaims: true,
      separateTransientFromDurable: true,
    },
  }
}

export interface ModelCandidateObservation {
  passId: string
  channelId: string
  model: string
  candidate: AiTaskCandidate
}

export interface AdjudicatedTaskCandidate {
  candidate: AiTaskCandidate
  supportingPassIds: string[]
  supportingModels: string[]
  agreement: 'single' | 'consensus' | 'needs-review'
}

/**
 * Deterministically groups only candidates that already passed the evidence,
 * time and ownership gates. It never invents a score or discards a valid
 * independent discovery just because another model did not find it.
 */
export function adjudicateTaskCandidates(observations: ModelCandidateObservation[], extractorCount: number): AdjudicatedTaskCandidate[] {
  const clusters: Array<{ candidate: AiTaskCandidate; passIds: Set<string>; models: Set<string> }> = []
  for (const observation of observations) {
    if (!observation?.candidate || !text(observation.passId, 100)) continue
    const existing = clusters.find((cluster) => aiTaskCandidatesDuplicate(cluster.candidate, observation.candidate))
    if (existing) {
      existing.candidate = mergeAiTaskCandidates([existing.candidate, observation.candidate])[0]
      existing.passIds.add(observation.passId)
      if (text(observation.model, 200)) existing.models.add(observation.model)
      continue
    }
    clusters.push({
      candidate: observation.candidate,
      passIds: new Set([observation.passId]),
      models: new Set(text(observation.model, 200) ? [observation.model] : []),
    })
  }
  return clusters.map((cluster) => {
    const supportingPassIds = [...cluster.passIds]
    const agreement = extractorCount <= 1
      ? 'single'
      : supportingPassIds.length >= 2 ? 'consensus' : 'needs-review'
    return {
      candidate: cluster.candidate,
      supportingPassIds,
      supportingModels: [...cluster.models],
      agreement,
    }
  })
}

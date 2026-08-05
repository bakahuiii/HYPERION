export type ViewId = 'quests' | 'timeline' | 'map' | 'people' | 'journal' | 'intel' | 'settings'
export type AppearanceTheme = 'verdant' | 'nocturne' | 'paper' | 'sakura'
export type BackgroundTarget = 'app'
export type DynamicBackgroundPreset = 'none' | 'ribbons' | 'rain' | 'scanlines' | 'constellation'

export type QuestStatus = 'available' | 'active' | 'done' | 'locked'
export type QuestKind = 'task' | 'long-event'
export type TaskAtlasCategory = 'campus' | 'romance' | 'friends' | 'study' | 'wellbeing' | 'life'

export interface TaskAtlasPosition {
  /** Percentage coordinates inside the task atlas world. */
  x: number
  y: number
}

export interface TaskAtlasLayout {
  categoryPositions: Partial<Record<TaskAtlasCategory, TaskAtlasPosition>>
}

export interface Quest {
  id: string
  title: string
  description: string
  status: QuestStatus
  /** Status to restore when a completed task is marked unfinished again. */
  previousStatus?: QuestStatus
  /** Internal marker for a child unlocked by its parent in the current completion cycle. */
  unlockedByParent?: boolean
  locationId: string
  characterIds: string[]
  /** Start or occurrence time. Undefined means the source did not establish it. */
  startAt?: string
  /** Deadline or end time. Undefined means the source did not establish it. */
  dueAt?: string
  /** Timestamp of the cited message, or of source ingestion for legacy records whose raw IDs no longer resolve. */
  sourceCapturedAt?: string
  parentId?: string
  source?: string
  sourceIds?: string[]
  sourcePlatforms?: IntelItem['source'][]
  providers?: string[]
  tags: string[]
  /** Practical next steps supplied by the model only when cited evidence supports them. */
  guidance?: string[]
  /** Evidence fingerprint used to refresh suggestions only after a related person or task meaningfully changes. */
  guidanceEvidenceSignature?: string
  /** Last successful or attempted automatic suggestion refresh. */
  guidanceUpdatedAt?: string
  guidanceRefreshAttemptedAt?: string
  /** A long event occupies a time span on the itinerary instead of a single action slot. */
  kind?: QuestKind
  /** User-arranged task-atlas category. When absent, the atlas uses its conservative text grouping. */
  atlasCategory?: TaskAtlasCategory
  /** User-arranged order within an atlas category. */
  atlasOrder?: number
}

export interface Place {
  id: string
  name: string
  category: 'home' | 'study' | 'health' | 'social' | 'explore'
  lat: number
  lng: number
  note: string
  /** Exact places render as markers; approximate places also render a translucent area. */
  precision?: 'exact' | 'approximate'
  /** Approximate area radius in metres. */
  radiusMeters?: number
}

export type PersonEvidenceKind = 'fact' | 'preference' | 'event'

/**
 * A claim's role in a profile. Temporary and filler claims stay available for
 * task extraction or audit history, but are not used as personality evidence.
 */
export type PersonEvidenceCategory =
  | 'identity'
  | 'background'
  | 'preference'
  | 'habit'
  | 'boundary'
  | 'interaction'
  | 'skill'
  | 'temporary'
  | 'filler'

export type PersonEvidenceStability = 'single' | 'repeated' | 'persistent'
export type PersonEvidenceOrigin = 'chat' | 'user'

/**
 * A single model claim that has survived local verification against an
 * exporter-provided counterpart message. This stays internal to the profile
 * pipeline; the UI renders the consolidated notes instead of raw quotes.
 */
export interface PersonEvidence {
  /** Stable local ID derived from the verified claim, quote, and source IDs. */
  id?: string
  kind: PersonEvidenceKind
  /** Conservative statement selected from the model response. */
  text: string
  /** Exact contiguous quote from an "other" message. */
  quote: string
  /** Original archive records that support the quote. */
  sourceIds: string[]
  /** Derived locally from the number of distinct supporting records. */
  evidenceStrength: 'single' | 'repeated'
  firstObservedAt?: string
  lastObservedAt?: string
  /** Value classification used to route claims without deleting them. */
  category?: PersonEvidenceCategory
  /** Stability inferred from distinct records and observed time span. */
  stability?: PersonEvidenceStability
  /** Local ranking score; it is never a confidence value shown to the user. */
  importanceScore?: number
  /** Whether the claim may be selected for the narrative portrait. */
  portraitEligible?: boolean
  /** Chat evidence is distinct from an explicitly user-confirmed background. */
  origin?: PersonEvidenceOrigin
}

export type PersonPortraitBlockReason = 'background' | 'preference' | 'habit' | 'interaction' | 'change' | 'trajectory' | 'other'
export type PersonPortraitBlockTemporalScope = 'recent' | 'historical' | 'change' | 'undated'

export interface PersonPortraitBlock {
  id: string
  text: string
  claimIds: string[]
  sourceIds: string[]
  reason?: PersonPortraitBlockReason
  /** Derived locally from cited claim timestamps; the model cannot choose it. */
  temporalScope?: PersonPortraitBlockTemporalScope
  observedFrom?: string
  observedTo?: string
}

export interface PersonPortraitCoverage {
  claimCount: number
  sourceCount: number
  conversationCount?: number
  firstObservedAt?: string
  lastObservedAt?: string
  categories: PersonEvidenceCategory[]
  /** Absolute generation reference used to classify recent versus historical evidence. */
  analysisAsOf?: string
  recentWindowDays?: number
  recentCutoffAt?: string
  recentClaimCount?: number
  historicalClaimCount?: number
  undatedClaimCount?: number
  recentSourceCount?: number
  historicalSourceCount?: number
  latestEvidenceAgeDays?: number
  recentEvidenceStatus?: 'none' | 'limited' | 'available'
  /** Generated metadata, kept separate from the readable portrait text. */
  note?: string
}

export interface Person {
  id: string
  name: string
  /** Avatar URL explicitly supplied by an exported sender profile, when available. */
  avatarUrl?: string
  /** Facts are model-extracted only when the original records state them directly. */
  facts: string[]
  /** Cautious preference signals derived from directly stated messages. */
  preferences?: string[]
  /**
   * Verified claim-level evidence retained for later full-conversation
   * consolidation. Older cards may omit this until they are re-extracted.
   */
  evidence?: PersonEvidence[]
  /** Practical interaction suggestions based only on the stored evidence. */
  advice?: string[]
  /** IDs of the exported records the model cited as evidence. */
  sourceIds: string[]
  /** Conversation folders represented by the cited records, used to avoid unsafe name-only merges. */
  conversationIds?: string[]
  /** The earliest timestamp among the records cited for this card. This is not a claim about when people met. */
  firstObservedAt?: string
  /** The latest timestamp among cited records, used only to order verified interaction depth. */
  lastObservedAt?: string
  /** A cautious, explicitly non-factual impression derived from the cited dialogue. */
  portrait?: string
  /** Structured portrait paragraphs. The legacy portrait field is derived from these blocks. */
  portraitBlocks?: PersonPortraitBlock[]
  /** Evidence coverage is metadata and must never be merged into portrait prose. */
  portraitCoverage?: PersonPortraitCoverage
  portraitSchemaVersion?: number
  /** Source records the final portrait explicitly relied on; never inferred locally. */
  portraitSourceIds?: string[]
  /** Background the user has personally confirmed; it is never presented as chat evidence. */
  profileNotes?: string
  /** Whether the current portrait incorporated the user-confirmed background. */
  profileNotesUsed?: boolean
  /** Evidence signature used to avoid regenerating the same portrait forever. */
  portraitEvidenceSignature?: string
  /** Local lifecycle state for the bounded portrait consolidation pass. */
  portraitStatus?: 'processing' | 'ready' | 'failed'
  /** Last deterministic or provider error after portrait validation failed. */
  portraitFailure?: string
  /** Persisted retry count so a reload cannot silently restart an exhausted loop. */
  portraitRetryCount?: number
  platforms: IntelItem['source'][]
  model: string
  createdAt: string
}

export interface IntelItem {
  id: string
  title: string
  summary: string
  /** Original message body from the export, without a prepended sender label. */
  content?: string
  source: '微信导出' | 'QQ 导出' | '朋友圈导出' | '校园平台' | '本地文件' | '手动记录' | 'AI 对话导入'
  /** Relative path inside the explicitly authorized export directory. */
  sourceFile?: string
  /** Stable folder-derived key. One exported folder represents one conversation. */
  conversationId?: string
  conversationName?: string
  conversationKind?: 'group' | 'direct' | 'unknown'
  /** Sender label from the export, when it is explicitly present. */
  speaker?: string
  /** Safe remote/data image URL explicitly supplied by the export. */
  avatarUrl?: string
  /** Exporter-provided message/direction label (for example, its raw `type` field). */
  messageType?: string
  /** Only exporter-provided direction is trusted; names and folders are never used to infer it. */
  speakerRole?: 'self' | 'other' | 'unknown'
  capturedAt: string
  status: 'new' | 'reviewed'
  aiAnalyzedAt?: string
}

export type DailyMedicationStatus = 'yes' | 'no' | 'reduced' | 'unknown'
export type DailyAlcoholLevel = 'none' | 'low' | 'high' | 'unknown'

/** A locally verifiable, non-diagnostic observation about the app user. */
export type SelfObservationKind =
  | 'event'
  | 'behavior'
  | 'emotional-state'
  | 'cognition'
  | 'relationship'
  | 'decision'
  | 'routine'
  | 'stressor'
  | 'coping'
  | 'change'
  | 'uncertainty'

export interface SelfObservationEvidence {
  sourceId: string
  quote: string
}

export interface SelfObservation {
  id: string
  kind: SelfObservationKind
  text: string
  evidence: SelfObservationEvidence[]
  sourceIds: string[]
  /** Derived locally from cited archive rows. */
  observedFrom: string
  /** Derived locally from cited archive rows. */
  observedTo: string
}

/** An explanatory, explicitly non-diagnostic professional concept. */
export interface SelfAnalysisProfessionalContext {
  term: string
  explanation: string
  observationIds: string[]
  sourceIds: string[]
}

/** One readable self-analysis paragraph with explicit observation provenance. */
export interface SelfAnalysisNarrativeBlock {
  text: string
  observationIds: string[]
  sourceIds: string[]
}

export interface SelfAnalysisPeriod {
  id: string
  startAt: string
  endAt: string
  title: string
  narrative: string
  paragraphs: SelfAnalysisNarrativeBlock[]
  themes: string[]
  observationIds: string[]
  sourceIds: string[]
  professionalContexts: SelfAnalysisProfessionalContext[]
}

/**
 * The latest evidence-linked interpretation of the user's own history. The
 * archive remains authoritative; this stores only traceable period summaries.
 */
export interface SelfAnalysis {
  version: 1
  generatedAt: string
  analysisAsOf: string
  sourceRecordCount: number
  sourceCheckInCount: number
  observationCount: number
  periods: SelfAnalysisPeriod[]
  currentSummary?: string
  limitations?: string[]
  model: string
}

/**
 * One optional daily anchor. It remains structured for trend views and is
 * mirrored as a self-journal archive message for future self analysis.
 */
export interface DailyCheckIn {
  /** Stable one-per-day key: `self-checkin-YYYY-MM-DD`. */
  id: string
  /** Calendar date in the user's local time zone. */
  date: string
  mood?: 1 | 2 | 3 | 4 | 5
  sleepHours?: number
  medication: DailyMedicationStatus
  alcohol: DailyAlcoholLevel
  mainFocus?: string
  note?: string
  createdAt: string
  updatedAt: string
}

/** A lightweight description of the local raw-message archive. Raw messages stay in IndexedDB. */
export interface ArchiveImportSummary {
  importedAt: string
  parsedMessageCount: number
  addedMessageCount: number
  updatedMessageCount: number
  duplicateMessageCount: number
  archiveMessageCount: number
  conversationCount: number
}

export interface ArchiveAnalysisSummary {
  analyzedAt: string
  sourceMessageCount: number
  conversationCount: number
  processedConversationCount: number
  requestedConversationCount: number
}

export interface ArchiveSummary {
  /** Summary schema only. It deliberately never contains raw message bodies. */
  version: 1
  /** Number of JSON/CSV/TXT files in the authoritative connected directory. */
  fileCount?: number
  /** Hash of the authoritative directory file list used to select the right snapshot. */
  sourceFingerprint?: string
  messageCount: number
  conversationCount: number
  identifiedConversationCount: number
  /** Distinct conversations explicitly classified as direct chats. */
  directConversationCount?: number
  /** Distinct conversations explicitly classified as group chats. */
  groupConversationCount?: number
  messagesWithoutConversation: number
  lastImport?: ArchiveImportSummary
  lastAnalysis?: ArchiveAnalysisSummary
}

export type AiAnalysisMode = 'balanced' | 'action' | 'planning' | 'review'
export type AiRecencyPolicy = 'strict' | 'balanced' | 'broad'
export type AiFeedbackReason = 'useful' | 'expired' | 'ownership' | 'completed' | 'not-actionable' | 'incorrect' | 'other'

/** A compact, local-only checkpoint for an extraction paused by the user or an app close. */
export interface AiExtractionCheckpoint {
  version: 1
  /** A combined run completes task, people, then self analysis in order. */
  stage: 'tasks' | 'people' | 'self'
  targets: { tasks: boolean; people: boolean; self: boolean }
  scope: 'unprocessed' | 'new' | 'all'
  timelineMode: 'last-chat' | 'strict-window'
  timelineStart?: string
  timelineEnd?: string
  conversationId?: string
  /** Conversation identities only. Original messages remain in the archive. */
  conversationIds: string[]
  /** Fully settled conversations that do not need to be submitted again. */
  completedConversationIds: string[]
  startedAt: string
  pausedAt?: string
}

export interface AiPromptInstructions {
  task: string
  people: string
  peopleMerge: string
  taskGuidance: string
  selfObservation: string
  selfMerge: string
}

export interface AiTaskFeedback {
  id: string
  title: string
  description: string
  decision: 'accepted' | 'dismissed'
  reason: AiFeedbackReason
  sourceCapturedAt?: string
  createdAt: string
}

export interface AiAnalysisWatermarks {
  tasks?: Record<string, string>
  people?: Record<string, string>
}

export type AiMultiModelWorkflow = 'tasks' | 'people'

/**
 * A participant's purpose is explicit so a capable judge can never
 * accidentally be scheduled as an extractor (or vice versa). The old generic
 * `extractor` / `reviewer` values are accepted only while normalizing stored
 * settings and are written back in one of these canonical forms.
 */
export type AiModelParticipantRole =
  | 'task-extractor'
  | 'task-judge'
  | 'people-claim-extractor'
  | 'people-judge'

/**
 * A bounded chronological window which an extractor model can reliably
 * analyse. It is a capability declaration, not an estimate of model quality.
 * Overlap is context-only and must never count as independent evidence.
 */
export interface AiMultiModelSegmentProfile {
  id: string
  maxCoreRecords: number
  maxCoreChars: number
  overlapRecords: number
  overlapChars: number
  /** Reserved for a future per-pass request budget; no current request reads it. */
  maxOutputTokens?: number
}

/** A saved model selection for a future ensemble pass. API credentials remain channel-owned. */
export interface AiModelParticipant {
  id: string
  workflow: AiMultiModelWorkflow
  role: AiModelParticipantRole
  channelId: string
  model: string
  /** Only extractors use this. Judges receive verified claims rather than raw message windows. */
  segmentProfileId?: string
  enabled: boolean
}

/**
 * Single remains the default and preserves today's routing behaviour. Ensemble
 * is opt-in: extractors propose independently, then a judge receives only
 * deterministic, evidence-linked observations for consolidation.
 */
export interface AiMultiModelSettings {
  version: 1
  mode: 'single' | 'ensemble'
  maxExtractorsPerConversation: number
  /** Profiles are selected by individual extractor participants. */
  segmentProfiles: AiMultiModelSegmentProfile[]
  participants: AiModelParticipant[]
}

export interface AiSettings {
  mode: AiAnalysisMode
  instructions: string
  autoEnabled: boolean
  intervalHours: number
  recencyPolicy: AiRecencyPolicy
  /** Maximum number of independent conversation requests in flight. */
  concurrency?: number
  feedback: AiTaskFeedback[]
  /** User-editable instructions for each model workflow. Evidence guards remain server-enforced. */
  promptInstructions: AiPromptInstructions
  lastRunAt?: string
  /** A completed task run that explicitly requested the follow-up people workflow. */
  lastPeopleFollowupAt?: string
  /** Persisted while an extraction has not reached its final stage. */
  interruptedRun?: AiExtractionCheckpoint
  /** Compact per-conversation completion markers, separated by workflow. */
  analysisWatermarks?: AiAnalysisWatermarks
  /** Opt-in multi-model policy. Empty/single performs no extra model calls. */
  multiModel: AiMultiModelSettings
}

export interface AiTaskCandidate {
  id: string
  title: string
  description: string
  startAt?: string
  dueAt?: string
  sourceCapturedAt?: string
  sourceIds: string[]
  people: string[]
  place?: string
  locationPrecision?: 'exact' | 'approximate' | 'unknown'
  locationRadiusMeters?: number
  tags: string[]
  guidance?: string[]
  model: string
  createdAt: string
  status: 'pending' | 'created' | 'dismissed'
}

export interface Profile {
  name: string
  /** Optional user-selected avatar stored locally or supplied by a safe URL. */
  avatarUrl?: string
}

export interface BackgroundSetting {
  imageId?: string
  url?: string
  scale: number
  blur: number
}

export interface DynamicBackgroundSettings {
  preset: DynamicBackgroundPreset
  /** Visual opacity expressed as a percentage. */
  intensity: number
  /** Animation tempo expressed as a percentage. */
  speed: number
}

export interface AppearanceSettings {
  theme: AppearanceTheme
  motionEnabled: boolean
  performanceVersion: 1
  backgrounds: Record<BackgroundTarget, BackgroundSetting>
  dynamicBackground: DynamicBackgroundSettings
}

export interface AppData {
  profile: Profile
  quests: Quest[]
  places: Place[]
  people: Person[]
  /** Direct conversations whose passive fallback card was explicitly removed; model extraction may recreate them. */
  dismissedPersonConversationIds: string[]
  /** Tracks the one-time fix for legacy bulk person-card deletion semantics. */
  peopleDismissalVersion?: number
  /** Migration marker for evidence-verified model-derived people cards. */
  peopleModelVersion: 5
  /** Optional daily state anchors, synchronized independently from raw archive rows. */
  dailyCheckins: DailyCheckIn[]
  /** Latest source-linked analysis of the app user's own records. */
  selfAnalysis?: SelfAnalysis
  intel: IntelItem[]
  archive: ArchiveSummary
  aiCandidates: AiTaskCandidate[]
  aiSettings: AiSettings
  appearance: AppearanceSettings
  /** Shared user layout for the task atlas. */
  atlas: TaskAtlasLayout
}

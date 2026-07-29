export type ViewId = 'quests' | 'timeline' | 'map' | 'people' | 'intel' | 'settings'
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

export interface Person {
  id: string
  name: string
  /** Avatar URL explicitly supplied by an exported sender profile, when available. */
  avatarUrl?: string
  /** Facts are model-extracted only when the original records state them directly. */
  facts: string[]
  /** Cautious preference signals derived from directly stated messages. */
  preferences?: string[]
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
  source: '微信导出' | 'QQ 导出' | '朋友圈导出' | '校园平台' | '本地文件' | '手动记录'
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
  messageCount: number
  conversationCount: number
  identifiedConversationCount: number
  messagesWithoutConversation: number
  lastImport?: ArchiveImportSummary
  lastAnalysis?: ArchiveAnalysisSummary
}

export type AiAnalysisMode = 'balanced' | 'action' | 'planning' | 'review'
export type AiRecencyPolicy = 'strict' | 'balanced' | 'broad'
export type AiFeedbackReason = 'useful' | 'expired' | 'ownership' | 'completed' | 'not-actionable' | 'incorrect' | 'other'

export interface AiPromptInstructions {
  task: string
  people: string
  peopleMerge: string
  taskGuidance: string
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

export interface AiSettings {
  mode: AiAnalysisMode
  instructions: string
  autoEnabled: boolean
  intervalHours: number
  recencyPolicy: AiRecencyPolicy
  feedback: AiTaskFeedback[]
  /** User-editable instructions for each model workflow. Evidence guards remain server-enforced. */
  promptInstructions: AiPromptInstructions
  lastRunAt?: string
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
  /** Direct conversations explicitly removed by the user. They must not recreate a local fallback card on the next sync. */
  dismissedPersonConversationIds: string[]
  /** Migration marker for evidence-verified model-derived people cards. */
  peopleModelVersion: 3
  intel: IntelItem[]
  archive: ArchiveSummary
  aiCandidates: AiTaskCandidate[]
  aiSettings: AiSettings
  appearance: AppearanceSettings
  /** Shared user layout for the task atlas. */
  atlas: TaskAtlasLayout
}

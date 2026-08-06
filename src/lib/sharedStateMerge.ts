import type { AiTaskCandidate, AppData, ContextEvent, DailyCheckIn, Person, Place, Quest, TaskAtlasLayout } from '../types'

type SharedFields = Pick<AppData,
  | 'quests'
  | 'places'
  | 'people'
  | 'dismissedPersonConversationIds'
  | 'peopleDismissalVersion'
  | 'peopleModelVersion'
  | 'dailyCheckins'
  | 'contextEvents'
  | 'selfAnalysis'
  | 'aiCandidates'
  | 'atlas'
>
export type SharedData = Omit<SharedFields, 'peopleModelVersion'> & { peopleModelVersion?: number }

export function toSharedData(data: AppData): SharedData {
  return {
    quests: Array.isArray(data.quests) ? data.quests : [],
    places: Array.isArray(data.places) ? data.places : [],
    people: Array.isArray(data.people) ? data.people : [],
    dismissedPersonConversationIds: Array.isArray(data.dismissedPersonConversationIds) ? data.dismissedPersonConversationIds : [],
    peopleDismissalVersion: data.peopleDismissalVersion,
    peopleModelVersion: typeof data.peopleModelVersion === 'number' ? data.peopleModelVersion : undefined,
    dailyCheckins: Array.isArray(data.dailyCheckins) ? data.dailyCheckins : [],
    contextEvents: Array.isArray(data.contextEvents) ? data.contextEvents : [],
    selfAnalysis: data.selfAnalysis,
    aiCandidates: Array.isArray(data.aiCandidates) ? data.aiCandidates : [],
    atlas: data.atlas?.categoryPositions ? data.atlas : { categoryPositions: {} },
  }
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function sharedDataEqual(left: SharedData, right: SharedData) {
  return sameValue(left.quests, right.quests)
    && sameValue(left.places, right.places)
    && sameValue(left.people, right.people)
    && sameValue(left.aiCandidates, right.aiCandidates)
    && sameValue(left.dismissedPersonConversationIds, right.dismissedPersonConversationIds)
    && left.peopleDismissalVersion === right.peopleDismissalVersion
    && left.peopleModelVersion === right.peopleModelVersion
    && sameValue(left.dailyCheckins, right.dailyCheckins)
    && sameValue(left.contextEvents, right.contextEvents)
    && sameValue(left.selfAnalysis, right.selfAnalysis)
    && sameValue(left.atlas, right.atlas)
}

function mergeEntities<T extends { id: string }>(base: T[], local: T[], remote: T[]) {
  const baseById = new Map(base.map((item) => [item.id, item]))
  const localById = new Map(local.map((item) => [item.id, item]))
  const remoteById = new Map(remote.map((item) => [item.id, item]))

  // Apply local deletions to the remote snapshot so a stale window cannot
  // resurrect an entity that the user deliberately removed.
  for (const id of baseById.keys()) {
    if (!localById.has(id)) remoteById.delete(id)
  }
  // Unchanged local entities yield to remote edits. Only a local addition or
  // edit overrides the corresponding remote entity.
  for (const item of local) {
    const baseItem = baseById.get(item.id)
    // A deletion is an explicit user action. If the remote side deleted a
    // base entity, a stale local edit must not recreate it.
    if (baseItem && !remoteById.has(item.id)) continue
    if (!baseItem || !sameValue(baseItem, item)) remoteById.set(item.id, item)
  }

  const ordered: T[] = []
  const emitted = new Set<string>()
  for (const item of local) {
    const merged = remoteById.get(item.id)
    if (!merged) continue
    ordered.push(merged)
    emitted.add(item.id)
  }
  for (const item of remote) {
    if (emitted.has(item.id) || !remoteById.has(item.id)) continue
    ordered.push(remoteById.get(item.id) as T)
    emitted.add(item.id)
  }
  return ordered
}

function mergeStringSet(base: string[], local: string[], remote: string[]) {
  const baseSet = new Set(base)
  const localSet = new Set(local)
  const result = new Set(remote)
  for (const value of baseSet) if (!localSet.has(value)) result.delete(value)
  for (const value of localSet) if (!baseSet.has(value)) result.add(value)
  return [...result]
}

function mergeAtlas(base: TaskAtlasLayout, local: TaskAtlasLayout, remote: TaskAtlasLayout): TaskAtlasLayout {
  const basePositions = base?.categoryPositions ?? {}
  const localPositions = local?.categoryPositions ?? {}
  const positions = { ...(remote?.categoryPositions ?? {}) }
  for (const key of Object.keys(basePositions) as Array<keyof typeof basePositions>) {
    if (!(key in localPositions)) delete positions[key]
  }
  for (const [key, value] of Object.entries(localPositions)) {
    if (!sameValue(basePositions[key as keyof typeof basePositions], value)) {
      positions[key as keyof typeof positions] = value
    }
  }
  return { categoryPositions: positions }
}

/** Applies only the local changes since base on top of the latest remote state. */
export function mergeSharedChanges(base: SharedData, local: SharedData, remote: SharedData): SharedData {
  return {
    quests: mergeEntities<Quest>(base.quests, local.quests, remote.quests),
    places: mergeEntities<Place>(base.places, local.places, remote.places),
    people: mergeEntities<Person>(base.people, local.people, remote.people),
    dailyCheckins: mergeEntities<DailyCheckIn>(base.dailyCheckins ?? [], local.dailyCheckins ?? [], remote.dailyCheckins ?? []),
    contextEvents: mergeEntities<ContextEvent>(base.contextEvents ?? [], local.contextEvents ?? [], remote.contextEvents ?? []),
    // Self analysis is regenerated as one source-linked snapshot. Merging its
    // paragraphs would break evidence ownership, so the changed local result
    // wins; otherwise retain the latest remote result.
    selfAnalysis: !sameValue(base.selfAnalysis, local.selfAnalysis) ? local.selfAnalysis : remote.selfAnalysis,
    aiCandidates: mergeEntities<AiTaskCandidate>(base.aiCandidates, local.aiCandidates, remote.aiCandidates),
    dismissedPersonConversationIds: mergeStringSet(
      base.dismissedPersonConversationIds,
      local.dismissedPersonConversationIds,
      remote.dismissedPersonConversationIds,
    ),
    peopleDismissalVersion: local.peopleDismissalVersion !== base.peopleDismissalVersion
      ? local.peopleDismissalVersion
      : remote.peopleDismissalVersion,
    peopleModelVersion: local.peopleModelVersion !== base.peopleModelVersion
      ? local.peopleModelVersion
      : remote.peopleModelVersion,
    atlas: mergeAtlas(base.atlas, local.atlas, remote.atlas),
  }
}

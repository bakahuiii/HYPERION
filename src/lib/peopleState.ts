import type { AppData, Person } from '../types'

export function resolvePersonDismissals(additions: Person[], dismissedIds: Iterable<string>, explicitExtraction = false) {
  const dismissed = new Set(dismissedIds)
  const restoredConversationIds = explicitExtraction
    ? [...new Set(additions.flatMap((person) => person.conversationIds ?? []))]
    : []
  return {
    additions: explicitExtraction
      ? additions
      : additions.filter((person) => !(person.conversationIds ?? []).some((id) => dismissed.has(id))),
    restoredConversationIds,
  }
}

/**
 * Applies deliberate conversation-level deletions to an already merged
 * snapshot. This is separate from resolvePersonDismissals because remote
 * snapshots contain existing people, not just new fallback additions.
 */
export function filterDismissedPeople(people: Person[], dismissedIds: Iterable<string>) {
  const dismissed = new Set(dismissedIds)
  if (!dismissed.size) return people
  const visible = people.filter((person) => !(person.conversationIds ?? []).some((id) => dismissed.has(id)))
  return visible.length === people.length ? people : visible
}

/**
 * Removes person cards and every task reference to them. Conversation IDs are
 * retained as passive-fallback suppressions; an explicit model extraction can
 * still recreate the cards and clear those suppressions later.
 */
export function removePeopleCards(current: AppData, ids: Iterable<string>, dismissalVersion: number): AppData {
  const removedIds = new Set(ids)
  if (!removedIds.size) return current

  const removedPeople = current.people.filter((person) => removedIds.has(person.id))
  if (!removedPeople.length) return current

  return {
    ...current,
    people: current.people.filter((person) => !removedIds.has(person.id)),
    quests: current.quests.map((quest) => {
      const existingIds = Array.isArray(quest.characterIds) ? quest.characterIds : []
      const characterIds = existingIds.filter((personId) => !removedIds.has(personId))
      return characterIds.length === existingIds.length && Array.isArray(quest.characterIds)
        ? quest
        : { ...quest, characterIds }
    }),
    dismissedPersonConversationIds: [...new Set([
      ...current.dismissedPersonConversationIds,
      ...removedPeople.flatMap((person) => person.conversationIds ?? []),
    ])],
    peopleDismissalVersion: dismissalVersion,
  }
}

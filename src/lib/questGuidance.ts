import type { Person, Place, Quest } from '../types'

function stableId(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** Everything that can materially change generated task advice. */
export function taskGuidanceSignature(quest: Quest, people: Person[], places: Place[]) {
  const characterIds = [...new Set(quest.characterIds)].sort()
  const linkedPeople = people
    .filter((person) => characterIds.includes(person.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((person) => ({
      id: person.id,
      facts: person.facts,
      preferences: person.preferences ?? [],
      portrait: person.portrait ?? '',
      profileNotes: person.profileNotes ?? '',
      profileNotesUsed: person.profileNotesUsed === true,
      sourceIds: person.sourceIds,
    }))
  const place = places.find((item) => item.id === quest.locationId)
  return stableId(JSON.stringify({
    quest: [quest.id, quest.title, quest.description, quest.startAt ?? '', quest.dueAt ?? '', quest.locationId, characterIds],
    place: place ? [place.id, place.name, place.lat, place.lng, place.note, place.precision ?? 'exact', place.radiusMeters ?? null] : null,
    people: linkedPeople,
  }))
}

function sameIds(left: string[], right: string[]) {
  const leftIds = [...new Set(left)].sort()
  const rightIds = [...new Set(right)].sort()
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index])
}

/** Prevents a late model response from overwriting an edit made in flight. */
export function taskGuidanceRequestIsCurrent(
  currentQuest: Quest | undefined,
  baselineQuest: Quest,
  effectiveCharacterIds: string[],
  people: Person[],
  places: Place[],
  expectedSignature: string,
) {
  if (!currentQuest || !sameIds(currentQuest.characterIds, baselineQuest.characterIds)) return false
  return taskGuidanceSignature({ ...currentQuest, characterIds: effectiveCharacterIds }, people, places) === expectedSignature
}

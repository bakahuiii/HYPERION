import type { AppData } from '../types.ts'
import { mergeSharedChanges, sharedDataEqual, toSharedData, type SharedData } from './sharedStateMerge.ts'

interface SharedHydrationOptions {
  peopleModelVersion: AppData['peopleModelVersion']
  peopleDismissalVersion: number
}

export interface SharedHydrationResult {
  data: AppData
  merged: SharedData
  skipEchoWrite: boolean
}

/**
 * Applies local edits made since the last shared base on top of a remote
 * snapshot while preserving renderer-only archive data.
 */
export function hydrateSharedSnapshot(
  current: AppData,
  base: SharedData,
  remote: SharedData,
  options: SharedHydrationOptions,
): SharedHydrationResult {
  const merged = mergeSharedChanges(base, toSharedData(current), remote)
  const hasLocalChanges = !sharedDataEqual(merged, remote)
  const keepPeople = merged.peopleModelVersion === options.peopleModelVersion && Array.isArray(merged.people)
  const keepLocalDismissals = current.peopleDismissalVersion === options.peopleDismissalVersion
    && merged.peopleDismissalVersion !== options.peopleDismissalVersion

  return {
    merged,
    skipEchoWrite: keepPeople && !hasLocalChanges,
    data: {
      ...current,
      ...merged,
      dismissedPersonConversationIds: keepLocalDismissals
        ? current.dismissedPersonConversationIds
        : merged.dismissedPersonConversationIds,
      peopleDismissalVersion: keepLocalDismissals
        ? current.peopleDismissalVersion
        : merged.peopleDismissalVersion,
      people: keepPeople ? merged.people : [],
      intel: current.intel,
      peopleModelVersion: options.peopleModelVersion,
    },
  }
}

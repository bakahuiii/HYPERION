import type { Quest } from '../types'

/** Removes one quest while keeping its direct children usable and editable. */
export function removeQuestAndDetachChildren(quests: Quest[], id: string): Quest[] {
  if (!quests.some((quest) => quest.id === id)) return quests
  return quests.flatMap((quest) => {
    if (quest.id === id) return []
    if (quest.parentId !== id) return [quest]
    const detached = { ...quest }
    delete detached.parentId
    delete detached.unlockedByParent
    return [{
      ...detached,
      status: quest.status === 'locked' ? 'available' : quest.status,
      previousStatus: quest.previousStatus === 'locked' ? 'available' : quest.previousStatus,
    }]
  })
}

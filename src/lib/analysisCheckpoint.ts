import type { AiExtractionCheckpoint } from '../types'

/** Restricts a saved run to explicit failures while preserving its workflow stage. */
export function checkpointForRetry(checkpoint: AiExtractionCheckpoint | undefined, retryConversationIds: string[]) {
  if (!checkpoint) return undefined
  const allowed = new Set(checkpoint.conversationIds)
  const conversationIds = [...new Set(retryConversationIds.filter((id) => allowed.has(id)))]
  if (!conversationIds.length) return undefined
  const retry = {
    ...checkpoint,
    conversationIds,
    completedConversationIds: [],
  } satisfies AiExtractionCheckpoint
  delete retry.pausedAt
  return retry
}

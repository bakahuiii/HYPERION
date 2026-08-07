import type { AiSettings } from '../types'

export function automaticTriggerIsDue(
  mode: AiSettings['autoTriggerMode'],
  timeDue: boolean,
  pendingRecordCount: number,
  messageThreshold: number,
) {
  const countDue = pendingRecordCount >= Math.max(1, Number(messageThreshold) || 50)
  if (mode === 'time') return timeDue
  if (mode === 'message-count') return countDue
  return timeDue || countDue
}

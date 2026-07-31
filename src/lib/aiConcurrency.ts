export const DEFAULT_AI_CONCURRENCY = 4
/**
 * The server applies a second limit per provider channel. Values above eight
 * are useful only after the user has configured multiple independent channels.
 */
export const AI_CONCURRENCY_OPTIONS = Array.from({ length: 32 }, (_, index) => index + 1)

export function normalizeAiConcurrency(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_AI_CONCURRENCY
  return Math.min(32, Math.max(1, Math.floor(parsed)))
}

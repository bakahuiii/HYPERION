export const DEFAULT_AI_CONCURRENCY = 4
export const MAX_AI_CONCURRENCY = 64
/**
 * The server applies a second limit per provider channel. The client can keep
 * several independently configured channels busy at once, while the provider
 * pool still enforces the per-channel ceiling.
 */
export const AI_CONCURRENCY_OPTIONS = Array.from({ length: MAX_AI_CONCURRENCY }, (_, index) => index + 1)

export function normalizeAiConcurrency(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_AI_CONCURRENCY
  return Math.min(MAX_AI_CONCURRENCY, Math.max(1, Math.floor(parsed)))
}

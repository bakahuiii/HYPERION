export function recoverArray<T>(value: unknown, fallback: readonly T[]): T[] {
  return Array.isArray(value) ? value as T[] : [...fallback]
}

interface SnapshotMarker {
  updatedAt?: string | null
  sourceFingerprint?: string | null
}

/** Chooses by source identity and timestamp; record count is never freshness. */
export function shouldLoadSharedIntelSnapshot(
  expectedFingerprint: string | null,
  local: SnapshotMarker | null,
  shared: SnapshotMarker | null,
) {
  if (!shared?.updatedAt) return false
  if (!local) return true
  const localMatches = Boolean(expectedFingerprint && local.sourceFingerprint === expectedFingerprint)
  const sharedMatches = Boolean(expectedFingerprint && shared.sourceFingerprint === expectedFingerprint)
  if (sharedMatches && !localMatches) return true
  if (sharedMatches !== localMatches) return false
  // Legacy IndexedDB arrays have no timestamp. A timestamped shared archive
  // is the only version with usable freshness metadata and must win.
  if (!local.updatedAt) return true
  return Boolean(local.updatedAt && shared.updatedAt > local.updatedAt)
}

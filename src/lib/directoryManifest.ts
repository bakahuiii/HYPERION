export interface DirectoryManifestFile {
  path: string
  signature: string
}

export interface DirectoryImportPlan {
  directoryChanged: boolean
  rebuildSnapshot: boolean
  incrementalUpdate: boolean
  changedFiles: DirectoryManifestFile[]
  removedFiles: string[]
  filesToParse: DirectoryManifestFile[]
}

interface DirectoryImportPlanInput {
  files: DirectoryManifestFile[]
  previousManifest: ReadonlyMap<string, string>
  previousFingerprint: string
  currentFingerprint: string
  archiveItemCount: number
  completeSourceProvenance: boolean
  force?: boolean
}

/**
 * Chooses the minimum authoritative directory update without touching browser
 * state. Keeping this decision pure makes deletion and migration behavior
 * independently testable for very large archives.
 */
export function planDirectoryImport({
  files,
  previousManifest,
  previousFingerprint,
  currentFingerprint,
  archiveItemCount,
  completeSourceProvenance,
  force = false,
}: DirectoryImportPlanInput): DirectoryImportPlan {
  const currentManifest = new Map(files.map((entry) => [entry.path, entry.signature]))
  const directoryChanged = !previousFingerprint || previousFingerprint !== currentFingerprint
  const missingManifest = archiveItemCount > 0 && previousManifest.size === 0
  const needsProvenanceBackfill = archiveItemCount > 0 && !completeSourceProvenance
  const rebuildSnapshot = force || archiveItemCount === 0 || missingManifest || needsProvenanceBackfill
  const incrementalUpdate = !rebuildSnapshot && directoryChanged
  const changedFiles = files.filter((entry) => previousManifest.get(entry.path) !== entry.signature)
  const removedFiles = [...previousManifest.keys()].filter((path) => !currentManifest.has(path))

  return {
    directoryChanged,
    rebuildSnapshot,
    incrementalUpdate,
    changedFiles,
    removedFiles,
    filesToParse: rebuildSnapshot ? files : incrementalUpdate ? changedFiles : [],
  }
}

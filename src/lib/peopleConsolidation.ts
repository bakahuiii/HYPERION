/**
 * Portrait consolidation must wait until the evidence extraction fence is
 * released. This is deliberately pure so the cancellation boundary remains
 * covered without mounting the whole React application in a test.
 */
export function canStartPersonConsolidation(
  paused: boolean,
  extractionActive: boolean,
  alreadyScheduled = false,
) {
  return !paused && !extractionActive && !alreadyScheduled
}

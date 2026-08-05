import type { AiTaskCandidate } from '../types'

function compact(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function sourceOverlap(left: AiTaskCandidate, right: AiTaskCandidate) {
  const rightIds = new Set(right.sourceIds)
  return left.sourceIds.some((id) => rightIds.has(id))
}

function calendarDate(value?: string) {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
}

function temporalConflict(left?: string, right?: string) {
  if (!left || !right) return false
  const leftDate = calendarDate(left)
  const rightDate = calendarDate(right)
  if (leftDate && rightDate) return leftDate !== rightDate
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime !== rightTime
  return compact(left) !== compact(right)
}

function placeConflict(left: AiTaskCandidate, right: AiTaskCandidate) {
  if (!left.place || !right.place) return false
  const leftPlace = compact(left.place)
  const rightPlace = compact(right.place)
  if (!leftPlace || !rightPlace || leftPlace === rightPlace) return false
  // "Starbucks" and "Starbucks Wanda branch" are compatible refinements.
  if (leftPlace.includes(rightPlace) || rightPlace.includes(leftPlace)) return false
  return left.locationPrecision === 'exact' && right.locationPrecision === 'exact'
}

function metadataConflict(left: AiTaskCandidate, right: AiTaskCandidate) {
  return temporalConflict(left.startAt, right.startAt)
    || temporalConflict(left.dueAt, right.dueAt)
    || placeConflict(left, right)
}

/**
 * Returns true only for the same task, not merely two tasks with a similar
 * subject. Exact normalized title/description matches are duplicates even if
 * one response omitted optional metadata. A shared evidence record additionally
 * allows harmless wording drift at an overlap boundary when either the title or
 * description is unchanged.
 */
export function aiTaskCandidatesDuplicate(left: AiTaskCandidate, right: AiTaskCandidate) {
  const titleSame = compact(left.title) === compact(right.title)
  const descriptionSame = compact(left.description) === compact(right.description)
  if (metadataConflict(left, right)) return false
  if (titleSame && descriptionSame) return true
  return sourceOverlap(left, right) && (titleSame || descriptionSame)
}

function laterTimestamp(left?: string, right?: string) {
  if (!left) return right
  if (!right) return left
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime > leftTime ? right : left
  return right > left ? right : left
}

function mergeUnique(left: string[] = [], right: string[] = []) {
  return [...new Set([...left, ...right].map((value) => String(value).trim()).filter(Boolean))]
}

function mergeCandidate(primary: AiTaskCandidate, duplicate: AiTaskCandidate): AiTaskCandidate {
  const precisionRank = { unknown: 0, approximate: 1, exact: 2 }
  const statusRank = { pending: 0, dismissed: 1, created: 2 }
  const primaryPrecision = primary.locationPrecision ?? 'unknown'
  const duplicatePrecision = duplicate.locationPrecision ?? 'unknown'
  const useDuplicatePlace = !primary.place && Boolean(duplicate.place)
    || precisionRank[duplicatePrecision] > precisionRank[primaryPrecision]
  return {
    ...primary,
    description: duplicate.description.length > primary.description.length ? duplicate.description : primary.description,
    startAt: primary.startAt ?? duplicate.startAt,
    dueAt: primary.dueAt ?? duplicate.dueAt,
    sourceCapturedAt: laterTimestamp(primary.sourceCapturedAt, duplicate.sourceCapturedAt),
    sourceIds: mergeUnique(primary.sourceIds, duplicate.sourceIds).slice(0, 30),
    people: mergeUnique(primary.people, duplicate.people).slice(0, 12),
    place: useDuplicatePlace ? duplicate.place : primary.place,
    locationPrecision: useDuplicatePlace ? duplicate.locationPrecision : primary.locationPrecision,
    locationRadiusMeters: useDuplicatePlace ? duplicate.locationRadiusMeters : primary.locationRadiusMeters,
    tags: mergeUnique(primary.tags, duplicate.tags).slice(0, 10),
    guidance: mergeUnique(primary.guidance, duplicate.guidance).slice(0, 3),
    status: statusRank[duplicate.status] > statusRank[primary.status] ? duplicate.status : primary.status,
  }
}

/** Merge repeated model outputs while retaining the first candidate's identity/status. */
export function mergeAiTaskCandidates(candidates: AiTaskCandidate[]) {
  const merged: AiTaskCandidate[] = []
  for (const candidate of candidates) {
    const existingIndex = merged.findIndex((existing) => aiTaskCandidatesDuplicate(existing, candidate))
    if (existingIndex < 0) merged.push(candidate)
    else merged[existingIndex] = mergeCandidate(merged[existingIndex], candidate)
  }
  return merged
}

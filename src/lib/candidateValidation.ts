import type { AiSettings, AiTaskCandidate, IntelItem } from '../types.ts'

export function hasMessageTimestamp(item: IntelItem) {
  return Number.isFinite(new Date(item.capturedAt).getTime())
}
export function hasAbsoluteCalendarDate(item: IntelItem) {
  return /20\d{2}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}/.test(item.summary)
}

export function isDirectTaskForUser(item: IntelItem) {
  return /(?:请你|麻烦你|需要你|你(?:要|去|得|需要|记得|别忘|先)|别忘了)/.test(item.summary)
}

export function supportsUserOwnedTask(evidence: IntelItem[]) {
  return evidence.some((item) => item.speakerRole === 'self')
    || evidence.some((item) => item.speakerRole === 'other' && isDirectTaskForUser(item))
}

export function latestEvidenceTime(evidence: IntelItem[]) {
  return [...evidence]
    .filter((item) => item.capturedAt.trim())
    .sort((left, right) => {
      const leftTime = new Date(left.capturedAt).getTime()
      const rightTime = new Date(right.capturedAt).getTime()
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime
      return right.capturedAt.localeCompare(left.capturedAt)
    })[0]?.capturedAt
}

export function localDateTime(value: string | undefined, endOfDay = false) {
  if (!value) return Number.NaN
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).getTime()
  return new Date(value).getTime()
}

function isExpiredCandidate(candidate: AiTaskCandidate, evidence: IntelItem[], settings: AiSettings) {
  const now = Date.now()
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startTime = localDateTime(candidate.startAt)
  const dueTime = localDateTime(candidate.dueAt, true)
  if (Number.isFinite(dueTime) && dueTime < todayStart) return true
  if (Number.isFinite(startTime) && startTime < todayStart && (!Number.isFinite(dueTime) || dueTime < now)) return true
  if ((Number.isFinite(startTime) && startTime >= todayStart) || (Number.isFinite(dueTime) && dueTime >= todayStart)) return false

  const latestTime = localDateTime(latestEvidenceTime(evidence) ?? candidate.sourceCapturedAt)
  if (!Number.isFinite(latestTime)) return false
  const ageDays = Math.max(0, (now - latestTime) / 86_400_000)
  const policy = settings.recencyPolicy ?? 'balanced'
  const transientDays = policy === 'strict' ? 2 : policy === 'broad' ? 7 : 4
  const submissionDays = policy === 'strict' ? 14 : policy === 'broad' ? 60 : 30
  const text = `${candidate.title} ${candidate.description}`
  if (/快递|取件|取货|取餐|外卖|包裹|验证码|签到|临时码|柜.*件/.test(text) && ageDays > transientDays) return true
  if (/提交|投稿|征集|报名|问卷|填表|经验分享|上传材料|交材料/.test(text) && !candidate.dueAt && ageDays > submissionDays) return true
  return false
}

function reversesInvitationDirection(candidate: AiTaskCandidate, evidence: IntelItem[]) {
  const otherOffers = evidence.some((item) => item.speakerRole === 'other' && /(?:我|俺).{0,6}(?:请|邀请|带|陪|帮)你/.test(item.content || item.summary))
  const selfOffers = evidence.some((item) => item.speakerRole === 'self' && /(?:我|俺).{0,6}(?:请|邀请|带|陪|帮)(?:你|他|她)/.test(item.content || item.summary))
  return otherOffers && !selfOffers && /(?:^|开学后|之后|到时).{0,8}(?:请|邀请).{0,24}(?:喝|吃|见面|玩|台球|咖啡)/.test(candidate.title)
}

/** Deterministic gate shared by new candidates and saved review items. */
export function candidateRejectionReason(candidate: AiTaskCandidate, evidence: IntelItem[], settings: AiSettings): 'expired' | 'ownership' | undefined {
  if (isExpiredCandidate(candidate, evidence, settings)) return 'expired'
  if (reversesInvitationDirection(candidate, evidence)) return 'ownership'
  return undefined
}

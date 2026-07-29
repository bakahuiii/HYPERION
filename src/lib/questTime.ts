import type { IntelItem, Quest } from '../types'

export function parseQuestTime(value?: string) {
  if (!value) return undefined
  const source = value.trim()
  const dateOnly = source.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    return date.getFullYear() === Number(dateOnly[1]) && date.getMonth() === Number(dateOnly[2]) - 1 && date.getDate() === Number(dateOnly[3]) ? date : undefined
  }
  const date = new Date(source)
  return Number.isNaN(date.getTime()) ? undefined : date
}

type QuestTimeFields = Pick<Quest, 'startAt' | 'dueAt' | 'sourceIds' | 'sourceCapturedAt'>

export function questSourceTime(quest: QuestTimeFields, intel: Pick<IntelItem, 'id' | 'capturedAt'>[] = []) {
  if (!quest.sourceIds?.length) return quest.sourceCapturedAt
  return intel
    .filter((item) => quest.sourceIds?.includes(item.id) && item.capturedAt.trim())
    .sort((left, right) => {
      const leftTime = parseQuestTime(left.capturedAt)?.getTime() ?? Number.NEGATIVE_INFINITY
      const rightTime = parseQuestTime(right.capturedAt)?.getTime() ?? Number.NEGATIVE_INFINITY
      return rightTime - leftTime
    })[0]?.capturedAt ?? quest.sourceCapturedAt
}

export function questTimelineAt(quest: QuestTimeFields, intel: Pick<IntelItem, 'id' | 'capturedAt'>[] = []) {
  return quest.startAt || quest.dueAt || questSourceTime(quest, intel)
}

export function timelineSortValue(quest: QuestTimeFields, intel: Pick<IntelItem, 'id' | 'capturedAt'>[] = []) {
  return parseQuestTime(questTimelineAt(quest, intel))?.getTime() ?? Number.POSITIVE_INFINITY
}

function formatDate(value?: string) {
  const date = parseQuestTime(value)
  if (!date) return value?.trim() || '未记录信息源时间'
  const day = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  return /T|\s\d{1,2}:/.test(value ?? '') ? `${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : day
}

export function formatTimelineClock(value?: string) {
  const date = parseQuestTime(value)
  if (!date) return '待定'
  return /T|\s\d{1,2}:/.test(value ?? '') ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '全天'
}

export function formatQuestTime(quest: QuestTimeFields, intel: Pick<IntelItem, 'id' | 'capturedAt'>[] = []) {
  if (quest.startAt && quest.dueAt) {
    if (quest.startAt === quest.dueAt) return `发生：${formatDate(quest.startAt)}`
    return `开始/发生：${formatDate(quest.startAt)}；截止：${formatDate(quest.dueAt)}`
  }
  if (quest.startAt) return `开始/发生：${formatDate(quest.startAt)}`
  if (quest.dueAt) return `截止：${formatDate(quest.dueAt)}`
  const capturedAt = questSourceTime(quest, intel)
  return capturedAt ? `信息源时间：${formatDate(capturedAt)}` : '未记录信息源时间'
}

/** Only a stated target/start/deadline belongs here; source timestamps never become an estimated target. */
export function formatQuestTargetTime(quest: Pick<Quest, 'startAt' | 'dueAt'>) {
  if (quest.startAt && quest.dueAt) {
    if (quest.startAt === quest.dueAt) return `发生：${formatDate(quest.startAt)}`
    return `开始：${formatDate(quest.startAt)}；截止：${formatDate(quest.dueAt)}`
  }
  if (quest.startAt) return `开始/发生：${formatDate(quest.startAt)}`
  if (quest.dueAt) return `截止：${formatDate(quest.dueAt)}`
  return '未在来源中明确目标时间'
}

export function formatQuestSourceTime(quest: QuestTimeFields, intel: Pick<IntelItem, 'id' | 'capturedAt'>[] = []) {
  const capturedAt = questSourceTime(quest, intel)
  return capturedAt ? formatDate(capturedAt) : '未记录信息源时间'
}

export function timelineDayKey(quest: QuestTimeFields, intel: Pick<IntelItem, 'id' | 'capturedAt'>[] = []) {
  const date = parseQuestTime(questTimelineAt(quest, intel))
  if (!date) return '未记录信息源时间'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

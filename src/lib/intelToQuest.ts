import type { IntelItem } from '../types'

const actionWords = [
  '需要', '记得', '别忘', '截止', '提交', '报名', '缴费', '预约', '约', '见面', '会议', '上课', '作业', '论文', '考试',
  '购买', '取件', '归还', '还书', '回复', '回信', '联系', '确认', '安排', '准备', '申请', '领取', '报到', '选课',
  '签到', '打卡', '维修', '发送', '发给', '整理', '填写', '上传', '下载', '办理', '提醒', '计划', '明天', '后天', '下周',
  '周一', '周二', '周三', '周四', '周五', '周六', '周日',
]

const noiseWords = ['哈哈', '哈哈哈', '嗯嗯', '好的', '好呀', '收到', '谢谢', '不客气', '在吗', '早安', '晚安', 'ok', '好滴', '笑死']

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function scoreItem(item: IntelItem) {
  const text = `${item.title} ${item.summary}`.toLowerCase()
  let score = 0
  actionWords.forEach((word) => { if (text.includes(word)) score += word.length > 1 ? 2 : 1 })
  if (/\d{1,2}[月\-/]\d{1,2}|\d{1,2}:\d{2}|今天|明天|后天|本周|下周/.test(text)) score += 2
  if (/[?？]|请|麻烦|能否|帮忙/.test(text)) score += 1
  if (text.length >= 15 && text.length <= 220) score += 1
  if (noiseWords.some((word) => text.trim() === word || (text.length < 18 && text.startsWith(word)))) score -= 4
  return score
}

export function selectTaskCandidates(items: IntelItem[]) {
  const seen = new Set<string>()
  return items
    .map((item) => ({ item, score: scoreItem(item) }))
    .filter(({ item, score }) => score >= 3 && item.summary.trim().length >= 8)
    .sort((a, b) => b.score - a.score || b.item.capturedAt.localeCompare(a.item.capturedAt))
    .map(({ item }) => item)
    .filter((item) => {
      const key = normalize(`${item.title} ${item.summary}`).slice(0, 120)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function taskTitle(item: IntelItem) {
  const cleaned = item.title
    .replace(/^(text|message|content|内容|聊天记录)\s*[:：]\s*/i, '')
    .replace(/[.。…]+$/, '')
    .trim()
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned
}

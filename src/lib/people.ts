import type { IntelItem } from '../types'

const ignoredProviders = new Set(['text', 'message', 'content', '内容', '聊天记录', '系统', 'system'])

export function sourceProvider(item: IntelItem) {
  const match = item.summary.match(/^([^:：\n]{1,48})[:：]\s*/)
  const name = match?.[1]?.trim()
  if (!name || ignoredProviders.has(name.toLowerCase())) return undefined
  return name
}

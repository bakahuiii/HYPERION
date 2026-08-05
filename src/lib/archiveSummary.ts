import type { ArchiveSummary, IntelItem } from '../types'

export function archiveConversationKey(item: IntelItem) {
  if (item.conversationId) return item.conversationId
  const month = item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] ?? 'undated'
  // Older imports have no reliable directory identity. Keep these as an
  // explicitly separate fallback bucket instead of pretending they are a chat.
  return `legacy:${item.source}:${month}`
}

export function summarizeArchive(items: IntelItem[], fileCount?: number): ArchiveSummary {
  const identified = new Set<string>()
  const conversationKinds = new Map<string, IntelItem['conversationKind']>()
  let messagesWithoutConversation = 0
  for (const item of items) {
    if (item.conversationId) identified.add(item.conversationId)
    else messagesWithoutConversation += 1
    const key = archiveConversationKey(item)
    const currentKind = conversationKinds.get(key)
    if (!currentKind || currentKind === 'unknown') conversationKinds.set(key, item.conversationKind ?? 'unknown')
  }
  const fallbackConversations = new Set(items.filter((item) => !item.conversationId).map(archiveConversationKey)).size
  const conversationKindValues = [...conversationKinds.values()]
  return {
    version: 1,
    ...(Number.isFinite(fileCount) && Number(fileCount) >= 0 ? { fileCount: Math.floor(Number(fileCount)) } : {}),
    messageCount: items.length,
    conversationCount: identified.size + fallbackConversations,
    identifiedConversationCount: identified.size,
    directConversationCount: conversationKindValues.filter((kind) => kind === 'direct').length,
    groupConversationCount: conversationKindValues.filter((kind) => kind === 'group').length,
    messagesWithoutConversation,
  }
}

export function archiveSummaryWithImport(summary: ArchiveSummary, importSummary: ArchiveSummary['lastImport']): ArchiveSummary {
  return { ...summary, lastImport: importSummary }
}

export function archiveSummaryWithAnalysis(summary: ArchiveSummary, analysis: ArchiveSummary['lastAnalysis']): ArchiveSummary {
  return { ...summary, lastAnalysis: analysis }
}

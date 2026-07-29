import type { ArchiveSummary, IntelItem } from '../types'

export function archiveConversationKey(item: IntelItem) {
  if (item.conversationId) return item.conversationId
  const month = item.capturedAt.match(/^\d{4}-\d{2}/)?.[0] ?? 'undated'
  // Older imports have no reliable directory identity. Keep these as an
  // explicitly separate fallback bucket instead of pretending they are a chat.
  return `legacy:${item.source}:${month}`
}

export function summarizeArchive(items: IntelItem[]): ArchiveSummary {
  const identified = new Set<string>()
  let messagesWithoutConversation = 0
  for (const item of items) {
    if (item.conversationId) identified.add(item.conversationId)
    else messagesWithoutConversation += 1
  }
  const fallbackConversations = new Set(items.filter((item) => !item.conversationId).map(archiveConversationKey)).size
  return {
    version: 1,
    messageCount: items.length,
    conversationCount: identified.size + fallbackConversations,
    identifiedConversationCount: identified.size,
    messagesWithoutConversation,
  }
}

export function archiveSummaryWithImport(summary: ArchiveSummary, importSummary: ArchiveSummary['lastImport']): ArchiveSummary {
  return { ...summary, lastImport: importSummary }
}

export function archiveSummaryWithAnalysis(summary: ArchiveSummary, analysis: ArchiveSummary['lastAnalysis']): ArchiveSummary {
  return { ...summary, lastAnalysis: analysis }
}

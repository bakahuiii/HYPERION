export interface AttachmentEstimateInput {
  name: string
  size: number
  type?: string
}

export interface AttachmentQueueEstimate {
  fileCount: number
  totalBytes: number
  estimatedTextTokens: number
  imageCount: number
  binaryDocumentCount: number
}

/**
 * Gives a conservative local estimate before upload. Provider-side image and
 * PDF billing varies by model, so those files are counted but never assigned
 * a misleading token number.
 */
export function estimateAttachmentQueue(files: AttachmentEstimateInput[]): AttachmentQueueEstimate {
  let totalBytes = 0
  let estimatedTextTokens = 0
  let imageCount = 0
  let binaryDocumentCount = 0
  for (const file of files) {
    const size = Math.max(0, Number(file.size) || 0)
    totalBytes += size
    const type = file.type?.toLowerCase() ?? ''
    const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(extension)) {
      imageCount += 1
    } else if (type.startsWith('text/') || ['json', 'csv', 'txt', 'md'].includes(extension)) {
      estimatedTextTokens += Math.ceil(size / 3)
    } else {
      binaryDocumentCount += 1
    }
  }
  return { fileCount: files.length, totalBytes, estimatedTextTokens, imageCount, binaryDocumentCount }
}

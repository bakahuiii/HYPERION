function normalizedSourceText(value: string) {
  return value.replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
}

/** Requires a manual-background paragraph to retain a concrete source phrase. */
export function portraitUsesProfileNotes(text: string, profileNotes: string) {
  const portrait = normalizedSourceText(text)
  const chunks = normalizedSourceText(profileNotes)
    .split(/[^\u4e00-\u9fffA-Za-z0-9]+/)
    .filter(Boolean)
  return chunks.some((chunk) => {
    if (chunk.length < 4) return chunk.length >= 2 && portrait.includes(chunk)
    for (let index = 0; index <= chunk.length - 4; index += 1) {
      if (portrait.includes(chunk.slice(index, index + 4))) return true
    }
    return false
  })
}

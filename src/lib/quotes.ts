export interface AtlasQuote {
  text: string
  from: string
  online: boolean
}

export async function getAtlasQuote() {
  const response = await fetch('/api/quote')
  const payload = await response.json() as AtlasQuote & { error?: string }
  if (!response.ok) throw new Error(payload.error || '无法更新铭文')
  return payload
}

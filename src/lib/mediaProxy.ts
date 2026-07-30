function isInlineImage(value: string) {
  return /^data:image\//i.test(value) || /^blob:/i.test(value)
}

/**
 * Keep Chromium from requesting exported social-profile images directly.
 * Remote URLs are fetched by the local service after its host validation.
 */
export function avatarImageUrl(value?: string) {
  const source = value?.trim()
  if (!source) return ''
  if (isInlineImage(source)) return source
  if (/^\/api\/settings\/background\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp|gif|avif)$/i.test(source)) return apiUrl(source)
  if (!/^https?:\/\//i.test(source)) return ''
  return apiUrl(`/api/media/avatar?src=${encodeURIComponent(source)}`)
}
import { apiUrl } from './apiUrl'

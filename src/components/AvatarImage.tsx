import { useState, type ImgHTMLAttributes } from 'react'
import { avatarImageUrl } from '../lib/mediaProxy'

interface AvatarImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> {
  source?: string
}

/** Hides a failed source without leaving the next changed avatar hidden. */
export function AvatarImage({ source, ...props }: AvatarImageProps) {
  const url = avatarImageUrl(source)
  const [failedUrl, setFailedUrl] = useState('')
  if (!url || failedUrl === url) return null
  return <img {...props} src={url} onError={() => setFailedUrl(url)} />
}

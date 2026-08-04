declare global {
  interface Window {
    theiaRuntime?: { apiBase?: string }
    /** Called by the Electron shell before closing the renderer. */
    theiaFlush?: () => Promise<void>
  }
}

export function apiUrl(path: string) {
  const base = window.theiaRuntime?.apiBase?.replace(/\/+$/, '')
  return base && path.startsWith('/api/') ? `${base}${path}` : path
}

/**
 * Development pages normally send `/api` through Vite. Status polling must
 * not share that browser-origin connection pool with long-running extraction
 * requests, otherwise a busy run can make the Options page look empty.
 */
export function localProxyUrl(path: string) {
  const packaged = apiUrl(path)
  if (packaged !== path || !path.startsWith('/api/')) return packaged
  const { protocol, hostname } = window.location
  const isLocalHttp = protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost')
  return isLocalHttp ? `${protocol}//${hostname}:8787${path}` : path
}

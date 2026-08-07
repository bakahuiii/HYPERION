declare global {
  interface Window {
    hyperionRuntime?: { apiBase?: string }
    /** Called by the Electron shell before closing the renderer. */
    hyperionFlush?: () => Promise<void>
  }
}

export function apiUrl(path: string) {
  const base = window.hyperionRuntime?.apiBase?.replace(/\/+$/, '')
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
  const viteEnvironment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const developmentPort = String(viteEnvironment?.VITE_HYPERION_API_PORT || '8787').replace(/\D/g, '') || '8787'
  return isLocalHttp ? `${protocol}//${hostname}:${developmentPort}${path}` : path
}

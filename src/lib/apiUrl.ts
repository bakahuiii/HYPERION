declare global {
  interface Window {
    theiaRuntime?: { apiBase?: string }
  }
}

export function apiUrl(path: string) {
  const base = window.theiaRuntime?.apiBase?.replace(/\/+$/, '')
  return base && path.startsWith('/api/') ? `${base}${path}` : path
}

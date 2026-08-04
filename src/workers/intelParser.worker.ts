/// <reference lib="webworker" />

import type { ImportContext } from '../lib/importer'
import { parseIntelFileContent } from '../lib/importer'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = async (event: MessageEvent<{ file: File; context?: ImportContext }>) => {
  try {
    const items = await parseIntelFileContent(event.data.file, event.data.context ?? {})
    self.postMessage({ items })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

export {}

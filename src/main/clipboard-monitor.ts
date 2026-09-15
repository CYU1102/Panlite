import { clipboard, type BrowserWindow } from 'electron'
import { detectShareLinks, type ShareLinkHit } from '../shared/share-link'
import log from 'electron-log'

const POLL_INTERVAL_MS = 1_200
const DUPLICATE_COOLDOWN_MS = 10 * 60 * 1_000
const MAX_REMEMBERED = 50

export interface ClipboardSharePayload {
  text: string
  links: ShareLinkHit[]
}

interface ClipboardMonitorOptions {
  getWindow: () => BrowserWindow | null
  onDetect: (payload: ClipboardSharePayload) => void
}

interface ClipboardMonitor {
  start: () => void
  stop: () => void
  isRunning: () => boolean
}

let service: ClipboardMonitor | null = null

export function initClipboardMonitor(options: ClipboardMonitorOptions): ClipboardMonitor {
  if (service) return service
  let timer: NodeJS.Timeout | null = null
  let lastText = ''
  const recent = new Map<string, number>()

  let inspecting = false
  let generation = 0

  const inspect = async (): Promise<void> => {
    if (inspecting || !timer) return
    const currentGeneration = generation
    inspecting = true
    try {
      let text = ''
      try {
        // Electron 44 exposes clipboard reads asynchronously. Awaiting also
        // keeps this compatible with older Electron versions that returned text.
        text = await clipboard.readText()
      } catch {
        return
      }
      if (!timer || generation !== currentGeneration) return
      if (!text || text === lastText) return
      lastText = text
      const links = detectShareLinks(text)
      if (!links.length) return
      const now = Date.now()
      for (const [key, seenAt] of recent) {
        if (now - seenAt > DUPLICATE_COOLDOWN_MS) recent.delete(key)
      }
      const fingerprint = links.map(item => `${item.platform}:${item.url}:${item.password || ''}`).join('|')
      const seenAt = recent.get(fingerprint)
      if (seenAt !== undefined) return
      recent.set(fingerprint, now)
      if (recent.size > MAX_REMEMBERED) {
        const oldest = [...recent.entries()].sort((a, b) => a[1] - b[1])[0]
        if (oldest) recent.delete(oldest[0])
      }
      try { options.onDetect({ text, links }) } catch { log.warn('Could not deliver clipboard share notification') }
    } finally {
      inspecting = false
    }
  }

  service = {
    start: () => {
      if (timer) return
      generation++
      lastText = ''
      timer = setInterval(() => { void inspect() }, POLL_INTERVAL_MS)
    },
    stop: () => {
      generation++
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    isRunning: () => timer !== null,
  }
  return service
}

export function getClipboardMonitor(): ClipboardMonitor | null {
  return service
}

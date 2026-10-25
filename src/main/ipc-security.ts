import type { IpcMainInvokeEvent } from 'electron'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

function normalizedPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function getRendererIndexPath(): string {
  return resolve(__dirname, '../../renderer/index.html')
}

/** Return a normalized HTTP(S) URL that is safe to hand to the system browser. */
export function getExternalHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}

function parseAllowedDevOrigin(devServerUrl: string | undefined): string | null {
  if (!devServerUrl) return null
  try {
    const url = new URL(devServerUrl)
    if (url.protocol !== 'http:' || !LOCAL_DEV_HOSTS.has(url.hostname)) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Return whether a URL belongs to PanLite's own renderer.
 * Production uses a local file URL; development is restricted to the
 * explicitly configured Vite origin instead of accepting arbitrary HTTP.
 */
export function isTrustedRendererUrl(
  url: string,
  devServerUrl?: string,
  rendererIndexPath = getRendererIndexPath(),
): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    const configuredDevServerUrl = devServerUrl ?? process.env.VITE_DEV_SERVER_URL
    if (configuredDevServerUrl) {
      const allowedOrigin = parseAllowedDevOrigin(configuredDevServerUrl)
      return Boolean(allowedOrigin && parsed.origin === allowedOrigin)
    }

    if (parsed.protocol !== 'file:' || (parsed.host && parsed.host !== 'localhost')) return false
    return normalizedPath(fileURLToPath(parsed)) === normalizedPath(rendererIndexPath)
  } catch {
    return false
  }
}

/** Reject IPC calls originating from a login window, WebView, or external page. */
export function assertTrustedRenderer(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): void {
  const url = event.senderFrame?.url || event.sender.getURL()
  if (!isTrustedRendererUrl(url)) throw new Error('未经授权的渲染进程 IPC 请求')
}

export type TrustedIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

/** Wrap an IPC handler with the renderer-origin check used by all app handlers. */
export function wrapTrustedIpcHandler(handler: TrustedIpcHandler): TrustedIpcHandler {
  return async (event, ...args) => {
    assertTrustedRenderer(event)
    return handler(event, ...args)
  }
}

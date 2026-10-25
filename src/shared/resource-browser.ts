import { getShareBrowserUrl } from './share-browser'

export const RESOURCE_BROWSER_PARTITION_PREFIX = 'panlite-resource-browser-'
export const RESOURCE_SHARE_OPEN_CHANNEL = 'resource-browser:open-share'
export interface ResourceShareOpen { guestId: number; url: string; password?: string }

/** Whole URL validation: text extraction regexes alone also match deceptive hosts or suffixes. */
export function getResourceShareTarget(value: unknown): Omit<ResourceShareOpen, 'guestId'> | null {
  const normalized = getShareBrowserUrl(value)
  if (!normalized) return null
  const url = new URL(normalized)
  if (url.port) return null
  const paths: Record<string, RegExp> = {
    'pan.quark.cn': /^\/s\/[a-zA-Z0-9]+\/?$/,
    'drive.uc.cn': /^\/s\/[a-zA-Z0-9]+\/?$/,
    'pan.baidu.com': /^\/s\/[a-zA-Z0-9_-]+\/?$/,
    'pan.xunlei.com': /^\/s\/[a-zA-Z0-9_-]+\/?$/,
    'www.alipan.com': /^\/s\/[a-zA-Z0-9_-]+\/?$/,
    'alipan.com': /^\/s\/[a-zA-Z0-9_-]+\/?$/,
    'www.aliyundrive.com': /^\/s\/[a-zA-Z0-9_-]+\/?$/,
    'aliyundrive.com': /^\/s\/[a-zA-Z0-9_-]+\/?$/,
  }
  const legacyBaidu = url.hostname === 'pan.baidu.com' && url.pathname === '/share/init' && /^[a-zA-Z0-9_-]+$/.test(url.searchParams.get('surl') || '')
  if (!legacyBaidu && !paths[url.hostname]?.test(url.pathname)) return null
  const password = url.searchParams.get('pwd')
  return { url: normalized, ...(password && /^[a-zA-Z0-9]{4}$/.test(password) ? { password } : {}) }
}

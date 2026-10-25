export type InlineLoginPlatform = 'quark' | 'uc'
export interface InlineLoginSession { id: string; platform: InlineLoginPlatform; url: string; partition: string }
export interface InlineLoginResult {
  success: boolean
  state?: 'waiting' | 'success' | 'expired'
  session?: InlineLoginSession
  cookies?: string
  nickname?: string
  userAgent?: string
  error?: string
}

export const INLINE_LOGIN_PREFIX = 'panlite-inline-login-'
export const INLINE_LOGIN_URLS = { quark: 'https://pan.quark.cn/', uc: 'https://drive.uc.cn/' } as const

/** Only official HTTPS top-level login destinations; no arbitrary browser fallback. */
export function isInlineLoginUrl(platform: InlineLoginPlatform, value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
    const domain = platform === 'quark' ? 'quark.cn' : 'uc.cn'
    return url.hostname === domain || url.hostname.endsWith(`.${domain}`)
  } catch { return false }
}

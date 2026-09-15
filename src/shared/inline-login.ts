export type InlineLoginPlatform = 'quark' | 'baidu' | 'uc'

export interface InlineLoginConfig {
  platform: InlineLoginPlatform
  label: string
  url: string
  partition: string
  domain: string
  userAgent?: string
}

export interface InlineLoginRequest {
  platform: InlineLoginPlatform
  webContentsId: number
}

export interface InlineLoginCredentialResult {
  success: boolean
  cookies?: string
  userAgent?: string
  nickname?: string
  error?: string
}

export interface InlineLoginStatus {
  state: 'pending' | 'success' | 'error'
  result?: InlineLoginCredentialResult
  error?: string
}

export const QUARK_LOGIN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko)' +
  ' Chrome/94.0.4606.71 Safari/537.36 Core/1.94.225.400 QQBrowser/12.2.5544.400'

export const INLINE_LOGIN_CONFIGS: Record<InlineLoginPlatform, InlineLoginConfig> = Object.freeze({
  quark: {
    platform: 'quark',
    label: '夸克网盘',
    url: 'https://pan.quark.cn/',
    partition: 'persist:quark-login',
    domain: 'quark.cn',
    userAgent: QUARK_LOGIN_USER_AGENT,
  },
  baidu: {
    platform: 'baidu',
    label: '百度网盘',
    url: 'https://pan.baidu.com/',
    partition: 'persist:baidu-login',
    domain: 'baidu.com',
  },
  uc: {
    platform: 'uc',
    label: 'UC网盘',
    url: 'https://drive.uc.cn/',
    partition: 'persist:uc-login',
    domain: 'uc.cn',
  },
})

export function getInlineLoginPlatformByPartition(partition: string | undefined): InlineLoginPlatform | null {
  if (!partition) return null
  const match = (Object.keys(INLINE_LOGIN_CONFIGS) as InlineLoginPlatform[])
    .find((platform) => INLINE_LOGIN_CONFIGS[platform].partition === partition)
  return match || null
}

export function isInlineLoginUrl(platform: InlineLoginPlatform, value: string): boolean {
  try {
    const url = new URL(value)
    const domain = INLINE_LOGIN_CONFIGS[platform].domain
    return url.protocol === 'https:' && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

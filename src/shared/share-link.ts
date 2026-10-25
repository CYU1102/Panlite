import { PAN_PATTERNS } from './constants'

export type SharePlatform = 'quark' | 'baidu' | 'uc' | 'xunlei' | 'aliyun_web'

export interface ShareLinkHit {
  platform: SharePlatform
  url: string
  password?: string
}

const URL_TRAILING_JUNK = /[），。、；！？】》»"'`.,;!?)\]]+$/

/** 旧版百度分享链接（share/init?surl=），PAN_PATTERNS 覆盖不到 */
const BAIDU_LEGACY_PATTERN = /https?:\/\/pan\.baidu\.com\/share\/init\?surl=[a-zA-Z0-9_-]+/i

function upgradeBaiduLegacyUrl(url: string): string {
  const legacy = url.match(/share\/init\?surl=([a-zA-Z0-9_-]+)/)
  if (!legacy) return url
  const surl = legacy[1]
  // 新版 /s/ 链接在 surl 前补 "1"；surl 本身已以 1 开头时不再重复补
  return url.replace(`share/init?surl=${surl}`, surl.startsWith('1') ? `s/${surl}` : `s/1${surl}`)
}

function extractPassword(line: string, url: string): string | undefined {
  const afterUrl = line.slice(line.indexOf(url) + url.length).split(/https?:\/\//i)[0]
  const queryTail = afterUrl.match(/^[?&][^\s]*/)?.[0] || ''
  const pwdParam = (url + queryTail).match(/[?&]pwd=([a-zA-Z0-9]{4})/)
  if (pwdParam) return pwdParam[1]
  const labeled = afterUrl.match(/(?:提取码|密码|pwd)[:\s：]*([a-zA-Z0-9]{4})/i)
  if (labeled) return labeled[1]
  const bare = afterUrl.trim().match(/^([a-zA-Z0-9]{4})(?:\s|$)/)
  return bare ? bare[1] : undefined
}

export function detectShareLinks(text: string): ShareLinkHit[] {
  if (!text) return []
  const hits = new Map<string, ShareLinkHit>()
  const patterns: Array<[SharePlatform, RegExp]> = [
    ...(Object.entries(PAN_PATTERNS) as Array<[SharePlatform, RegExp]>),
    ['baidu', BAIDU_LEGACY_PATTERN],
  ]
  for (const [platform, pattern] of patterns) {
    const global = new RegExp(pattern.source, 'gi')
    let match: RegExpExecArray | null
    while ((match = global.exec(text)) !== null) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      const lineEnd = text.indexOf('\n', match.index)
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
      const originalUrl = match[0].replace(URL_TRAILING_JUNK, '')
      const url = new URL(upgradeBaiduLegacyUrl(originalUrl)).toString()
      const password = extractPassword(line, originalUrl)
      const key = `${platform}:${url}`
      const existing = hits.get(key)
      if (existing) {
        existing.password ||= password
        continue
      }
      hits.set(key, { platform, url, password })
    }
  }
  return [...hits.values()]
}

export function formatShareLinkLine(hit: ShareLinkHit): string {
  return hit.password ? `${hit.url} 提取码: ${hit.password}` : hit.url
}

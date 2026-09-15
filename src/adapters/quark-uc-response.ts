import { fatal } from './errors'

function diagnosticMessage(value: unknown): string {
  if (typeof value !== 'string') return ''
  // Only the API's message field is eligible for diagnostics. Omit messages
  // containing authentication material instead of logging an echoed request.
  if (/cookie|token|auth[_ -]?(?:info|key)|authorization|secret|signature|password|__pu|bduss/i.test(value)) return '[敏感响应消息已隐藏]'
  return value.replace(/https?:\/\/\S+/gi, '[URL已隐藏]').replace(/[A-Za-z0-9+/=_-]{24,}/g, '[长标识已隐藏]').replace(/[\r\n\t\x00-\x1f]+/g, ' ').slice(0, 160)
}

export function parseQuarkUcResponse(text: string, status: number, url: URL, method: string, platform: 'quark' | 'uc'): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { /* report only the response shape */ }
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  const rawCode = data?.code
  const code = typeof rawCode === 'number' && Number.isFinite(rawCode) ? String(rawCode)
    : typeof rawCode === 'string' && /^[\w.-]{1,32}$/.test(rawCode) ? rawCode : undefined
  const businessFailure = rawCode !== undefined && rawCode !== 0 && rawCode !== '0'
  if (status >= 400 || !data || businessFailure || (typeof data.status === 'number' && data.status >= 400)) {
    const label = platform === 'quark' ? 'Quark' : 'UC'
    const message = diagnosticMessage(data?.message)
    const detail = `${label} API 请求失败：${method} ${url.pathname} (HTTP ${status}${code !== undefined ? `, code=${code}` : ''})${message ? ` ${message}` : ''}${!data ? '；响应不是有效 JSON 对象' : ''}`
    if (status === 403) throw fatal(detail, { platform, action: url.pathname, code: code || 'HTTP_403' })
    throw new Error(detail)
  }
  return data
}

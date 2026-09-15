import type { DriveAccount } from '../shared/types'

type CookieAccount = Pick<DriveAccount, 'id' | 'credential'>
interface CookieState { original: string; cookie: string; sequence: number; applied: number }
interface CookieRequest { account: CookieAccount; state: CookieState; cookie: string; sequence: number }
const TRUSTED_API_HOSTS = new Set(['pan.quark.cn', 'drive-pc.quark.cn', 'drive.quark.cn'])

function refreshedCookie(cookie: string, headers: Headers | undefined, responseUrl: string): string {
  const url = new URL(responseUrl)
  if (url.protocol !== 'https:' || !TRUSTED_API_HOSTS.has(url.hostname) || !headers) return cookie
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') || '').split(/,(?=\s*[\w!#$%&'*+.^`|~-]+=)/)
  let result = cookie
  for (const header of values) {
    const [pair, ...attributes] = header.split(';').map(value => value.trim())
    const equals = pair.indexOf('=')
    if (pair.slice(0, equals) !== '__puus') continue
    const value = pair.slice(equals + 1)
    if (value && !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)) continue
    const attrs = new Map(attributes.map(attribute => {
      const split = attribute.indexOf('=')
      return split < 0 ? [attribute.toLowerCase(), ''] : [attribute.slice(0, split).toLowerCase(), attribute.slice(split + 1)]
    }))
    // Only this shared Quark authentication cookie is forwarded to file CDNs.
    if (attrs.get('domain')?.toLowerCase().replace(/^\./, '') !== 'quark.cn') continue
    // Missing/invalid Path uses the response URL's directory, not automatically '/'.
    // A narrower cookie cannot be promoted into this account-wide Cookie header.
    const declaredPath = attrs.get('path')
    const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
    const effectivePath = declaredPath?.startsWith('/') ? declaredPath : defaultPath
    if (effectivePath !== '/') continue
    const maxAge = attrs.get('max-age')
    const expired = maxAge !== undefined && /^-?\d+$/.test(maxAge)
      ? Number(maxAge) <= 0
      : attrs.has('expires') && Date.parse(attrs.get('expires')!) <= Date.now()
    const parts = result.split(';').filter(part => part.trim().split('=', 1)[0] !== '__puus')
    if (value && !expired) parts.push(` __puus=${value}`)
    result = parts.map(part => part.trim()).filter(Boolean).join('; ')
  }
  return result
}

/** Main-process memory only: never use the shared Electron cookie jar as account state. */
export class QuarkCookieStore {
  private states = new Map<string, CookieState>()

  begin(account: CookieAccount): CookieRequest {
    const original = account.credential.cookies || ''
    let state = this.states.get(account.id)
    if (!state || state.original !== original) {
      state = { original, cookie: original, sequence: 0, applied: 0 }
      this.states.delete(account.id)
      if (this.states.size >= 128) this.states.delete(this.states.keys().next().value!)
      this.states.set(account.id, state)
    }
    return { account, state, cookie: state.cookie, sequence: ++state.sequence }
  }

  receive(request: CookieRequest, headers: Headers | undefined, responseUrl: string): string {
    const cookie = refreshedCookie(request.cookie, headers, responseUrl)
    const { account, state, sequence } = request
    if (cookie !== request.cookie && this.states.get(account.id) === state && (account.credential.cookies || '') === state.original && sequence >= state.applied) {
      state.cookie = cookie
      state.applied = sequence
    }
    // A signed URL must retain the cookie belonging to its own response, even concurrently.
    return cookie
  }
}

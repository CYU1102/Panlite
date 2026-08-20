/** Cookie helpers kept pure so rotation behavior can be tested without Electron. */
export function mergeSetCookieHeaders(currentCookie: string, setCookieHeaders: string[]): string {
  const cookies = new Map<string, string>()

  for (const part of currentCookie.split(';')) {
    const trimmed = part.trim()
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    cookies.set(trimmed.slice(0, index), trimmed.slice(index + 1))
  }

  for (const header of setCookieHeaders) {
    const pair = header.split(';', 1)[0]?.trim() || ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    const attributes = header.split(';').slice(1).map((attribute) => attribute.trim().toLowerCase())
    const expiresImmediately = attributes.some((attribute) => attribute === 'max-age=0' || attribute.startsWith('expires=thu, 01 jan 1970'))
    if (!name || value.toLowerCase() === 'deleted' || expiresImmediately) {
      cookies.delete(name)
      continue
    }
    cookies.set(name, value)
  }

  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

export function getSetCookieHeaders(headers: Record<string, string[] | string | undefined>): string[] {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'set-cookie')?.[1]
  if (!entry) return []
  return Array.isArray(entry) ? entry : [entry]
}

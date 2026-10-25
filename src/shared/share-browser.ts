// Separate, in-memory browsing session; never reuse account-login partitions.
export const SHARE_BROWSER_PARTITION = 'panlite-share-browser'

export function getShareBrowserUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

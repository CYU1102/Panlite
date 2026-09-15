import { isTrustedRendererUrl } from './ipc-security'

/** Preview URLs are short-lived session capabilities; only our renderer can read them with fetch. */
export async function handlePreviewCors(
  request: Request,
  handle: (request: Request) => Promise<Response>,
  devServerUrl = process.env.VITE_DEV_SERVER_URL,
  rendererIndexPath?: string,
): Promise<Response> {
  const origin = request.headers.get('origin')
  if (!origin) return handle(request)
  const referrer = request.headers.get('referer') || (request.referrer === 'about:client' ? '' : request.referrer)
  const trustedOrigin = devServerUrl
    ? origin !== 'null' && isTrustedRendererUrl(origin, devServerUrl, rendererIndexPath)
    : origin === 'null'
  if (!trustedOrigin || (referrer && !isTrustedRendererUrl(referrer, devServerUrl, rendererIndexPath))) {
    return new Response('Forbidden', { status: 403 })
  }
  const headers = new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    Vary: 'Origin',
  })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  const response = await handle(request)
  const merged = new Headers(response.headers)
  headers.forEach((value, key) => { if (key === 'vary' && merged.has(key)) merged.append(key, value); else merged.set(key, value) })
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged })
}

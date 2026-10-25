/** Main-process-only source. Never serialize this object into IPC results. */
export interface PreviewSource {
  url: string
  headers?: Record<string, string>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export function previewError(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
}

/** Only a single byte range is meaningful for native media/PDF requests. */
export function validPreviewRange(range: string): boolean {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match || (!match[1] && !match[2])) return false
  const start = match[1] ? Number(match[1]) : undefined
  const end = match[2] ? Number(match[2]) : undefined
  return (start === undefined || Number.isSafeInteger(start)) &&
    (end === undefined || Number.isSafeInteger(end)) &&
    (start === undefined ? end! > 0 : end === undefined || end >= start)
}

/** Forward a byte stream with backpressure, cancellation, and no upstream URL/header disclosure. */
export async function streamPreviewSource(
  source: PreviewSource,
  request: Request,
  mimeType: string,
  controller: AbortController,
  onFinish: () => void,
  onActivity?: (pendingRead: boolean) => void,
): Promise<Response> {
  let finished = false
  const connectionTimeout = setTimeout(() => controller.abort(), 30_000)
  connectionTimeout.unref?.()
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(connectionTimeout)
    request.signal.removeEventListener('abort', abort)
    onFinish()
  }
  const abort = () => controller.abort()
  request.signal.addEventListener('abort', abort, { once: true })
  if (request.signal.aborted) abort()
  let upstream: Response | undefined
  try {
    const url = new URL(source.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source')
    const headers = new Headers(source.headers)
    headers.set('Accept-Encoding', 'identity')
    const range = request.headers.get('range')
    if (range) headers.set('Range', range)
    const ifRange = request.headers.get('if-range')
    if (ifRange) headers.set('If-Range', ifRange)
    onActivity?.(true)
    upstream = await (source.fetch || fetch)(url.href, {
      method: request.method, headers, signal: controller.signal, redirect: 'follow',
    })
    onActivity?.(false)
    clearTimeout(connectionTimeout)
    const responseHeaders = new Headers({
      'Content-Type': mimeType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    // Never forward Set-Cookie, Location, Content-Disposition or provider-specific headers.
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name)
      if (value !== null) responseHeaders.set(name, value)
    }
    if (upstream.status === 416) {
      await upstream.body?.cancel()
      responseHeaders.delete('content-length')
      finish()
      return new Response(null, { status: 416, headers: responseHeaders })
    }
    if (![200, 206].includes(upstream.status)) throw new Error('Upstream unavailable')
    if (upstream.status === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(upstream.headers.get('content-range') || '')
      if (!match) throw new Error('Invalid upstream range')
      const start = Number(match[1])
      const end = Number(match[2])
      const total = match[3] === '*' ? undefined : Number(match[3])
      if (![start, end, ...(total === undefined ? [] : [total])].every(Number.isSafeInteger) || start > end || (total !== undefined && end >= total)) throw new Error('Invalid upstream range')
      const length = upstream.headers.get('content-length')
      if (length !== null && Number(length) !== end - start + 1) throw new Error('Invalid upstream range length')
      if (range) {
        const [left, right] = range.slice(6).split('-')
        const expectedStart = left ? Number(left) : total === undefined ? undefined : Math.max(0, total - Number(right))
        if (expectedStart !== undefined && start !== expectedStart) throw new Error('Upstream returned the wrong bytes')
        if (left && right && end > Number(right)) throw new Error('Upstream returned the wrong bytes')
      }
    }
    // A provider ignoring Range stays HTTP 200; never label the wrong bytes as a 206 response.
    if (upstream.headers.get('content-encoding') && upstream.headers.get('content-encoding') !== 'identity') {
      responseHeaders.delete('content-length')
      if (upstream.status === 206) throw new Error('Compressed range is unsupported')
    }
    if (request.method === 'HEAD' || !upstream.body) {
      await upstream.body?.cancel()
      finish()
      return new Response(null, { status: upstream.status, headers: responseHeaders })
    }
    const reader = upstream.body.getReader()
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        const readTimeout = setTimeout(() => controller.abort(), 30_000)
        readTimeout.unref?.()
        try {
          controller.signal.throwIfAborted()
          onActivity?.(true)
          const chunk = await reader.read()
          if (chunk.done) { output.close(); finish() }
          else output.enqueue(chunk.value)
        } catch {
          output.error(new Error('在线预览连接已中断，请重新打开文件'))
          controller.abort()
          void reader.cancel().catch(() => undefined)
          finish()
        } finally { clearTimeout(readTimeout); onActivity?.(false) }
      },
      async cancel() {
        controller.abort()
        await reader.cancel().catch(() => undefined)
        finish()
      },
    })
    return new Response(stream, { status: upstream.status, headers: responseHeaders })
  } catch {
    controller.abort()
    await upstream?.body?.cancel().catch(() => undefined)
    finish()
    return previewError(502, '在线预览连接失败，请重新打开文件或下载后查看')
  }
}

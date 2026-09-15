import { createServer, type RequestListener, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilePreviewService, type FilePreviewRequest } from './file-preview'
import { downloadPreviewSource } from './preview-download'

const servers: Server[] = []
const roots: string[] = []
const services: FilePreviewService[] = []
afterEach(async () => {
  services.splice(0).forEach(service => service.cleanupAll())
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

async function upstream(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/asset?token=private-token`
}

function service(options: ConstructorParameters<typeof FilePreviewService>[0] = {}): FilePreviewService {
  const root = mkdtempSync(path.join(os.tmpdir(), 'panlite-stream-test-'))
  roots.push(root)
  const instance = new FilePreviewService({ tempRoot: root, ...options })
  services.push(instance)
  return instance
}

const sourceRequest: FilePreviewRequest = { accountId: 'test-account', fileId: 'file-1', fileName: 'video.mp4', fileSize: 6 * 1024 ** 3 }
const noDownload = vi.fn(async () => { throw new Error('Must stream without a full download') })

describe('online preview protocol against a real HTTP source', () => {
  it('streams >4GB declared files, forwards seek/suffix/HEAD and keeps provider credentials private', async () => {
    const received: Array<{ range?: string; cookie?: string; authorization?: string }> = []
    const bytes = Buffer.from('0123456789abcdefghij')
    const url = await upstream((req, res) => {
      received.push({ range: req.headers.range, cookie: req.headers.cookie, authorization: req.headers.authorization })
      res.setHeader('Set-Cookie', 'private=response-secret')
      res.setHeader('Location', 'https://secret.example/?token=secret')
      res.setHeader('Accept-Ranges', 'bytes')
      let start = 0
      let end = bytes.length - 1
      if (req.headers.range) {
        const [left, right] = req.headers.range.slice(6).split('-')
        start = left ? Number(left) : bytes.length - Number(right)
        end = left && right ? Math.min(Number(right), end) : end
        if (start >= bytes.length) { res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); res.end(); return }
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
      }
      res.setHeader('Content-Length', end - start + 1)
      res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
    })
    const previewService = service()
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({ url, headers: { Cookie: 'test-cookie', Authorization: 'Bearer test-token' } }))
    expect(dto.delivery).toBe('stream')
    expect(JSON.stringify(dto)).not.toMatch(/private-token|test-cookie|test-token|127\.0\.0\.1/)
    expect(readdirSync(previewService.tempRoot)).toEqual([])

    for (const [range, expected] of [['bytes=4-8', '45678'], ['bytes=17-', 'hij'], ['bytes=-4', 'ghij']]) {
      const response = await previewService.handleRequest(new Request(dto.assetUrl!, { headers: { Range: range, Authorization: 'renderer-injected' } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Type')).toBe('video/mp4')
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(response.headers.get('Location')).toBeNull()
      expect(await response.text()).toBe(expected)
    }
    const head = await previewService.handleRequest(new Request(dto.assetUrl!, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe('20')
    expect(await head.text()).toBe('')
    const outside = await previewService.handleRequest(new Request(dto.assetUrl!, { headers: { Range: 'bytes=30-' } }))
    expect(outside.status).toBe(416)
    expect(outside.headers.get('Content-Range')).toBe('bytes */20')
    expect(received.every(item => item.cookie === 'test-cookie' && item.authorization === 'Bearer test-token')).toBe(true)
    expect(noDownload).not.toHaveBeenCalled()
  })

  it('preserves 200 when an upstream ignores Range and suppresses upstream error bodies', async () => {
    let failure = false
    const url = await upstream((_req, res) => {
      res.statusCode = failure ? 403 : 200
      res.end(failure ? 'secret-token: unauthorized' : 'full body')
    })
    const previewService = service()
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({ url }))
    const whole = await previewService.handleRequest(new Request(dto.assetUrl!, { headers: { Range: 'bytes=4-' } }))
    expect(whole.status).toBe(200)
    expect(await whole.text()).toBe('full body')
    failure = true
    const error = await previewService.handleRequest(new Request(dto.assetUrl!))
    expect(error.status).toBe(502)
    expect(await error.text()).not.toContain('secret-token')
  })

  it.each(['bytes 3-5/20', 'bytes 4-3/20', 'bytes 4-5/4', 'invalid'])('rejects inaccurate upstream Content-Range %s', async (contentRange) => {
    const url = await upstream((_req, res) => {
      res.writeHead(206, { 'Content-Range': contentRange })
      res.end('45')
    })
    const previewService = service()
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({ url }))
    const response = await previewService.handleRequest(new Request(dto.assetUrl!, { headers: { Range: 'bytes=4-5' } }))
    expect(response.status).toBe(502)
  })

  it('rejects malformed ranges, methods, paths and closed/expired sessions without contacting the provider', async () => {
    const fetchSource = vi.fn()
    let now = 100
    const previewService = service({ now: () => now, sessionTtlMs: 20 })
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({ url: 'https://invalid.test/file', fetch: fetchSource }))
    for (const range of ['bytes=0-1,4-5', 'bytes=-0', 'bytes=5-4', 'bytes=-', 'bytes=9007199254740993-', 'items=1-2']) {
      expect((await previewService.handleRequest(new Request(dto.assetUrl!, { headers: { Range: range } }))).status).toBe(416)
    }
    expect((await previewService.handleRequest(new Request(dto.assetUrl!, { method: 'POST' }))).status).toBe(405)
    expect((await previewService.handleRequest(new Request(`${dto.assetUrl}?url=https://evil.test`))).status).toBe(404)
    now = 121
    expect((await previewService.handleRequest(new Request(dto.assetUrl!))).status).toBe(404)
    expect(fetchSource).not.toHaveBeenCalled()
  })

  it.each(['cleanup', 'consumer', 'request'] as const)('aborts an active upstream stream on %s cancellation', async (mode) => {
    let markClosed!: () => void
    const closed = new Promise<void>(resolve => { markClosed = resolve })
    const url = await upstream((_req, res) => {
      res.writeHead(200)
      res.write('initial chunk')
      res.on('close', markClosed)
    })
    const previewService = service()
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({ url }))
    const controller = new AbortController()
    const response = await previewService.handleRequest(new Request(dto.assetUrl!, { signal: controller.signal }))
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    if (mode === 'cleanup') previewService.cleanupSession(dto.sessionId)
    else if (mode === 'consumer') await reader.cancel()
    else controller.abort()
    if (mode !== 'consumer') await expect(reader.read()).rejects.toThrow()
    await closed
    if (mode === 'cleanup') expect((await previewService.handleRequest(new Request(dto.assetUrl!))).status).toBe(404)
  })

  it('renews idle expiry during long playback and expires again after the stream finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let now = 100
    let input!: ReadableStreamDefaultController<Uint8Array>
    const previewService = service({ now: () => now, sessionTtlMs: 10 })
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({
      url: 'https://fixture.test/video',
      fetch: async (_url, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          input = controller
          init.signal!.addEventListener('abort', () => controller.error(new Error('Aborted')), { once: true })
        },
      })),
    }))
    const response = await previewService.handleRequest(new Request(dto.assetUrl!))
    const reader = response.body!.getReader()
    for (let index = 0; index < 3; index++) {
      const reading = reader.read()
      now += 100
      await vi.advanceTimersByTimeAsync(100)
      expect(previewService.cleanupExpiredSessions()).toBe(0)
      expect(previewService.getSession(dto.sessionId)).toBeDefined()
      input.enqueue(new Uint8Array([index]))
      expect((await reading).value).toEqual(new Uint8Array([index]))
    }
    input.close()
    expect((await reader.read()).done).toBe(true)
    expect(dto.expiresAt).toBe(now + 10)
    now += 11
    await vi.advanceTimersByTimeAsync(11)
    expect((await previewService.handleRequest(new Request(dto.assetUrl!))).status).toBe(404)
  })

  it('expires an abandoned stream with no reads, but an explicit close still cancels immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let now = 100
    const previewService = service({ now: () => now, sessionTtlMs: 10 })
    const abort = vi.fn()
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({
      url: 'https://fixture.test/video',
      fetch: async (_url, init) => {
        init.signal!.addEventListener('abort', abort, { once: true })
        return new Response('buffered but unconsumed')
      },
    }))
    await previewService.handleRequest(new Request(dto.assetUrl!))
    await vi.advanceTimersByTimeAsync(0)
    now += 11
    await vi.advanceTimersByTimeAsync(11)
    expect(abort).toHaveBeenCalledTimes(1)
    expect((await previewService.handleRequest(new Request(dto.assetUrl!))).status).toBe(404)
  })

  it('times out a stalled active request rather than exempting it from expiry forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let now = 100
    const previewService = service({ now: () => now, sessionTtlMs: 10 })
    const dto = await previewService.createSession(sourceRequest, noDownload, async () => ({
      url: 'https://fixture.test/video',
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('Timed out')), { once: true })
      }),
    }))
    const pending = previewService.handleRequest(new Request(dto.assetUrl!))
    now += 30_000
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await pending).status).toBe(502)
    now += 11
    await vi.advanceTimersByTimeAsync(11)
    expect((await previewService.handleRequest(new Request(dto.assetUrl!))).status).toBe(404)
  })

  it('serves compatible local media previews with exact ranges and cleans local bytes', async () => {
    const previewService = service()
    const dto = await previewService.createSession({ ...sourceRequest, fileSize: 10 }, async (_req, context) => {
      const localPath = path.join(context.directory, context.fileName)
      writeFileSync(localPath, '0123456789')
      return { success: true, localPath }
    })
    expect(dto.delivery).toBe('download')
    const response = await previewService.handleRequest(new Request(dto.assetUrl!, { headers: { Range: 'bytes=3-5' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 3-5/10')
    expect(await response.text()).toBe('345')
    previewService.cleanupSession(dto.sessionId)
    expect(readdirSync(previewService.tempRoot)).toEqual([])
  })

  it('caps document downloads while streaming, including missing or inaccurate size metadata', async () => {
    const url = await upstream((_req, res) => { res.write('123'); res.end('456789') })
    const previewService = service()
    const result = await downloadPreviewSource({ url }, { directory: previewService.tempRoot, fileName: 'test.txt', maxBytes: 4 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/超过预览/)
    expect(readdirSync(previewService.tempRoot)).toEqual([])
  })
})

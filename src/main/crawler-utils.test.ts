import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request: mocks.request } }))
import { fetchHtml, fetchSearchText } from './crawler-utils'
import { withSearchSignal } from './search-runtime'

let request: EventEmitter & { setHeader: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }
function respond(status: number, chunks: Buffer[]) {
  const response = Object.assign(new EventEmitter(), { statusCode: status })
  request.emit('response', response)
  for (const chunk of chunks) response.emit('data', chunk)
  response.emit('end')
}
beforeEach(() => {
  request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn() })
  request.abort.mockImplementation(() => request.emit('abort'))
  mocks.request.mockReturnValue(request)
})
afterEach(() => vi.useRealTimers())

describe('search Electron transport', () => {
  it('decodes UTF-8 after combining network chunks and sends a configured POST body', async () => {
    const content = Buffer.from('中文🙂')
    const pending = fetchSearchText('https://fixture.invalid/api', { method: 'POST', body: 'q=中文', headers: { 'X-Fixture': 'yes' } })
    respond(200, [content.subarray(0, 1), content.subarray(1, 4), content.subarray(4)])
    expect(await pending).toBe('中文🙂')
    expect(request.setHeader).toHaveBeenCalledWith('Content-Length', String(Buffer.byteLength('q=中文')))
    expect(request.write).toHaveBeenCalledWith('q=中文')
  })
  it('rejects unsuccessful HTTP responses instead of parsing their error pages', async () => {
    const pending = fetchHtml('https://fixture.invalid/error')
    respond(503, [Buffer.from('service unavailable')])
    await expect(pending).rejects.toThrow('HTTP 503')
    expect(request.abort).toHaveBeenCalledOnce()
  })
  it('aborts the request when its search is stopped', async () => {
    const controller = new AbortController()
    const pending = withSearchSignal(controller.signal, () => fetchHtml('https://fixture.invalid/slow'))
    controller.abort(new Error('test cancellation'))
    await expect(pending).rejects.toThrow('test cancellation')
    expect(request.abort).toHaveBeenCalledOnce()
  })
  it('aborts stalled requests on timeout and clears successful timers', async () => {
    vi.useFakeTimers()
    const pending = fetchHtml('https://fixture.invalid/timeout', 100)
    const rejection = expect(pending).rejects.toThrow('Request timeout')
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(request.abort).toHaveBeenCalledOnce()
    request.abort.mockClear()
    const successful = fetchHtml('https://fixture.invalid/success', 100)
    respond(200, [Buffer.from('ok')])
    expect(await successful).toBe('ok')
    await vi.advanceTimersByTimeAsync(100)
    expect(request.abort).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { handlePreviewCors } from './preview-cors'

const index = resolve('preview-test/renderer/index.html')
const url = 'panlite-preview://session/00000000-0000-4000-8000-000000000001'
describe('preview fetch origin and byte ranges', () => {
  it('allows production renderer fetch while preserving partial response metadata', async () => {
    const request = new Request(url, { headers: { Origin: 'null', Referer: pathToFileURL(index).href, Range: 'bytes=2-4' } })
    const response = await handlePreviewCors(request, async () => new Response('pdf', { status: 206, headers: { 'Content-Range': 'bytes 2-4/100' } }), undefined, index)
    expect(response.status).toBe(206)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null')
    expect(response.headers.get('Content-Range')).toBe('bytes 2-4/100')
    expect(await response.text()).toBe('pdf')
  })
  it('rejects unrelated web and local file referrers before opening the capability', async () => {
    const handle = vi.fn(async () => new Response('private'))
    const attempts: Record<string, string>[] = [{ Origin: 'https://external.example' }, { Origin: 'null', Referer: pathToFileURL(resolve('other.html')).href }]
    for (const headers of attempts) {
      expect((await handlePreviewCors(new Request(url, { headers }), handle, undefined, index)).status).toBe(403)
    }
    expect(handle).not.toHaveBeenCalled()
  })
  it('permits only the configured development origin and handles a range preflight', async () => {
    const handle = vi.fn(async () => new Response('private'))
    const request = new Request(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } })
    const response = await handlePreviewCors(request, handle, 'http://localhost:5173', index)
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Range')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    for (const origin of ['null', 'http://localhost:5174', 'https://localhost:5173']) {
      expect((await handlePreviewCors(new Request(url, { headers: { Origin: origin } }), handle, 'http://localhost:5173', index)).status).toBe(403)
    }
    expect(handle).not.toHaveBeenCalled()
  })
})

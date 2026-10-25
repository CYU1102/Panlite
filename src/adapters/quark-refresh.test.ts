import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'
import { QuarkAdapter } from './quark'

const clients = vi.hoisted(() => ({ api: vi.fn(), cdn: vi.fn(), write: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: clients.api }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./download-response', () => ({ writeDownloadResponse: clients.write }))
let sequence = 0
function account(): DriveAccount {
  return { id: `refresh-${++sequence}`, platform: 'quark', nickname: 'fixture', loginType: 'cookie',
    credential: { cookies: 'sid=fixture; __puus=old' }, status: 'active', createdAt: 0, updatedAt: 0 }
}
function reply(name: string, refreshed?: string): Response {
  return new Response(JSON.stringify({ code: 0, data: [{ download_url: `https://download.example.test/${name}` }] }), {
    headers: refreshed ? { 'Set-Cookie': `__puus=${refreshed}; Domain=quark.cn; Path=/; Max-Age=86400` } : {},
  })
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', clients.cdn) })
afterEach(() => vi.unstubAllGlobals())

describe('Quark signed source cookie refresh', () => {
  it('uses the matching API response cookie in preview and subsequent API calls', async () => {
    const a = account(), adapter = new QuarkAdapter()
    clients.api.mockResolvedValueOnce(reply('first', 'fresh')).mockResolvedValueOnce(reply('second'))
    const source = await adapter.getDownloadSource(a, 'first')
    expect(source.headers?.Cookie).toBe('sid=fixture; __puus=fresh')
    await adapter.getDownloadSource(a, 'second')
    expect(clients.api.mock.calls[1][1].headers.cookie).toBe('sid=fixture; __puus=fresh')
    expect(a.credential.cookies).toBe('sid=fixture; __puus=old')
  })

  it('uses the refreshed cookie for an actual download request', async () => {
    clients.api.mockResolvedValueOnce(reply('original', 'download-refresh'))
    clients.cdn.mockResolvedValueOnce(new Response('fixture'))
    clients.write.mockResolvedValueOnce(7)
    await new QuarkAdapter().download(account(), 'file', process.cwd(), { fileName: 'fixture.txt' })
    expect(clients.cdn).toHaveBeenCalledWith('https://download.example.test/original', expect.objectContaining({
      headers: expect.objectContaining({ Cookie: 'sid=fixture; __puus=download-refresh' }),
    }))
  })

  it('keeps concurrent signed URLs paired with their own response cookies', async () => {
    let first!: (value: Response) => void, second!: (value: Response) => void
    clients.api.mockImplementationOnce(() => new Promise<Response>(resolve => { first = resolve }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { second = resolve }))
    const adapter = new QuarkAdapter(), a = account()
    const pendingFirst = adapter.getDownloadSource(a, 'first'), pendingSecond = adapter.getDownloadSource(a, 'second')
    second(reply('second', 'second-cookie'))
    first(reply('first', 'first-cookie'))
    const [one, two] = await Promise.all([pendingFirst, pendingSecond])
    expect([one.url, one.headers?.Cookie]).toEqual(['https://download.example.test/first', 'sid=fixture; __puus=first-cookie'])
    expect([two.url, two.headers?.Cookie]).toEqual(['https://download.example.test/second', 'sid=fixture; __puus=second-cookie'])
  })

  it('does not leak refresh across accounts or replacement credentials, and supports absent headers', async () => {
    const a = account(), b = account(), adapter = new QuarkAdapter()
    clients.api.mockResolvedValueOnce(reply('a', 'only-a')).mockResolvedValueOnce(reply('b'))
      .mockResolvedValueOnce({ text: async () => JSON.stringify({ code: 0, data: [{ download_url: 'https://download.example.test/new' }] }) })
    await adapter.getDownloadSource(a, 'a')
    expect((await adapter.getDownloadSource(b, 'b')).headers?.Cookie).toBe(b.credential.cookies)
    a.credential = { cookies: 'sid=replacement; __puus=relogin' }
    expect((await adapter.getDownloadSource(a, 'new')).headers?.Cookie).toBe(a.credential.cookies)
    expect(clients.api.mock.calls[2][1].headers.cookie).toBe(a.credential.cookies)
  })
})

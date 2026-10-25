import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BaiduAdapter, baiduRefreshToken, setBaiduCredentials } from './baidu'
import type { DriveAccount } from '../shared/types'

const network = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request: network.request }, session: {}, BrowserWindow: vi.fn() }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../main/request-settings', () => ({ getRequestSettings: () => ({ baiduPageSize: 2, requestDelayMs: 0 }) }))
const replies: Array<{ status: number; body: unknown }> = []
const requests: Array<{ method: string; url: string; body: string; headers: Record<string, string> }> = []
const file = (name: string) => ({ fs_id: 1, path: `/${name}`, server_filename: name, isdir: 0, size: 3, local_ctime: 1, local_mtime: 1 })
const reply = (body: unknown, status = 200) => replies.push({ body, status })
function account(): DriveAccount {
  return { id: 'baidu-ops', platform: 'baidu', nickname: 'fixture', loginType: 'oauth', credential: { accessToken: 'access-fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
}
beforeEach(() => {
  requests.length = 0
  replies.length = 0
  setBaiduCredentials('client-fixture', 'secret-fixture')
  network.request.mockReset().mockImplementation((options: { method: string; url: string }) => {
    const record = { ...options, body: '', headers: {} as Record<string, string> }
    requests.push(record)
    const request = Object.assign(new EventEmitter(), {
      setHeader(name: string, value: string) { record.headers[name.toLowerCase()] = value }, write(body: string) { record.body += body },
      end() {
        const next = replies.shift()
        if (!next) throw new Error('Unexpected fixture request')
        const response = Object.assign(new EventEmitter(), { statusCode: next.status, headers: {} })
        request.emit('response', response)
        response.emit('data', Buffer.from(typeof next.body === 'string' ? next.body : JSON.stringify(next.body)))
        response.emit('end')
      },
    })
    return request
  })
})

describe('Baidu actual OAuth adapter file operations', () => {
  it('continues full list pages when the native list response omits has_more', async () => {
    reply({ errno: 0, list: [file('a'), file('b')] })
    reply({ errno: 0, list: [file('c')] })
    const result = await new BaiduAdapter().listFiles(account(), '0')
    expect(result.files.map(file => file.id)).toEqual(['/a', '/b', '/c'])
    expect(new URL(requests[1].url).searchParams.get('start')).toBe('2')
  })
  it('rejects malformed list data rather than returning an empty directory', async () => {
    reply({ errno: 0 })
    await expect(new BaiduAdapter().listFiles(account(), '0')).rejects.toThrow(/列表.*无效/)
  })
  it('reports reaching the page bound', async () => {
    for (let page = 0; page < 100; page++) reply({ errno: 0, list: [file('a'), file('b')], has_more: 1 })
    await expect(new BaiduAdapter().listFiles(account(), '0')).rejects.toThrow(/上限.*不完整/)
    expect(requests).toHaveLength(100)
  })
  it('creates folders using form POST parameters', async () => {
    reply({ errno: 0, path: '/Docs', fs_id: 42, isdir: 1 })
    expect(await new BaiduAdapter().mkdir(account(), '0', 'Docs')).toMatchObject({ id: '/Docs', isDir: true })
    expect(requests[0].method).toBe('POST')
    expect(requests[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(requests[0].body).get('path')).toBe('/Docs')
  })
  it.each(['rename', 'move', 'delete', 'copy'] as const)('does not hide individual filemanager errors in %s', async operation => {
    reply({ errno: 0, info: [{ path: '/a', errno: -9 }] })
    const adapter = new BaiduAdapter()
    const pending = operation === 'rename' ? adapter.rename(account(), '/a', 'b')
      : operation === 'delete' ? adapter.delete(account(), ['/a']) : adapter[operation](account(), ['/a'], '0')
    await expect(pending).rejects.toThrow('-9')
    expect(requests[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
  })
  it('rejects HTTP failures even if a proxy returns errno zero', async () => {
    reply({ errno: 0, baidu_name: 'fixture' }, 503)
    expect(await new BaiduAdapter().checkLogin(account())).toBe(false)
  })
  it.each([null, {}, { access_token: '', refresh_token: 'refresh', expires_in: 3600 }])('rejects invalid refreshed token responses', async value => {
    reply(value)
    await expect(baiduRefreshToken('refresh-fixture')).rejects.toThrow(/无效|缺少/)
  })
  it('keeps the account in memory synchronized after rotating its token', async () => {
    const current = account()
    current.credential = { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1 }
    reply({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
    reply({ errno: 0, list: [] })
    reply({ errno: 0, list: [] })
    const adapter = new BaiduAdapter()
    await adapter.listFiles(current, '0')
    await adapter.listFiles(current, '0')
    expect(current.credential).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
    expect(requests.filter(item => new URL(item.url).hostname === 'openapi.baidu.com')).toHaveLength(1)
  })
})

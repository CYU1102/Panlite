import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'
import { BaiduAdapter } from './baidu'
import { XunleiAdapter } from './xunlei'

const electron = vi.hoisted(() => ({ request: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({
  net: { request: electron.request },
  session: { fromPartition: () => ({ fetch: electron.fetch }) },
  BrowserWindow: vi.fn(),
}))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

interface RequestRecord {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

const requests: RequestRecord[] = []
const replies: Array<{ status: number; body: unknown }> = []
let accountSequence = 0

function account(platform: 'baidu' | 'xunlei', cookies = 'BDUSS=account-a'): DriveAccount {
  return {
    id: `share-cancel-${++accountSequence}`,
    platform,
    nickname: 'request fixture',
    loginType: platform === 'baidu' ? 'cookie' : 'token',
    credential: platform === 'baidu' ? { cookies } : { accessToken: 'access-fixture', userId: 'user-fixture' },
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  }
}

function reply(body: unknown, status = 200): void {
  replies.push({ status, body })
}

beforeEach(() => {
  requests.length = 0
  replies.length = 0
  electron.request.mockImplementation((options: { method: string; url: string }) => {
    const recorded: RequestRecord = { ...options, headers: {}, body: '' }
    requests.push(recorded)
    const request = Object.assign(new EventEmitter(), {
      setHeader(name: string, value: string) { recorded.headers[name.toLowerCase()] = value },
      write(body: string) { recorded.body += body },
      end() {
        const next = replies.shift()
        if (!next) throw new Error(`No fixture response for ${recorded.url}`)
        const response = Object.assign(new EventEmitter(), { statusCode: next.status, headers: {} })
        request.emit('response', response)
        response.emit('data', Buffer.from(typeof next.body === 'string' ? next.body : JSON.stringify(next.body)))
        response.emit('end')
      },
    })
    return request
  })
  electron.fetch.mockResolvedValue({
    json: async () => ({ captcha_token: 'captcha-fixture', expires_in: 3600 }),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  expect(replies).toHaveLength(0)
})

describe('Baidu share cancellation', () => {
  it('keeps CSRF tokens bound to each account and preserves large share IDs', async () => {
    const adapter = new BaiduAdapter()
    const first = account('baidu', 'BDUSS=first')
    const second = account('baidu', 'BDUSS=second')
    const shareId = '9007199254740993'
    reply({ errno: 0, result: { bdstoken: 'first-token' } })
    reply({ errno: 0 })
    reply({ errno: 0, result: { bdstoken: 'second-token' } })
    reply({ errno: 0 })
    reply({ errno: 0 })

    await adapter.cancelShare(first, shareId)
    await adapter.cancelShare(second, '123')
    await adapter.cancelShare(first, '456')

    const cancellations = requests.filter((request) => new URL(request.url).pathname === '/share/cancel')
    expect(requests).toHaveLength(5)
    expect(cancellations.map((request) => new URL(request.url).searchParams.get('bdstoken')))
      .toEqual(['first-token', 'second-token', 'first-token'])
    expect(cancellations.map((request) => request.headers.cookie)).toEqual(['BDUSS=first', 'BDUSS=second', 'BDUSS=first'])
    expect(cancellations[0].method).toBe('POST')
    expect(cancellations[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(JSON.parse(new URLSearchParams(cancellations[0].body).get('shareid_list')!)).toEqual([shareId])
  })

  it('refetches the token after the same account is logged in with different cookies', async () => {
    const adapter = new BaiduAdapter()
    const current = account('baidu')
    reply({ errno: 0, result: { bdstoken: 'old-token' } })
    reply({ errno: 0 })
    reply({ errno: 0, result: { bdstoken: 'new-token' } })
    reply({ errno: 0 })
    await adapter.cancelShare(current, '123')
    current.credential.cookies = 'BDUSS=new-session'
    await adapter.cancelShare(current, '123')
    expect(requests).toHaveLength(4)
    expect(new URL(requests[3].url).searchParams.get('bdstoken')).toBe('new-token')
  })

  it('refetches an expired token and rejects remote cancellation failures', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const adapter = new BaiduAdapter()
    const current = account('baidu')
    reply({ errno: 0, result: { bdstoken: 'old-token' } })
    reply({ errno: 0 })
    reply({ errno: 0, result: { bdstoken: 'renewed-token' } })
    reply({ errno: -6 })
    await adapter.cancelShare(current, '123')
    now.mockReturnValue(301_001)
    await expect(adapter.cancelShare(current, '123')).rejects.toThrow('取消分享失败')
    expect(new URL(requests[3].url).searchParams.get('bdstoken')).toBe('renewed-token')
  })

  it('does not send a cancellation after cookie authentication expires', async () => {
    reply({ errno: -6 })
    await expect(new BaiduAdapter().cancelShare(account('baidu'), '123')).rejects.toThrow('Cookie 已失效')
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe('/api/gettemplatevariable')
  })
})

describe('Xunlei share cancellation', () => {
  it('sends the selected share ID with the current account credentials', async () => {
    reply({})
    await new XunleiAdapter().cancelShare(account('xunlei'), 'share_123')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api-pan.xunlei.com/drive/v1/share/delete',
      headers: { authorization: 'Bearer access-fixture', 'x-captcha-token': 'captcha-fixture' },
    })
    expect(JSON.parse(requests[0].body)).toEqual({ space: '', share_id: 'share_123' })
  })

  it.each([
    { status: 403, body: { message: 'forbidden' }, message: /HTTP 403.*forbidden/ },
    { status: 500, body: { error_code: '0' }, message: /HTTP 500/ },
    { status: 502, body: '<html>bad gateway</html>', message: /HTTP 502/ },
    { status: 200, body: { error: 'unauthenticated' }, message: /unauthenticated/ },
    { status: 200, body: { error_code: 7, message: 'cancel failed' }, message: /cancel failed/ },
  ])('rejects a failed response ($status, $body)', async ({ status, body, message }) => {
    reply(body, status)
    await expect(new XunleiAdapter().cancelShare(account('xunlei'), 'share_123')).rejects.toThrow(message)
  })

  it.each([
    { status: 200, body: { error_code: '0' } },
    { status: 204, body: '' },
  ])('accepts a successful response ($status, $body)', async ({ status, body }) => {
    reply(body, status)
    await expect(new XunleiAdapter().cancelShare(account('xunlei'), 'share_123')).resolves.toBeUndefined()
  })
})

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { XunleiAdapter } from './xunlei'
import type { DriveAccount } from '../shared/types'

const network = vi.hoisted(() => ({ fetch: vi.fn(), request: vi.fn() }))
vi.mock('electron', () => ({ net: { request: network.request }, session: { fromPartition: () => ({ fetch: network.fetch }) }, BrowserWindow: vi.fn() }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
let sequence = 0
const replies: Array<{ status: number; body: unknown }> = []
const requests: Array<{ method: string; url: string; body: string }> = []
const file = (id: string) => ({ id, parent_id: '', name: `${id}.txt`, kind: 'drive#file', size: 3, created_time: '2026-01-01T00:00:00Z', modified_time: '2026-01-01T00:00:00Z' })
function account(): DriveAccount {
  return { id: `xunlei-ops-${++sequence}`, platform: 'xunlei', nickname: 'fixture', loginType: 'token',
    credential: { accessToken: 'access-fixture', userId: 'user-fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
}
beforeEach(() => {
  requests.length = 0
  replies.length = 0
  network.fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ captcha_token: 'captcha-fixture', expires_in: 3600 })))
  network.request.mockReset().mockImplementation((options: { method: string; url: string }) => {
    const record = { ...options, body: '' }
    requests.push(record)
    const request = Object.assign(new EventEmitter(), {
      setHeader() {}, write(body: string) { record.body += body },
      end() {
        const reply = replies.shift()
        if (!reply) throw new Error('Unexpected fixture request')
        const response = Object.assign(new EventEmitter(), { statusCode: reply.status })
        request.emit('response', response)
        response.emit('data', Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)))
        response.emit('end')
      },
    })
    return request
  })
})

describe('Xunlei actual adapter file operations', () => {
  it.each(['rename', 'move', 'delete'] as const)('rejects HTTP failures in %s', async operation => {
    const current = account()
    network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ captcha_token: 'captcha-fixture', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'permission_denied' }), { status: 403 }))
    const adapter = new XunleiAdapter()
    const pending = operation === 'rename' ? adapter.rename(current, 'a', 'b')
      : operation === 'move' ? adapter.move(current, ['a'], '0') : adapter.delete(current, ['a'])
    await expect(pending).rejects.toThrow(/403|permission_denied/)
  })

  it('accepts a successful no-content mutation and normalizes the root move target', async () => {
    network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ captcha_token: 'captcha-fixture', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    await new XunleiAdapter().move(account(), ['a'], '0')
    expect(JSON.parse(network.fetch.mock.calls[1][1].body)).toMatchObject({ to: { parent_id: '' } })
  })

  it('rejects an error body on HTTP 200 and a mkdir response without an ID', async () => {
    const adapter = new XunleiAdapter()
    const current = account()
    network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ captcha_token: 'captcha-fixture', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error_code: 7, message: 'quota exceeded' })))
      .mockResolvedValueOnce(new Response('{}'))
    await expect(adapter.rename(current, 'a', 'b')).rejects.toThrow('quota exceeded')
    await expect(adapter.mkdir(current, '0', 'Docs')).rejects.toThrow(/ID|信息/)
  })

  it('lists every cursor page using the account client endpoint', async () => {
    replies.push({ status: 200, body: { files: [file('a')], next_page_token: 'cursor-2' } }, { status: 200, body: { files: [file('b')], next_page_token: '' } })
    const result = await new XunleiAdapter().listFiles(account(), '0')
    expect(result.files.map(file => file.id)).toEqual(['a', 'b'])
    expect(new URL(requests[0].url).origin).toBe('https://api-pan.xunlei.com')
    expect(new URL(requests[1].url).searchParams.get('page_token')).toBe('cursor-2')
    expect(result.hasMore).toBe(false)
  })

  it('searches all cursor pages', async () => {
    replies.push({ status: 200, body: { files: [file('a')], next_page_token: 'next' } }, { status: 200, body: { files: [file('b')], next_page_token: '' } })
    expect((await new XunleiAdapter().searchFiles(account(), 'a b')).map(file => file.id)).toEqual(['a', 'b'])
    expect(new URL(requests[1].url).searchParams.get('keyword')).toBe('a b')
  })

  it.each(['listFiles', 'searchFiles'] as const)('rejects repeated cursors in %s', async method => {
    replies.push({ status: 200, body: { files: [file('a')], next_page_token: 'same' } }, { status: 200, body: { files: [file('a')], next_page_token: 'same' } })
    await expect(new XunleiAdapter()[method](account(), '0')).rejects.toThrow(/分页.*重复/)
    expect(requests).toHaveLength(2)
  })

  it('rejects malformed list data and JSON null login responses', async () => {
    replies.push({ status: 200, body: {} }, { status: 200, body: null })
    const adapter = new XunleiAdapter()
    const current = account()
    await expect(adapter.listFiles(current, '0')).rejects.toThrow(/列表.*无效/)
    expect(await adapter.checkLogin(current)).toBe(false)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuarkAdapter } from './quark'
import type { DriveAccount } from '../shared/types'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: network.fetch }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../main/request-settings', () => ({ getRequestSettings: () => ({ quarkPageSize: 2, requestDelayMs: 0 }) }))
const account: DriveAccount = { id: 'quark-search-fixture', platform: 'quark', nickname: 'fixture', loginType: 'cookie', credential: { cookies: 'sid=fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
const file = (id: string, name = `${id}.docx`) => ({ fid: id, file_name: name, file_type: 1, size: 10 })
const reply = (items: unknown[], total?: number) => new Response(JSON.stringify({ code: 0, data: { list: items }, ...(total === undefined ? {} : { metadata: { _total: total } }) }))
beforeEach(() => { network.fetch.mockReset() })

describe('Quark provider search contract', () => {
  it('sends a GET with q so ignored keyword parameters cannot masquerade as matching results', async () => {
    const keyword = '夸克网盘使用指南 + 2026&草稿'
    network.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const query = new URL(url).searchParams
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
      expect(query.has('keyword')).toBe(false)
      expect(query.get('_fetch_total')).toBe('true')
      return query.get('q') === keyword
        ? reply([file('guide-pdf', `${keyword}.pdf`), file('guide-png', `${keyword}.png`)], 2)
        : reply([file('unrelated-movie', '电影.mp4')], 1)
    })
    expect((await new QuarkAdapter().searchFiles(account, keyword)).map(item => item.id)).toEqual(['guide-pdf', 'guide-png'])
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })

  it('retains q and page size across pages and stops at the reported total', async () => {
    network.fetch.mockResolvedValueOnce(reply([file('a'), file('b')], 4)).mockResolvedValueOnce(reply([file('c'), file('d')], 4))
    expect((await new QuarkAdapter().searchFiles(account, '.docx')).map(item => item.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(network.fetch).toHaveBeenCalledTimes(2)
    for (const [index, [url]] of network.fetch.mock.calls.entries()) {
      const query = new URL(url).searchParams
      expect(query.get('q')).toBe('.docx')
      expect(query.get('_page')).toBe(String(index + 1))
      expect(query.get('_size')).toBe('2')
    }
  })

  it('supports empty results and absent total metadata', async () => {
    network.fetch.mockResolvedValueOnce(reply([], 0))
    expect(await new QuarkAdapter().searchFiles(account, 'missing')).toEqual([])
    network.fetch.mockResolvedValueOnce(reply([file('a'), file('b')])).mockResolvedValueOnce(reply([file('c')]))
    expect(await new QuarkAdapter().searchFiles(account, '.docx')).toHaveLength(3)
  })

  it('does not silently mark an incomplete total as a complete result', async () => {
    network.fetch.mockResolvedValueOnce(reply([file('a')], 3)).mockResolvedValueOnce(reply([], 3))
    await expect(new QuarkAdapter().searchFiles(account, '.docx')).rejects.toThrow('不完整')
  })
})

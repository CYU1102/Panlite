import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuarkAdapter } from './quark'
import type { DriveAccount } from '../shared/types'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: network.fetch }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../main/request-settings', () => ({ getRequestSettings: () => ({ quarkPageSize: 200, requestDelayMs: 0 }) }))
const account: DriveAccount = { id: 'pagination-fixture', platform: 'quark', nickname: 'fixture', loginType: 'cookie', credential: { cookies: 'sid=fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
const reply = (start: number, count: number, total: number) => new Response(JSON.stringify({ code: 0, metadata: { _total: total }, data: { list: Array.from({ length: count }, (_, offset) => ({ fid: String(start + offset), file_name: 'fixture', file_type: 1 })) } }))
beforeEach(() => network.fetch.mockReset())

describe.each(['listFiles', 'searchFiles'] as const)('Quark %s pagination', method => {
  const run = async () => {
    const result = await new QuarkAdapter()[method](account, '0')
    return Array.isArray(result) ? result : result.files
  }
  it('retains the 43 second-page entries when the provider reports zero total', async () => {
    network.fetch.mockResolvedValueOnce(reply(0, 200, 0)).mockResolvedValueOnce(reply(200, 43, 0))
    const files = await run()
    expect(files).toHaveLength(243)
    expect(new Set(files.map(file => file.id)).size).toBe(243)
    expect(new URL(network.fetch.mock.calls[1][0]).searchParams.get('_page')).toBe('2')
  })
  it('checks an empty trailing page for a full page with unknown total', async () => {
    network.fetch.mockResolvedValueOnce(reply(0, 200, 0)).mockResolvedValueOnce(reply(200, 0, 0))
    expect(await run()).toHaveLength(200)
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })
  it('accepts an actually empty directory', async () => {
    network.fetch.mockResolvedValueOnce(reply(0, 0, 0))
    expect(await run()).toEqual([])
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })
  it('stops at a positive total without requesting an extra page', async () => {
    network.fetch.mockResolvedValueOnce(reply(0, 200, 200))
    expect(await run()).toHaveLength(200)
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects an empty response before reaching the positive total', async () => {
    network.fetch.mockResolvedValueOnce(reply(0, 1, 3)).mockResolvedValueOnce(reply(1, 0, 3))
    await expect(run()).rejects.toThrow('不完整')
  })
  it('preserves the page limit when a zero total never reaches an end', async () => {
    network.fetch.mockImplementation(async () => reply(0, 200, 0))
    await expect(run()).rejects.toThrow(/上限.*不完整/)
    expect(network.fetch).toHaveBeenCalledTimes(100)
  })
})

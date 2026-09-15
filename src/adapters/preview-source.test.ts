import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAdapter, getSupportedPlatforms } from './registry'
import type { DriveAccount, Platform } from '../shared/types'

const clients = vi.hoisted(() => ({ fetch: vi.fn(), partition: vi.fn() }))
vi.mock('electron', () => ({
  net: { fetch: clients.fetch },
  session: { fromPartition: (partition: string) => { clients.partition(partition); return { fetch: clients.fetch } } },
}))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
afterEach(() => vi.restoreAllMocks())

describe('provider online preview authentication', () => {
  it.each(getSupportedPlatforms())('%s resolves the original source and required provider credentials', async (platform) => {
    const adapter = getAdapter(platform)
    const account: DriveAccount = {
      id: `source-${platform}`, platform: platform as Platform, nickname: 'Test fixture', loginType: 'cookie',
      credential: { cookies: 'fixture-cookie', serverUrl: 'https://dav.example.test/base', username: 'fixture-user', password: 'fixture-password' },
      status: 'active', createdAt: 0, updatedAt: 0, userAgent: 'fixture-agent',
    }
    vi.spyOn(adapter, 'getDownloadUrl').mockResolvedValue('https://download.example.test/original?token=fixture')
    expect(adapter.getDownloadSource).toBeTypeOf('function')
    const source = await adapter.getDownloadSource!(account, 'original-id')
    expect(adapter.getDownloadUrl).toHaveBeenCalledWith(account, 'original-id', ...(platform === 'quark' ? [expect.any(Function)] : []))
    expect(source.url).toBe('https://download.example.test/original?token=fixture')
    if (['quark', 'uc', 'baidu'].includes(platform)) {
      expect(source.headers?.Cookie).toBe('fixture-cookie')
      expect(source.headers?.Referer).toMatch(/^https:\/\//)
      expect(source.headers?.['User-Agent']).toBeTruthy()
    }
    if (platform === 'webdav') expect(source.headers?.Authorization).toBe(`Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`)
    if (platform === 'baidu') expect(source.headers?.['User-Agent']).toBe('fixture-agent')
    if (platform === 'xunlei') expect(source.headers?.['User-Agent']).toContain('AndroidDownloadManager')
    if (source.fetch) {
      const init = { headers: { Range: 'bytes=0-1' }, signal: new AbortController().signal }
      await source.fetch(source.url, init)
      expect(clients.fetch).toHaveBeenLastCalledWith(source.url, init)
    }
  })
})

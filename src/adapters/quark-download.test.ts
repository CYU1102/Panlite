import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'
import { QuarkAdapter } from './quark'

const electron = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: electron.fetch }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const account: DriveAccount = {
  id: 'quark-download-fixture', platform: 'quark', nickname: 'fixture', loginType: 'cookie',
  credential: { cookies: 'fixture-cookie' }, status: 'active', createdAt: 0, updatedAt: 0,
}

function reply(body: unknown): void {
  electron.fetch.mockResolvedValueOnce({ text: async () => JSON.stringify(body) })
}

beforeEach(() => electron.fetch.mockReset())

describe('Quark original file downloads', () => {
  it('returns the original download URL when the download API succeeds', async () => {
    reply({ code: 0, data: [{ download_url: 'https://download.example.test/original.mp4' }] })

    await expect(new QuarkAdapter().getDownloadUrl(account, 'file-id')).resolves.toBe('https://download.example.test/original.mp4')
    expect(electron.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = electron.fetch.mock.calls[0]
    expect(new URL(url).pathname).toBe('/1/clouddrive/file/download')
    expect(JSON.parse(options.body)).toEqual({ fids: ['file-id'] })
  })

  it.each([
    { code: 41001, message: '登录已失效' },
    { code: 0, data: [] },
  ])('fails without requesting a transcoding stream for $code responses without an original URL', async (response) => {
    reply(response)

    await expect(new QuarkAdapter().getDownloadUrl(account, 'video-id')).rejects.toThrow('获取原文件下载链接失败')
    expect(electron.fetch).toHaveBeenCalledTimes(1)
    expect(new URL(electron.fetch.mock.calls[0][0]).pathname).toBe('/1/clouddrive/file/download')
  })

  it('does not replace a network failure with a transcoding request', async () => {
    electron.fetch.mockRejectedValueOnce(new Error('network unavailable'))

    await expect(new QuarkAdapter().getDownloadUrl(account, 'video-id')).rejects.toThrow('获取原文件下载链接失败: network unavailable')
    expect(electron.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the separate playback URL method available', async () => {
    reply({ code: 0, data: { video_list: [{ video_info: { url: 'https://video.example.test/playlist.m3u8' } }] } })

    await expect(new QuarkAdapter().getTranscodingLink(account, 'video-id')).resolves.toBe('https://video.example.test/playlist.m3u8')
    expect(new URL(electron.fetch.mock.calls[0][0]).pathname).toBe('/1/clouddrive/file/v2/play/project')
  })
})

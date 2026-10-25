import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'
import { QuarkAdapter } from './quark'
import { UcAdapter } from './uc'
import { XunleiAdapter } from './xunlei'

const electron = vi.hoisted(() => ({
  fetch: vi.fn(),
  request: vi.fn(),
  executeJavaScript: vi.fn(),
  setCookie: vi.fn(),
}))

// Every provider request and browser surface is replaced with a local fixture.
vi.mock('electron', () => ({
  net: { request: electron.request },
  session: { fromPartition: () => ({ fetch: electron.fetch, cookies: { set: electron.setCookie } }) },
  BrowserWindow: class {
    private destroyed = false
    webContents = {
      setWindowOpenHandler() {},
      executeJavaScript: electron.executeJavaScript,
    }
    async loadURL() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  },
}))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../shared/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/utils')>(),
  sleep: async () => {},
}))

let sequence = 0

function account(platform: 'quark' | 'uc' | 'xunlei'): DriveAccount {
  return {
    id: `save-target-${++sequence}`,
    platform,
    nickname: 'local fixture',
    loginType: platform === 'xunlei' ? 'token' : 'cookie',
    credential: platform === 'xunlei'
      ? { accessToken: 'fixture-access', userId: 'fixture-user' }
      : { cookies: 'fixture=session' },
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  }
}

function reply(body: unknown): void {
  electron.fetch.mockResolvedValueOnce({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(body),
    json: async () => body,
  })
}

function panReplies(destinationIds: unknown): void {
  reply({ code: 0, data: { stoken: 'fixture-token', token_info: { stoken: 'fixture-token' } } })
  reply({
    code: 0,
    data: {
      is_owner: 0,
      list: [
        { fid: 'source-a', share_fid_token: 'token-a', file_name: '广告.txt' },
        { fid: 'source-b', share_fid_token: 'token-b', file_name: 'notes.txt' },
      ],
    },
  })
  reply({ code: 0, data: { task_id: 'save-task' } })
  reply({ code: 0, data: { status: 2, save_as: { save_as_top_fids: destinationIds } } })
}

beforeEach(() => {
  electron.fetch.mockReset().mockImplementation(() => { throw new Error('Unexpected provider request') })
  electron.request.mockReset().mockImplementation(() => { throw new Error('Unexpected net request') })
  electron.executeJavaScript.mockReset()
  electron.setCookie.mockReset().mockResolvedValue(undefined)
})

describe('share save destination IDs', () => {
  for (const platform of ['quark', 'uc'] as const) {
    const adapter = () => platform === 'quark' ? new QuarkAdapter() : new UcAdapter()
    const url = () => `https://${platform === 'quark' ? 'pan.quark.cn' : 'drive.uc.cn'}/s/fixture${++sequence}`

    it.each([undefined, null, 'invalid'])(`${platform} preserves save success without exposing source IDs for %s destination IDs`, async (destinationIds) => {
      panReplies(destinationIds)

      const result = await adapter().saveSharedFiles(account(platform), { url: url() }, 'target-folder')

      expect(result).toMatchObject({ success: true, savedCount: 2, targetDirId: 'target-folder' })
      expect(result.savedFileIds).toBeUndefined()
      expect(result.savedFileNames).toBeUndefined()
      expect(electron.fetch).toHaveBeenCalledTimes(4)
      const saveOptions = electron.fetch.mock.calls[2][1]
      expect(JSON.parse(saveOptions.body).fid_list).toEqual(['source-a', 'source-b'])
    })

    it(`${platform} leaves an empty destination list empty`, async () => {
      panReplies([])

      const result = await adapter().saveSharedFiles(account(platform), { url: url() }, 'target-folder')

      expect(result).toMatchObject({ success: true, savedCount: 2, savedFileIds: [] })
      expect(result.savedFileNames).toBeUndefined()
    })

    it(`${platform} retains confirmed destination IDs without assuming source-name order`, async () => {
      panReplies(['target-b', 'target-a'])

      const result = await adapter().saveSharedFiles(account(platform), { url: url() }, 'target-folder')

      expect(result).toMatchObject({ success: true, savedCount: 2, savedFileIds: ['target-b', 'target-a'] })
      expect(result.savedFileNames).toBeUndefined()
    })
  }

  it('Xunlei keeps a completed restore successful without exposing IDs from the share page', async () => {
    reply({ captcha_token: 'fixture-captcha', expires_in: 3600 })
    reply({ restore_status: 'RESTORE_COMPLETE' })
    electron.executeJavaScript.mockResolvedValue({
      ready: true,
      files: [{ fileId: 'source-xunlei', name: '广告.txt', isDir: false, size: 12 }],
      allFileIds: ['source-xunlei'],
      passCodeToken: 'fixture-pass-code',
    })

    const result = await new XunleiAdapter().saveSharedFiles(
      account('xunlei'), { url: 'https://pan.xunlei.com/s/fixture' }, 'target-folder',
    )

    expect(result).toMatchObject({ success: true, savedCount: 1, targetDirId: 'target-folder' })
    expect(result.savedFileIds).toBeUndefined()
    expect(result.savedFileNames).toBeUndefined()
    expect(electron.fetch).toHaveBeenCalledTimes(2)
    expect(electron.request).not.toHaveBeenCalled()
    expect(JSON.parse(electron.fetch.mock.calls[1][1].body).file_ids).toEqual(['source-xunlei'])
  })
})

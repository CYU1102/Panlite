import type { EventEmitter } from 'node:events'
import type { BrowserWindowConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'

const mocks = vi.hoisted(() => ({
  windows: [] as Array<{
    options: BrowserWindowConstructorOptions
    webContents: EventEmitter
    loadURL: ReturnType<typeof vi.fn>
    isDestroyed: () => boolean
  }>,
  setCookie: vi.fn().mockResolvedValue(undefined),
  fromPartition: vi.fn(),
  fetch: vi.fn().mockRejectedValue(new Error('Unexpected network request')),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    net: { fetch: mocks.fetch },
    session: { fromPartition: mocks.fromPartition },
    BrowserWindow: class extends EventEmitter {
      webContents = new EventEmitter()
      loadURL = vi.fn().mockResolvedValue(undefined)
      private destroyed = false

      constructor(public options: BrowserWindowConstructorOptions) {
        super()
        mocks.windows.push(this)
      }

      isDestroyed() { return this.destroyed }
      destroy() { this.destroyed = true }
    },
  }
})

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { baiduAdapter } from './baidu'

function account(): DriveAccount {
  return {
    id: 'baidu-window-test', platform: 'baidu', nickname: 'test',
    loginType: 'cookie', credential: { cookies: 'BDUSS=test-cookie' },
    status: 'active', createdAt: 0, updatedAt: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.windows.length = 0
  mocks.fromPartition.mockReturnValue({
    cookies: { set: mocks.setCookie },
    webRequest: { onBeforeSendHeaders: vi.fn(), onCompleted: vi.fn() },
  })
})

describe('Baidu business browser security', () => {
  it.each(['share', 'transfer'] as const)('sandboxes the actual %s window while preserving its cookie session', async (operation) => {
    const pending = operation === 'share'
      ? baiduAdapter.createShare(account(), [{ fileId: '123', name: 'test.txt' }])
      : baiduAdapter.saveSharedFiles(account(), { url: 'https://pan.baidu.com/s/1test' }, '0')
    const settled = pending.then(() => undefined, (error: unknown) => error)

    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1))
    const win = mocks.windows[0]
    // Stop before executing page scripts; no browser or account request is made.
    win.webContents.emit('did-fail-load', {}, -105, 'test navigation stopped')
    await expect(settled).resolves.toBeInstanceOf(Error)

    expect(win.options.webPreferences).toMatchObject({
      partition: 'persist:baidu',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    })
    expect(win.options.webPreferences?.preload).toBeUndefined()
    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:baidu')
    expect(mocks.setCookie).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://pan.baidu.com', name: 'BDUSS', value: 'test-cookie', secure: true,
    }))
    expect(win.loadURL).toHaveBeenCalledWith(operation === 'share'
      ? 'https://pan.baidu.com/disk/main'
      : 'https://pan.baidu.com/s/1test')
    expect(win.isDestroyed()).toBe(true)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fromId: vi.fn(),
  fromPartition: vi.fn(),
  baiduCheck: vi.fn(),
  baiduInfo: vi.fn(),
  quarkCheck: vi.fn(),
  quarkInfo: vi.fn(),
  ucCheck: vi.fn(),
  ucInfo: vi.fn(),
}))

vi.mock('electron', () => ({
  webContents: { fromId: mocks.fromId },
  session: { fromPartition: mocks.fromPartition },
}))
vi.mock('../adapters/baidu', () => ({ baiduAdapter: { checkLogin: mocks.baiduCheck, getUserInfo: mocks.baiduInfo } }))
vi.mock('../adapters/quark', () => ({ quarkAdapter: { checkLogin: mocks.quarkCheck, getUserInfo: mocks.quarkInfo } }))
vi.mock('../adapters/uc', () => ({ ucAdapter: { checkLogin: mocks.ucCheck, getUserInfo: mocks.ucInfo } }))

import { clearInlineLoginInspection, getInlineLoginStatus, resetInlineLoginSession, resolveInlineLoginGuest } from './inline-login'

function fixture(platform: 'quark' | 'baidu' | 'uc', cookieName = 'BDUSS') {
  const sender = {}
  const partition = {
    cookies: { get: vi.fn().mockResolvedValue([{ domain: `.${platform === 'baidu' ? 'baidu.com' : `${platform}.cn`}`, name: cookieName, value: 'x'.repeat(80) }]) },
    fetch: vi.fn().mockResolvedValue({ ok: true }),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
  }
  const host = platform === 'quark' ? 'pan.quark.cn' : platform === 'baidu' ? 'pan.baidu.com' : 'drive.uc.cn'
  const guest = {
    id: 7,
    hostWebContents: sender,
    session: partition,
    isDestroyed: () => false,
    getType: () => 'webview',
    getURL: () => `https://${host}/`,
    getUserAgent: () => 'fixture-agent',
  }
  mocks.fromId.mockReturnValue(guest)
  mocks.fromPartition.mockReturnValue(partition)
  return { sender, guest, partition }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearInlineLoginInspection()
  mocks.baiduCheck.mockResolvedValue(true)
  mocks.baiduInfo.mockResolvedValue({ nickname: '百度测试用户' })
  mocks.quarkCheck.mockResolvedValue(true)
  mocks.quarkInfo.mockResolvedValue({ nickname: '夸克测试用户' })
  mocks.ucCheck.mockResolvedValue(true)
  mocks.ucInfo.mockResolvedValue({ nickname: 'UC测试用户' })
})

describe('inline login guest validation', () => {
  it('accepts only a provider webview owned by the calling renderer', () => {
    const { sender, guest } = fixture('baidu')
    expect(resolveInlineLoginGuest(sender as never, { platform: 'baidu', webContentsId: 7 })).toBe(guest)
  })

  it('rejects foreign owners, sessions, URLs and invalid IDs', () => {
    const { sender, guest } = fixture('baidu')
    guest.hostWebContents = {}
    expect(() => resolveInlineLoginGuest(sender as never, { platform: 'baidu', webContentsId: 7 })).toThrow('不属于当前窗口')
    guest.hostWebContents = sender
    guest.getURL = () => 'https://baidu.com.evil.test/'
    expect(() => resolveInlineLoginGuest(sender as never, { platform: 'baidu', webContentsId: 7 })).toThrow('来源校验失败')
    expect(() => resolveInlineLoginGuest(sender as never, { platform: 'baidu', webContentsId: 0 })).toThrow('无效')
  })
})

describe('inline login credential verification', () => {
  it('waits until Baidu has an authenticated cookie', async () => {
    const { sender, partition } = fixture('baidu', 'BAIDUID')
    expect(await getInlineLoginStatus({ sender } as never, { platform: 'baidu', webContentsId: 7 })).toEqual({ state: 'pending' })
    expect(mocks.baiduCheck).not.toHaveBeenCalled()
    expect(partition.cookies.get).toHaveBeenCalled()
  })

  it('verifies Baidu credentials before reporting success', async () => {
    const { sender } = fixture('baidu')
    const status = await getInlineLoginStatus({ sender } as never, { platform: 'baidu', webContentsId: 7 })
    expect(status).toMatchObject({ state: 'success', result: { success: true, nickname: '百度测试用户', userAgent: 'fixture-agent' } })
    expect(mocks.baiduCheck).toHaveBeenCalledOnce()
  })

  it('keeps polling when an apparently populated session fails API verification', async () => {
    const { sender } = fixture('quark', '__puus')
    mocks.quarkCheck.mockResolvedValue(false)
    expect(await getInlineLoginStatus({ sender } as never, { platform: 'quark', webContentsId: 7 })).toEqual({ state: 'pending' })
  })

  it('clears only the validated guest session when switching accounts', async () => {
    const { sender, partition } = fixture('uc', '__puus')
    expect(await resetInlineLoginSession({ sender } as never, { platform: 'uc', webContentsId: 7 })).toEqual({ success: true })
    expect(partition.clearStorageData).toHaveBeenCalledOnce()
  })
})

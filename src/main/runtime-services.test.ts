import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig } from '../shared/ai-types'
import { IPC_CHANNELS } from '../shared/constants'
import type { TrayNotificationManager } from './tray-notifications'

const mocks = vi.hoisted(() => ({ getAllWindows: vi.fn(), isTrustedRendererUrl: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: mocks.getAllWindows } }))
vi.mock('./ipc-security', () => ({ isTrustedRendererUrl: mocks.isTrustedRendererUrl }))

import { notifyAiProviderChanged, setTrayNotificationManager } from './runtime-services'

const activeConfig: AiProviderConfig = {
  id: 'active-profile', name: 'Active fixture', type: 'anthropic',
  baseUrl: 'https://models.example.test/v1', model: 'fixture-model',
  transcriptionModel: '', embeddingModel: '', hasApiKey: true,
  keyCount: 2, keyPreviews: ['fixtur***0001', 'fixtur***0002'],
}

function windowFixture(url = 'file:///panlite/index.html') {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => url),
      send: vi.fn(),
    },
  }
}

function trayFixture() {
  const tray = { rebuildMenu: vi.fn() }
  setTrayNotificationManager(tray as unknown as TrayNotificationManager)
  return tray
}

beforeEach(() => {
  setTrayNotificationManager(null)
  mocks.getAllWindows.mockReset().mockReturnValue([])
  mocks.isTrustedRendererUrl.mockReset().mockImplementation((url: string) => url === 'file:///panlite/index.html')
})

afterEach(() => setTrayNotificationManager(null))

describe('AI provider change notifications', () => {
  it('delivers the active config only to live trusted application windows', () => {
    const first = windowFixture()
    const second = windowFixture()
    const login = windowFixture('https://login.example.test/')
    const closedWindow = windowFixture()
    closedWindow.isDestroyed.mockReturnValue(true)
    const closedContents = windowFixture()
    closedContents.webContents.isDestroyed.mockReturnValue(true)
    mocks.getAllWindows.mockReturnValue([first, login, closedWindow, closedContents, second])
    const tray = trayFixture()

    notifyAiProviderChanged(activeConfig)

    for (const window of [first, second]) {
      expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.AI_PROVIDER_CHANGED, activeConfig)
    }
    for (const window of [login, closedWindow, closedContents]) expect(window.webContents.send).not.toHaveBeenCalled()
    expect(closedWindow.webContents.getURL).not.toHaveBeenCalled()
    expect(closedContents.webContents.getURL).not.toHaveBeenCalled()
    expect(tray.rebuildMenu).toHaveBeenCalledOnce()
  })

  it('still delivers a saved configuration when rebuilding the tray fails', () => {
    const window = windowFixture()
    mocks.getAllWindows.mockReturnValue([window])
    trayFixture().rebuildMenu.mockImplementation(() => { throw new Error('tray is unavailable') })

    expect(() => notifyAiProviderChanged(activeConfig)).not.toThrow()
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.AI_PROVIDER_CHANGED, activeConfig)
  })

  it('continues notifying other windows after one send fails and supports later changes', () => {
    const failing = windowFixture()
    const healthy = windowFixture()
    failing.webContents.send.mockImplementation(() => { throw new Error('window closed while sending') })
    mocks.getAllWindows.mockReturnValue([failing, healthy])
    const nextConfig = { ...activeConfig, id: 'next-profile', model: 'next-fixture-model' }

    expect(() => notifyAiProviderChanged(activeConfig)).not.toThrow()
    expect(() => notifyAiProviderChanged(nextConfig)).not.toThrow()

    expect(healthy.webContents.send).toHaveBeenNthCalledWith(1, IPC_CHANNELS.AI_PROVIDER_CHANGED, activeConfig)
    expect(healthy.webContents.send).toHaveBeenNthCalledWith(2, IPC_CHANNELS.AI_PROVIDER_CHANGED, nextConfig)
    expect(healthy.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('isolates a renderer destroyed between its liveness check and URL lookup', () => {
    const closing = windowFixture()
    const healthy = windowFixture()
    closing.webContents.getURL.mockImplementation(() => { throw new Error('webContents destroyed') })
    mocks.getAllWindows.mockReturnValue([closing, healthy])

    expect(() => notifyAiProviderChanged(activeConfig)).not.toThrow()
    expect(closing.webContents.send).not.toHaveBeenCalled()
    expect(healthy.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.AI_PROVIDER_CHANGED, activeConfig)
  })

  it('refreshes the tray while no application windows are open', () => {
    const tray = trayFixture()

    expect(() => notifyAiProviderChanged(activeConfig)).not.toThrow()
    expect(tray.rebuildMenu).toHaveBeenCalledOnce()
    expect(mocks.isTrustedRendererUrl).not.toHaveBeenCalled()
  })
})

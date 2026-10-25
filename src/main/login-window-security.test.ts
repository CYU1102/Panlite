import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  session: { fromPartition: vi.fn() },
}))

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { isLoginConfirmFromWindow } from './login-window'

describe('login confirmation sender policy', () => {
  it('accepts only the login window main frame', () => {
    const mainFrame = {}
    const webContents = { mainFrame }
    const loginWindow = { isDestroyed: () => false, webContents }

    expect(isLoginConfirmFromWindow({ sender: webContents, senderFrame: mainFrame }, loginWindow)).toBe(true)
    expect(isLoginConfirmFromWindow({ sender: {}, senderFrame: mainFrame }, loginWindow)).toBe(false)
    expect(isLoginConfirmFromWindow({ sender: webContents, senderFrame: {} }, loginWindow)).toBe(false)
    expect(isLoginConfirmFromWindow({ sender: webContents, senderFrame: null }, loginWindow)).toBe(false)
  })

  it('rejects confirmations after the login window is destroyed', () => {
    const mainFrame = {}
    const webContents = { mainFrame }
    const loginWindow = { isDestroyed: () => true, webContents }
    expect(isLoginConfirmFromWindow({ sender: webContents, senderFrame: mainFrame }, loginWindow)).toBe(false)
  })
})

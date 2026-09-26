import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(() => '/fixture') },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn() },
}))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), error: vi.fn() } }))

import { shouldAllowWebviewNavigation } from './window'

describe('webview navigation policy', () => {
  it('allows provider subdomains for an inline login', () => {
    const policy = { origin: 'https://pan.baidu.com', inlineLoginPlatform: 'baidu' as const }
    expect(shouldAllowWebviewNavigation(policy, 'https://passport.baidu.com/v2/')).toBe(true)
    expect(shouldAllowWebviewNavigation(policy, 'https://baidu.com.evil.test/')).toBe(false)
    expect(shouldAllowWebviewNavigation(policy, 'http://pan.baidu.com/')).toBe(false)
  })

  it('keeps ordinary resource webviews on their initial origin', () => {
    const policy = { origin: 'https://catalog.example.test', inlineLoginPlatform: null }
    expect(shouldAllowWebviewNavigation(policy, 'https://catalog.example.test/detail/1')).toBe(true)
    expect(shouldAllowWebviewNavigation(policy, 'https://other.example.test/')).toBe(false)
  })
})

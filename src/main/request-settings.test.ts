import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_REQUEST_SETTINGS,
  configureRequestSettings,
  getRequestSettings,
  normalizeRequestSetting,
  resetRequestSettings,
} from './request-settings'

describe('request settings', () => {
  afterEach(resetRequestSettings)

  it('accepts valid integer strings and updates runtime values', () => {
    configureRequestSettings({ quarkPageSize: '320', requestDelayMs: 0 })
    expect(getRequestSettings()).toEqual({
      ...DEFAULT_REQUEST_SETTINGS,
      quarkPageSize: 320,
      requestDelayMs: 0,
    })
  })

  it('rejects non-integers and values outside the supported range', () => {
    expect(() => normalizeRequestSetting('baiduPageSize', 1001)).toThrow(/20.*1000/)
    expect(() => normalizeRequestSetting('requestDelayMs', 1.5)).toThrow(/整数/)
    expect(() => normalizeRequestSetting('quarkPageSize', 'oops')).toThrow(/有效数字/)
  })

  it('returns a copy that cannot mutate runtime state', () => {
    const settings = getRequestSettings()
    settings.baiduPageSize = 999
    expect(getRequestSettings().baiduPageSize).toBe(DEFAULT_REQUEST_SETTINGS.baiduPageSize)
  })
})

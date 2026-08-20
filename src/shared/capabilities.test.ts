import { describe, expect, it } from 'vitest'
import { getPlatformCapabilities, PLATFORM_CAPABILITIES } from './capabilities'

describe('platform capabilities', () => {
  it('only enables server-side copy for Baidu', () => {
    expect(PLATFORM_CAPABILITIES.baidu.copy).toBe(true)
    expect(PLATFORM_CAPABILITIES.quark.copy).toBe(false)
    expect(PLATFORM_CAPABILITIES.uc.copy).toBe(false)
    expect(PLATFORM_CAPABILITIES.xunlei.copy).toBe(false)
  })

  it('enables the common file workflows for every platform', () => {
    for (const capabilities of Object.values(PLATFORM_CAPABILITIES)) {
      expect(capabilities.uploadFile).toBe(true)
      expect(capabilities.uploadFolder).toBe(true)
      expect(capabilities.downloadFile).toBe(true)
      expect(capabilities.downloadFolder).toBe(true)
      expect(capabilities.share).toBe(true)
      expect(capabilities.browseArchive).toBe(true)
      expect(capabilities.extractArchive).toBe(true)
      expect(capabilities.createArchive).toBe(true)
      expect(capabilities.createArchiveFromFolder).toBe(false)
    }
  })

  it('returns a safe disabled capability set without an active account', () => {
    expect(getPlatformCapabilities(null).list).toBe(false)
    expect(getPlatformCapabilities(undefined).downloadFile).toBe(false)
  })
})

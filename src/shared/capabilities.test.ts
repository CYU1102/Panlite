import { describe, expect, it } from 'vitest'
import { getPlatformCapabilities, PLATFORM_CAPABILITIES } from './capabilities'

describe('platform capabilities', () => {
  it('enables server-side copy only for platforms with a copy endpoint', () => {
    expect(PLATFORM_CAPABILITIES.baidu.copy).toBe(true)
    expect(PLATFORM_CAPABILITIES.quark.copy).toBe(true)
    expect(PLATFORM_CAPABILITIES.uc.copy).toBe(true)
    expect(PLATFORM_CAPABILITIES.xunlei.copy).toBe(false)
    expect(PLATFORM_CAPABILITIES.webdav.copy).toBe(false)
  })

  it('keeps share/transfer exclusive to platforms with a share protocol', () => {
    for (const [platform, capabilities] of Object.entries(PLATFORM_CAPABILITIES)) {
      if (platform === 'webdav' || platform === 'aliyun' || platform === 'pan123') {
        expect(capabilities.share).toBe(false)
        expect(capabilities.transfer).toBe(false)
      } else {
        expect(capabilities.share).toBe(true)
        expect(capabilities.transfer).toBe(true)
      }
    }
  })

  it('enables the common file workflows for every platform', () => {
    for (const [platform, capabilities] of Object.entries(PLATFORM_CAPABILITIES)) {
      // 阿里云盘·网页版上传需要 proof code 机制，暂未开放
      const expectsUpload = platform !== 'aliyun_web'
      expect(capabilities.uploadFile).toBe(expectsUpload)
      expect(capabilities.uploadFolder).toBe(expectsUpload)
      expect(capabilities.createArchive).toBe(expectsUpload)
      expect(capabilities.downloadFile).toBe(true)
      expect(capabilities.downloadFolder).toBe(true)
      expect(capabilities.browseArchive).toBe(true)
      expect(capabilities.extractArchive).toBe(true)
      expect(capabilities.createArchiveFromFolder).toBe(expectsUpload)
    }
  })

  it('returns a safe disabled capability set without an active account', () => {
    expect(getPlatformCapabilities(null).list).toBe(false)
    expect(getPlatformCapabilities(undefined).downloadFile).toBe(false)
  })
})

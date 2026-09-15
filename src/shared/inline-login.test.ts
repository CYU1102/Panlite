import { describe, expect, it } from 'vitest'
import { getInlineLoginPlatformByPartition, isInlineLoginUrl } from './inline-login'

describe('inline login configuration', () => {
  it('maps only dedicated login partitions', () => {
    expect(getInlineLoginPlatformByPartition('persist:quark-login')).toBe('quark')
    expect(getInlineLoginPlatformByPartition('persist:baidu-login')).toBe('baidu')
    expect(getInlineLoginPlatformByPartition('persist:uc-login')).toBe('uc')
    expect(getInlineLoginPlatformByPartition('persist:resource-browser')).toBeNull()
  })

  it('allows HTTPS provider subdomains without suffix-confusion bypasses', () => {
    expect(isInlineLoginUrl('quark', 'https://pan.quark.cn/')).toBe(true)
    expect(isInlineLoginUrl('baidu', 'https://passport.baidu.com/v2/')).toBe(true)
    expect(isInlineLoginUrl('uc', 'https://drive.uc.cn/')).toBe(true)
    expect(isInlineLoginUrl('quark', 'https://quark.cn.evil.test/')).toBe(false)
    expect(isInlineLoginUrl('baidu', 'http://pan.baidu.com/')).toBe(false)
    expect(isInlineLoginUrl('uc', 'javascript:alert(1)')).toBe(false)
  })
})

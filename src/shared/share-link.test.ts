import { describe, expect, it } from 'vitest'
import { detectShareLinks, formatShareLinkLine } from './share-link'

describe('detectShareLinks', () => {
  it('detects links for every supported platform', () => {
    const hits = detectShareLinks([
      'https://pan.quark.cn/s/abc123',
      'https://pan.baidu.com/s/1abcdef?pwd=x9y8',
      'https://drive.uc.cn/s/ucABC1',
      'https://pan.xunlei.com/s/XLabc-1?pwd=1234',
      'https://www.alipan.com/s/Ali-abc_1',
    ].join('\n'))
    expect(hits.map(item => item.platform)).toEqual(['quark', 'baidu', 'uc', 'xunlei', 'aliyun_web'])
    expect(hits[1]).toMatchObject({ url: 'https://pan.baidu.com/s/1abcdef?pwd=x9y8', password: 'x9y8' })
    expect(hits[3].password).toBe('1234')
  })

  it('upgrades legacy baidu share/init urls', () => {
    const [hit] = detectShareLinks('https://pan.baidu.com/share/init?surl=1abcDEF')
    expect(hit?.platform).toBe('baidu')
    expect(hit?.url).toBe('https://pan.baidu.com/s/1abcDEF')
  })

  it('extracts passwords from surrounding text', () => {
    const [labeled] = detectShareLinks('资源在这 https://pan.quark.cn/s/qwerty 提取码：ab12')
    expect(labeled?.password).toBe('ab12')
    const [bare] = detectShareLinks('https://pan.quark.cn/s/qwerty ab12')
    expect(bare?.password).toBe('ab12')
    const [none] = detectShareLinks('https://pan.quark.cn/s/qwerty 没有密码')
    expect(none?.password).toBeUndefined()
  })

  it('ignores trailing punctuation and non-link text', () => {
    const [hit] = detectShareLinks('快转！https://pan.quark.cn/s/abc123，手慢无')
    expect(hit?.url).toBe('https://pan.quark.cn/s/abc123')
    expect(detectShareLinks('这里没有链接 https://example.com/foo')).toEqual([])
    expect(detectShareLinks('')).toEqual([])
  })

  it('deduplicates host casing while preserving case-sensitive share IDs', () => {
    const hits = detectShareLinks([
      'https://pan.quark.cn/s/abc123',
      'https://pan.quark.cn/s/abc123 提取码: zz99',
      'HTTPS://PAN.QUARK.CN/s/abc123',
      'https://pan.quark.cn/s/ABC123',
    ].join('\n'))
    expect(hits).toHaveLength(2)
    expect(hits[0].password).toBe('zz99')
    expect(hits[1].url).toBe('https://pan.quark.cn/s/ABC123')
  })

  it('retains legacy and query passwords before normalizing links', () => {
    expect(detectShareLinks('https://pan.baidu.com/share/init?surl=abcDEF 提取码: z9X8')[0])
      .toMatchObject({ url: 'https://pan.baidu.com/s/1abcDEF', password: 'z9X8' })
    expect(detectShareLinks('https://pan.baidu.com/share/init?surl=abcDEF&pwd=z9X8')[0]?.password).toBe('z9X8')
    expect(detectShareLinks('https://pan.quark.cn/s/abc?pwd=z9X8')[0]?.password).toBe('z9X8')
  })

  it('formats lines with the password label for transfer input', () => {
    expect(formatShareLinkLine({ platform: 'quark', url: 'https://pan.quark.cn/s/abc', password: 'ab12' }))
      .toBe('https://pan.quark.cn/s/abc 提取码: ab12')
    expect(formatShareLinkLine({ platform: 'quark', url: 'https://pan.quark.cn/s/abc' }))
      .toBe('https://pan.quark.cn/s/abc')
  })
})

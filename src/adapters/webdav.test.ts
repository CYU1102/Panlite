import { describe, expect, it } from 'vitest'
import {
  baseName,
  encodeDavPath,
  idToPath,
  normalizeDavBase,
  parentPath,
  parseMultistatus,
  parseQuotaFromPropfind,
  pathToId,
} from './webdav'

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/Docs/%E6%96%87%E6%A1%A3/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
      <d:creationdate>2026-01-02T03:04:05Z</d:creationdate>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/Docs/report.pdf</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>2048</d:getcontentlength>
      <d:getlastmodified>Mon, 03 Aug 2026 10:00:00 GMT</d:getlastmodified>
      <d:creationdate>2026-08-01T00:00:00Z</d:creationdate>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`

describe('webdav path helpers', () => {
  it('maps root id and paths consistently', () => {
    expect(idToPath('0')).toBe('/')
    expect(idToPath('')).toBe('/')
    expect(idToPath('/Docs/a.txt')).toBe('/Docs/a.txt')
    expect(idToPath('Docs')).toBe('/Docs')
    expect(pathToId('/')).toBe('0')
    expect(pathToId('/Docs/')).toBe('/Docs')
  })

  it('encodes path segments but keeps slashes', () => {
    expect(encodeDavPath('/我的 文档/a&b.txt')).toBe('/%E6%88%91%E7%9A%84%20%E6%96%87%E6%A1%A3/a%26b.txt')
  })

  it('computes parent and base names', () => {
    expect(parentPath('/Docs/a.txt')).toBe('/Docs')
    expect(parentPath('/a.txt')).toBe('/')
    expect(baseName('/Docs/')).toBe('Docs')
    expect(baseName('/Docs/a.txt')).toBe('a.txt')
  })

  it('normalizes server urls strictly', () => {
    expect(normalizeDavBase('https://dav.example.com/dav/')).toBe('https://dav.example.com/dav')
    expect(() => normalizeDavBase('')).toThrow('未配置')
    expect(() => normalizeDavBase('ftp://x')).toThrow('http(s)')
  })
})

describe('parseMultistatus', () => {
  it('parses collections, files, sizes and dates with namespaced tags', () => {
    const entries = parseMultistatus(MULTISTATUS)
    expect(entries).toHaveLength(3)
    const docs = entries.find(item => item.name === '文档')
    expect(docs?.isDir).toBe(true)
    expect(docs?.path).toBe('/dav/Docs/文档/')
    const report = entries.find(item => item.name === 'report.pdf')
    expect(report?.isDir).toBe(false)
    expect(report?.size).toBe(2048)
    expect(report?.updatedAt).toBe(Date.parse('Mon, 03 Aug 2026 10:00:00 GMT'))
  })

  it('returns empty for non-multistatus payloads', () => {
    expect(parseMultistatus('')).toEqual([])
    expect(parseMultistatus('<html>403</html>')).toEqual([])
  })
})

describe('parseQuotaFromPropfind', () => {
  it('reads RFC 4331 quota properties', () => {
    const xml = '<d:response><d:prop><d:quota-used-bytes>1024</d:quota-used-bytes><d:quota-available-bytes>3072</d:quota-available-bytes></d:prop></d:response>'
    expect(parseQuotaFromPropfind(xml)).toEqual({ used: 1024, total: 4096 })
  })

  it('treats missing quota properties as unknown total', () => {
    expect(parseQuotaFromPropfind('<d:response></d:response>')).toEqual({ used: 0, total: 0 })
  })
})

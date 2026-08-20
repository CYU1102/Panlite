import { describe, expect, it } from 'vitest'
import { ARCHIVE_LIMITS, assertArchiveLimits, normalizeArchiveEntryPath, resolveArchiveEntryPath } from './archive-security'

describe('archive path protection', () => {
  it('normalizes safe relative paths', () => {
    expect(normalizeArchiveEntryPath('folder\\nested/file.txt')).toBe('folder/nested/file.txt')
  })

  it.each(['../outside.txt', 'folder/../../outside.txt', '/absolute.txt', 'C:\\absolute.txt', 'bad\0name']) (
    'rejects unsafe entry %s',
    (entry) => expect(() => normalizeArchiveEntryPath(entry)).toThrow(),
  )

  it('keeps resolved entries inside the output directory', () => {
    const target = resolveArchiveEntryPath('C:\\safe-output', 'folder/file.txt')
    expect(target.toLowerCase()).toContain('safe-output')
    expect(target.toLowerCase()).toContain('folder')
  })
})

describe('archive resource limits', () => {
  it('rejects suspicious compression ratios', () => {
    expect(() => assertArchiveLimits([{
      name: 'bomb.bin',
      path: 'bomb.bin',
      size: ARCHIVE_LIMITS.maxCompressionRatio + 1,
      compressedSize: 1,
      isDir: false,
    }])).toThrow(/压缩比异常/)
  })

  it('accepts ordinary metadata', () => {
    expect(() => assertArchiveLimits([{
      name: 'file.txt',
      path: 'folder/file.txt',
      size: 1024,
      compressedSize: 512,
      isDir: false,
    }])).not.toThrow()
  })
})

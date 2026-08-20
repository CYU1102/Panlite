import { describe, expect, it } from 'vitest'
import type { FileItem } from './types'
import {
  buildBatchRenameName,
  buildBatchRenamePreview,
  toBatchRenameItems,
  validateFileName,
} from './batch-rename'

function file(id: string, name: string, parentId = 'root', isDir = false): FileItem {
  return {
    id,
    parentId,
    name,
    isDir,
    size: 0,
    createdAt: 1,
    updatedAt: 1,
    platform: 'baidu',
    accountId: 'account',
  }
}

describe('buildBatchRenameName', () => {
  it('supports plain replacement without regex semantics', () => {
    expect(buildBatchRenameName(file('1', 'a.b.txt'), 0, {
      mode: 'replace',
      replaceFrom: '.',
      replaceTo: '-',
    })).toBe('a-b-txt')
  })

  it('supports regular expressions', () => {
    expect(buildBatchRenameName(file('1', 'IMG_2026.jpg'), 0, {
      mode: 'replace',
      replaceFrom: '^IMG_(\\d+)',
      replaceTo: '照片-$1',
      useRegex: true,
    })).toBe('照片-2026.jpg')
  })

  it('adds prefixes, suffixes and padded sequences while preserving extensions', () => {
    const target = file('1', 'report.pdf')
    expect(buildBatchRenameName(target, 0, { mode: 'prefix', prefix: 'done-' })).toBe('done-report.pdf')
    expect(buildBatchRenameName(target, 0, { mode: 'suffix', suffix: '-final' })).toBe('report-final.pdf')
    expect(buildBatchRenameName(target, 4, {
      mode: 'sequence',
      sequenceStart: 7,
      sequenceDigits: 3,
      sequenceSeparator: '-',
    })).toBe('011-report.pdf')
  })
})

describe('buildBatchRenamePreview', () => {
  it('reports invalid regular expressions', () => {
    const preview = buildBatchRenamePreview([file('1', 'a.txt')], {
      mode: 'replace',
      replaceFrom: '[',
      useRegex: true,
    })
    expect(preview.valid).toBe(false)
    expect(preview.errors[0]).toContain('正则表达式无效')
  })

  it('detects duplicate final names in the same directory', () => {
    const preview = buildBatchRenamePreview(
      [file('1', 'a.txt'), file('2', 'b.txt')],
      { mode: 'replace', replaceFrom: /^[ab]/.source, replaceTo: 'same', useRegex: true },
    )
    expect(preview.valid).toBe(false)
    expect(preview.items.every((item) => item.errors.some((error) => error.includes('重复名称')))).toBe(true)
  })

  it('allows equal names in different directories and builds existing submission items', () => {
    const preview = buildBatchRenamePreview(
      [file('1', 'a.txt', 'one'), file('2', 'a.txt', 'two')],
      { mode: 'prefix', prefix: 'new-' },
    )
    expect(preview.valid).toBe(true)
    expect(toBatchRenameItems(preview)).toEqual([
      { fileId: '1', path: undefined, newName: 'new-a.txt' },
      { fileId: '2', path: undefined, newName: 'new-a.txt' },
    ])
  })

  it('rejects illegal file names', () => {
    expect(validateFileName('bad/name.txt')).toContain('名称包含非法字符')
    expect(validateFileName('trailing.')).toContain('名称不能以空格或句点结尾')
  })
})

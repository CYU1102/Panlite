import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  calculateTransferProgress,
  chooseAvailableName,
  normalizeConflictPolicy,
  normalizeRelativePath,
  resolvePathInside,
  sanitizeFileName,
} from './file-transfer'

describe('file transfer path safety', () => {
  it('sanitizes Windows-invalid and reserved cloud names', () => {
    expect(sanitizeFileName('a<b>:c?.txt')).toBe('a_b__c_.txt')
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('..')).toBe('_')
  })

  it('rejects absolute and traversal relative paths', () => {
    expect(() => normalizeRelativePath('../secret.txt')).toThrow()
    expect(() => normalizeRelativePath('C:\\secret.txt')).toThrow()
    expect(() => normalizeRelativePath('/secret.txt')).toThrow()
  })

  it('resolves safe descendants below the selected directory', () => {
    const root = path.resolve('downloads')
    expect(resolvePathInside(root, 'folder/file.txt')).toBe(path.join(root, 'folder', 'file.txt'))
  })
})

describe('file transfer conflicts and progress', () => {
  it('generates an available file name without losing its extension', () => {
    const taken = new Set(['report.txt', 'report (1).txt'])
    expect(chooseAvailableName('report.txt', false, (name) => taken.has(name))).toBe('report (2).txt')
  })

  it('maps the legacy overwrite flag to an explicit policy', () => {
    expect(normalizeConflictPolicy(undefined, true)).toBe('overwrite')
    expect(normalizeConflictPolicy(undefined, false)).toBe('rename')
    expect(normalizeConflictPolicy('skip', true)).toBe('skip')
  })

  it('reports finite progress for zero-byte transfers', () => {
    expect(calculateTransferProgress({ completedBytes: 0, currentLoaded: 0, totalBytes: 0, completedFiles: 1, currentPercent: 50, totalFiles: 4 })).toBe(38)
  })
})

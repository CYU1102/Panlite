import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ArchiveFileInfo } from '../shared/types'

export const ARCHIVE_LIMITS = {
  maxEntries: 10_000,
  maxSingleFileBytes: 8 * 1024 ** 3,
  maxTotalBytes: 20 * 1024 ** 3,
  maxCompressionRatio: 500,
} as const

export function normalizeArchiveEntryPath(entryPath: string): string {
  if (!entryPath || entryPath.includes('\0')) throw new Error('压缩包包含无效文件名')

  const normalized = entryPath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`压缩包包含绝对路径: ${entryPath}`)
  }

  const parts = normalized.split('/').filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) {
    throw new Error(`压缩包包含目录穿越路径: ${entryPath}`)
  }
  if (parts.length === 0) throw new Error(`压缩包包含无效路径: ${entryPath}`)
  return parts.join('/')
}

export function resolveArchiveEntryPath(outputDir: string, entryPath: string): string {
  const root = resolve(outputDir)
  const target = resolve(root, ...normalizeArchiveEntryPath(entryPath).split('/'))
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`压缩包条目超出目标目录: ${entryPath}`)
  }
  return target
}

export function assertArchiveLimits(files: ArchiveFileInfo[]): void {
  if (files.length > ARCHIVE_LIMITS.maxEntries) {
    throw new Error(`压缩包文件数量超过限制 (${ARCHIVE_LIMITS.maxEntries})`)
  }

  let totalBytes = 0
  for (const file of files) {
    normalizeArchiveEntryPath(file.path)
    if (file.isDir) continue
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`压缩包条目大小无效: ${file.path}`)
    }
    if (file.size > ARCHIVE_LIMITS.maxSingleFileBytes) {
      throw new Error(`压缩包单个文件超过 8 GiB 限制: ${file.path}`)
    }

    totalBytes += file.size
    if (totalBytes > ARCHIVE_LIMITS.maxTotalBytes) {
      throw new Error('压缩包解压后总大小超过 20 GiB 限制')
    }

    if (file.compressedSize && file.compressedSize > 0 && file.size / file.compressedSize > ARCHIVE_LIMITS.maxCompressionRatio) {
      throw new Error(`压缩比异常，疑似压缩炸弹: ${file.path}`)
    }
  }
}

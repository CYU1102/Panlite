import type { FileConflictPolicy, Platform } from './types'

export type CloudTransferMode = 'native_copy' | 'shared_transfer' | 'staged_transfer'

export interface CloudTransferModeOptions {
  sameAccount: boolean
  samePlatform: boolean
  conflictPolicy: FileConflictPolicy
  canNativeCopy: boolean
  canSharedTransfer: boolean
}

export function selectCloudTransferMode(options: CloudTransferModeOptions): CloudTransferMode {
  if (options.conflictPolicy !== 'rename' && options.sameAccount && options.canNativeCopy) {
    return 'native_copy'
  }
  if (options.samePlatform && options.canSharedTransfer) {
    return 'shared_transfer'
  }
  return 'staged_transfer'
}

export function isTargetInsideSelectedDirectory(
  files: ReadonlyArray<{ fileId: string; isDir: boolean }>,
  targetAncestorIds: readonly string[],
): boolean {
  const ancestorIds = new Set(targetAncestorIds)
  return files.some((file) => file.isDir && ancestorIds.has(file.fileId))
}

export interface SourceContentHash {
  algorithm: 'md5' | 'sha1'
  value: string
}

/**
 * 从平台原始元数据中提取可校验的内容哈希：
 * - 123云盘列表返回 etag（内容 md5）
 * - 阿里云盘列表返回 content_hash（sha1）
 */
export function extractSourceHash(platform: Platform, raw: unknown): SourceContentHash | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const etag = typeof record.etag === 'string' ? record.etag.trim() : ''
  const contentHash = typeof record.content_hash === 'string' ? record.content_hash.trim() : ''
  if (platform === 'pan123' && /^[0-9a-f]{32}$/i.test(etag)) return { algorithm: 'md5', value: etag }
  if (platform === 'aliyun' && /^[0-9a-f]{40}$/i.test(contentHash)) return { algorithm: 'sha1', value: contentHash }
  return undefined
}

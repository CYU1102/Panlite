import type { FileConflictPolicy } from './types'

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

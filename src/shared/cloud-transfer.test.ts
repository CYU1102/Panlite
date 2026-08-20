import { describe, expect, it } from 'vitest'
import { isTargetInsideSelectedDirectory, selectCloudTransferMode } from './cloud-transfer'

describe('cloud transfer mode selection', () => {
  it('uses native copy inside one account when supported', () => {
    expect(selectCloudTransferMode({
      sameAccount: true,
      samePlatform: true,
      conflictPolicy: 'skip',
      canNativeCopy: true,
      canSharedTransfer: true,
    })).toBe('native_copy')
  })

  it('uses shared transfer between accounts on one platform', () => {
    expect(selectCloudTransferMode({
      sameAccount: false,
      samePlatform: true,
      conflictPolicy: 'overwrite',
      canNativeCopy: false,
      canSharedTransfer: true,
    })).toBe('shared_transfer')
  })

  it('uses shared transfer for rename conflicts when the target can rename', () => {
    expect(selectCloudTransferMode({
      sameAccount: false,
      samePlatform: true,
      conflictPolicy: 'rename',
      canNativeCopy: false,
      canSharedTransfer: true,
    })).toBe('shared_transfer')
  })

  it('uses staged transfer for rename conflicts without cloud sharing', () => {
    expect(selectCloudTransferMode({
      sameAccount: false,
      samePlatform: true,
      conflictPolicy: 'rename',
      canNativeCopy: false,
      canSharedTransfer: false,
    })).toBe('staged_transfer')
  })

  it('uses staged transfer across platforms', () => {
    expect(selectCloudTransferMode({
      sameAccount: false,
      samePlatform: false,
      conflictPolicy: 'skip',
      canNativeCopy: false,
      canSharedTransfer: false,
    })).toBe('staged_transfer')
  })

  it('detects targets inside selected source directories', () => {
    expect(isTargetInsideSelectedDirectory(
      [{ fileId: 'folder-a', isDir: true }, { fileId: 'file-b', isDir: false }],
      ['root', 'folder-a', 'child'],
    )).toBe(true)
    expect(isTargetInsideSelectedDirectory(
      [{ fileId: 'file-b', isDir: false }],
      ['root', 'file-b'],
    )).toBe(false)
  })
})

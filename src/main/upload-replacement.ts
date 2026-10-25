import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem, UploadOptions, UploadResult } from '../shared/types'

const locks = new Map<string, Promise<void>>()

/** Serialize local tasks replacing the same remote name; a waiting attempt must recheck ownership. */
export async function withUploadReplacementLock<T>(key: string, execute: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  locks.set(key, current)
  await previous
  try { return await execute() } finally { release(); if (locks.get(key) === current) locks.delete(key) }
}

interface ReplacementOptions {
  adapter: DriveAdapter
  account: DriveAccount
  localPath: string
  parentId: string
  existing: FileItem
  expectedSize: number
  uploadOptions: UploadOptions
  assertActive(): void
  onPreserved(backupName: string, temporaryName: string): void
  onCleanupError(backupName: string): void
  /** Callers with authoritative source hashes can require stronger confirmation before old-byte cleanup. */
  verifyUploaded?(file: FileItem): void | Promise<void>
}

/**
 * Stage first, preserve the original by rename, publish, then remove the preserved copy.
 * Unknown responses are deliberately not rolled back or replayed: both owned names remain
 * available for inspection, including providers whose IDs are paths changed by rename.
 */
export async function uploadPreservingExisting(options: ReplacementOptions): Promise<UploadResult> {
  const { adapter, account, existing, parentId, assertActive } = options
  if (!adapter.upload || typeof adapter.rename !== 'function') throw new Error('当前网盘不支持安全替换，请选择重命名上传')
  assertActive()
  const stat = fs.lstatSync(options.localPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== options.expectedSize) throw new Error('上传来源已变化，请重新选择文件')
  const temporaryName = `.panlite-upload-${randomUUID()}${path.extname(existing.name).slice(0, 20)}`
  const backupName = `.panlite-preserved-${randomUUID()}${path.extname(existing.name).slice(0, 20)}`
  const listing = async (): Promise<FileItem[]> => {
    assertActive()
    const result = await adapter.listFiles(account, parentId)
    assertActive()
    if (result.hasMore !== false) throw new Error('目标目录未完整列出，无法安全替换')
    return result.files
  }
  const named = (files: FileItem[], name: string): FileItem | undefined => {
    const matches = files.filter(file => file.name === name)
    if (matches.length > 1) throw new Error('目标目录存在同名歧义，已停止安全替换')
    return matches[0]
  }
  const unchanged = (actual: FileItem | undefined, expected: FileItem): boolean => Boolean(actual && !actual.isDir
    && actual.id === expected.id && actual.size === expected.size && actual.updatedAt === expected.updatedAt)
  const initial = await listing()
  if (!unchanged(named(initial, existing.name), existing) || named(initial, temporaryName) || named(initial, backupName)) throw new Error('目标文件已变化，请刷新后重试')
  // Record both owned names before dispatch: even a lost upload response may leave a staged file.
  options.onPreserved(backupName, temporaryName)
  const uploaded = await adapter.upload(account, options.localPath, parentId, { ...options.uploadOptions, fileName: temporaryName, overwrite: false })
  assertActive()
  if (!uploaded.success) throw new Error(uploaded.error || '临时文件上传失败，原文件未改动')
  const prepared = await listing(), staged = named(prepared, temporaryName)
  if (!staged || staged.isDir || staged.size !== options.expectedSize || (uploaded.fileId && staged.id !== uploaded.fileId)
    || !unchanged(named(prepared, existing.name), existing) || named(prepared, backupName)) throw new Error('临时文件或原文件未通过核对，原文件未改动')
  await options.verifyUploaded?.(staged)
  try {
    assertActive()
    await adapter.rename(account, existing.id, backupName)
    const preserved = await listing(), backup = named(preserved, backupName), ready = named(preserved, temporaryName)
    if (!backup || backup.isDir || backup.size !== existing.size || named(preserved, existing.name) || !unchanged(ready, staged)) throw new Error('原文件重命名结果待核对')
    assertActive()
    await adapter.rename(account, ready!.id, existing.name)
    const published = await listing(), output = named(published, existing.name), retained = named(published, backupName)
    if (!output || output.isDir || output.size !== options.expectedSize || named(published, temporaryName)
      || !unchanged(retained, backup)) throw new Error('替换发布结果待核对')
    await options.verifyUploaded?.(output)
    // A cleanup failure does not invalidate an already confirmed upload. Never retry it blindly.
    try { assertActive(); await adapter.delete(account, [retained!.id]) } catch { options.onCleanupError(backupName) }
    return { ...uploaded, fileId: output.id, fileName: output.name, fileSize: output.size }
  } catch (error) {
    // Cancellation/ownership errors must retain their identity for the task lifecycle.
    assertActive()
    throw new Error(`${error instanceof Error ? error.message : '安全替换未完成'}；原内容保留名：${backupName}，临时上传名：${temporaryName}。请核对后处理，不会自动重发`)
  }
}

import os from 'os'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ArchiveCompressOptions, ArchiveCompressTaskPayload, ArchiveExtractTaskPayload } from '../../shared/types'
import { getAccountById } from '../db'
import { getAdapter } from '../../adapters/registry'
import { createAndEnqueueTask } from '../task-runner'
import { listArchiveFiles, cleanupTempDir } from '../archive'
import { sanitizeFileName } from '../file-transfer'
import type { IpcRegistrar } from './types'
import { dbAccountToDriveAccount } from './account-mapping'

export function registerArchivesIpcHandlers(ipcMain: IpcRegistrar): void {
  // ---- Archive handlers ----

  ipcMain.handle(IPC_CHANNELS.ARCHIVE_LIST, async (_event, accountId: string, fileId: string, fileName: string, password?: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.download) {
        return { success: false, error: `${account.platform} 暂不支持此操作` }
      }

      // 每次使用独立临时目录，避免并发预览覆盖文件。
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-archive-list-'))
      try {
        const result = await adapter.download(account, fileId, tempDir, { fileName: sanitizeFileName(fileName) })
        if (!result.success || !result.localPath) {
          return { success: false, error: result.error || '下载失败' }
        }
        const meta = await listArchiveFiles(result.localPath, password)
        return { success: true, meta }
      } finally {
        cleanupTempDir(tempDir)
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ARCHIVE_EXTRACT, async (_event, accountId: string, fileId: string, fileName: string, options: { password?: string; targetDir: string; files?: string[] }) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.download) {
        return { success: false, error: `${account.platform} 暂不支持此操作` }
      }

      const targetDir = path.resolve(String(options.targetDir || ''))
      if (!targetDir || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return { success: false, error: '解压目标必须是已存在的文件夹' }
      }
      const payload: ArchiveExtractTaskPayload = {
        accountId,
        platform: account.platform,
        fileId,
        fileName: sanitizeFileName(fileName),
        options: { ...options, targetDir },
      }
      const taskId = createAndEnqueueTask(accountId, account.platform, 'archive_extract', `解压 ${fileName}`, payload as unknown as Record<string, unknown>)
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ARCHIVE_COMPRESS, async (_event, accountId: string, fileIds: string[], options: ArchiveCompressOptions) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.download || !adapter.upload) {
        return { success: false, error: `${account.platform} 暂不支持创建压缩包` }
      }
      const format = options.format === 'tar' ? 'tar' : 'zip'
      const archiveName = sanitizeFileName(String(options.archiveName || '').trim())
      if (!archiveName || archiveName === '.' || archiveName === '..') {
        return { success: false, error: '请输入有效的压缩包名称' }
      }
      const uniqueIds = [...new Set((fileIds || []).map(String).filter(Boolean))]
      if (!uniqueIds.length) return { success: false, error: '请先选择文件' }
      const fileList = await adapter.listFiles(account, String(options.targetDir || ''))
      const selectedFiles = uniqueIds.map(id => fileList.files.find(file => file.id === id)).filter(Boolean) as typeof fileList.files
      if (selectedFiles.length !== uniqueIds.length) return { success: false, error: '选中的文件已不存在，请刷新后重试' }
      const archiveFiles: ArchiveCompressTaskPayload['files'] = []
      const visitedDirectories = new Set<string>()
      const maxFiles = 10_000

      const collectEntry = async (entry: typeof selectedFiles[number], relativePath: string): Promise<void> => {
        if (archiveFiles.length >= maxFiles) throw new Error(`一次最多压缩 ${maxFiles} 个文件`)
        if (!entry.isDir) {
          archiveFiles.push({
            fileId: entry.id,
            downloadId: String(entry.raw?.fs_id || entry.id),
            fileName: entry.name,
            fileSize: Math.max(0, Number(entry.size) || 0),
            relativePath,
          })
          return
        }

        if (visitedDirectories.has(entry.id)) return
        visitedDirectories.add(entry.id)
        const children = await adapter.listFiles(account, entry.id)
        for (const child of children.files) {
          await collectEntry(child, path.posix.join(relativePath, sanitizeFileName(child.name)))
        }
      }

      for (const selected of selectedFiles) {
        await collectEntry(selected, sanitizeFileName(selected.name))
      }
      if (!archiveFiles.length) return { success: false, error: '选中的文件夹中没有可压缩的文件' }

      const payload: ArchiveCompressTaskPayload = {
        accountId,
        platform: account.platform,
        targetDirId: String(options.targetDir || ''),
        archiveName,
        format,
        files: archiveFiles,
      }
      const taskId = createAndEnqueueTask(accountId, account.platform, 'archive_compress', `创建压缩包 ${archiveName}`, payload as unknown as Record<string, unknown>)
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

}

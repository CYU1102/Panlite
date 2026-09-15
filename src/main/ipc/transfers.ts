import { dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../../shared/constants'
import { getAccountById, getShareLinkById, listShareLinks, listTransferRecords, updateShareLinkStatus, deleteShareLink, deleteTransferRecord, invalidateFilesCacheParents } from '../db'
import { getAdapter } from '../../adapters/registry'
import { createAndEnqueueTask } from '../task-runner'
import type { UploadFileInfo, UploadParams } from '../../shared/types'
import type { CloudTransferFileInfo, CloudTransferParams, CloudTransferTaskPayload } from '../../shared/types'
import { normalizeConflictPolicy, normalizeRelativePath, sanitizeFileName } from '../file-transfer'
import { isTargetInsideSelectedDirectory, selectCloudTransferMode } from '../../shared/cloud-transfer'
import type { IpcRegistrar } from './types'
import { dbAccountToDriveAccount } from './account-mapping'

const MAX_UPLOAD_FILES = 10_000

function collectUploadFiles(inputPaths: string[]): UploadFileInfo[] {
  const files: UploadFileInfo[] = []
  const seen = new Set<string>()

  const visit = (inputPath: string, relativePath: string): void => {
    if (files.length >= MAX_UPLOAD_FILES) {
      throw new Error(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件`)
    }

    const resolved = path.resolve(inputPath)
    if (seen.has(resolved)) return
    seen.add(resolved)

    const stat = fs.lstatSync(resolved)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(resolved)) {
        visit(path.join(resolved, entry), path.join(relativePath, entry))
      }
      return
    }
    if (!stat.isFile()) return

    files.push({
      localPath: resolved,
      fileName: path.basename(resolved),
      fileSize: stat.size,
      relativePath: normalizeRelativePath(relativePath),
    })
  }

  for (const inputPath of inputPaths) {
    const resolved = path.resolve(inputPath)
    visit(resolved, path.basename(resolved))
  }
  return files
}

function validateUploadFiles(inputFiles: UploadFileInfo[]): UploadFileInfo[] {
  const files: UploadFileInfo[] = []
  const seen = new Set<string>()
  for (const input of inputFiles) {
    const resolved = path.resolve(String(input.localPath || ''))
    const stat = fs.lstatSync(resolved)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('上传来源必须是普通文件')
    const canonical = fs.realpathSync.native(resolved).toLowerCase()
    if (seen.has(canonical)) throw new Error('上传文件列表包含重复文件')
    seen.add(canonical)

    const localName = path.basename(resolved)
    const relativePath = normalizeRelativePath(input.relativePath || input.fileName || localName)
    if (path.basename(relativePath) !== sanitizeFileName(localName)) {
      throw new Error(`上传相对路径与本地文件不匹配: ${localName}`)
    }
    files.push({ localPath: resolved, fileName: localName, fileSize: stat.size, relativePath })
  }
  return files
}

export function registerTransfersIpcHandlers(ipcMain: IpcRegistrar): void {
  ipcMain.handle(IPC_CHANNELS.CLOUD_TRANSFER_CREATE, async (_event, params: CloudTransferParams) => {
    try {
      if (!params || !Array.isArray(params.files) || params.files.length === 0 || params.files.length > MAX_UPLOAD_FILES) {
        return { success: false, error: '迁移文件列表无效' }
      }

      const sourceRow = getAccountById(String(params.sourceAccountId || ''))
      const targetRow = getAccountById(String(params.targetAccountId || ''))
      if (!sourceRow || !targetRow) return { success: false, error: '源账号或目标账号不存在' }
      const sourceAccount = dbAccountToDriveAccount(sourceRow)
      const targetAccount = dbAccountToDriveAccount(targetRow)
      const sourceAdapter = getAdapter(sourceAccount.platform)
      const targetAdapter = getAdapter(targetAccount.platform)
      const conflictPolicy = normalizeConflictPolicy(params.conflictPolicy)
      const mode = selectCloudTransferMode({
        sameAccount: sourceAccount.id === targetAccount.id,
        samePlatform: sourceAccount.platform === targetAccount.platform,
        conflictPolicy,
        canNativeCopy: !!sourceAdapter.copy,
        canSharedTransfer: !!sourceAdapter.createShare && !!targetAdapter.saveSharedFiles,
      })
      if (mode === 'staged_transfer' && (!sourceAdapter.download || !targetAdapter.upload)) {
        return { success: false, error: '源网盘不支持下载或目标网盘不支持上传' }
      }

      const seen = new Set<string>()
      const files: CloudTransferFileInfo[] = []
      for (const rawFile of params.files) {
        const fileId = String(rawFile?.fileId || '').trim()
        const fileName = String(rawFile?.fileName || '').trim()
        if (!fileId || !fileName || fileId.length > 4096 || fileName.length > 500) {
          return { success: false, error: '迁移文件信息无效' }
        }
        if (seen.has(fileId)) continue
        seen.add(fileId)
        files.push({
          fileId,
          fileName,
          fileSize: Math.max(0, Number(rawFile.fileSize) || 0),
          isDir: Boolean(rawFile.isDir),
          path: rawFile.path ? String(rawFile.path) : undefined,
        })
      }
      if (files.length === 0) return { success: false, error: '没有可迁移的文件' }
      const targetAncestorIds = Array.isArray(params.targetAncestorIds)
        ? params.targetAncestorIds.slice(0, 100).map((id) => String(id)).filter(Boolean)
        : []
      if (sourceAccount.id === targetAccount.id && isTargetInsideSelectedDirectory(files, targetAncestorIds)) {
        return { success: false, error: '不能把文件夹迁移到自身或其子目录' }
      }

      const payload: CloudTransferTaskPayload = {
        sourceAccountId: sourceAccount.id,
        sourcePlatform: sourceAccount.platform,
        targetAccountId: targetAccount.id,
        targetPlatform: targetAccount.platform,
        files,
        targetDirId: String(params.targetDirId || '0'),
        targetPath: params.targetPath ? String(params.targetPath) : undefined,
        targetAncestorIds,
        conflictPolicy,
      }
      const title = `迁移 ${files.length} 项：${sourceAccount.nickname} → ${targetAccount.nickname}`
      const taskId = createAndEnqueueTask(
        sourceAccount.id,
        sourceAccount.platform,
        'cloud_transfer',
        title,
        payload as unknown as Record<string, unknown>,
      )
      invalidateFilesCacheParents(targetAccount.id, [payload.targetDirId])
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })



  // ---- Upload handlers ----

  ipcMain.handle(IPC_CHANNELS.UPLOAD_SELECT_FILES, async () => {
    try {
      const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
      if (result.canceled) return { success: true, files: [] }
      return { success: true, files: collectUploadFiles(result.filePaths) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.UPLOAD_SELECT_FOLDER, async () => {
    try {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return { success: true, files: [] }
      const folderPath = result.filePaths[0]
      return {
        success: true,
        files: collectUploadFiles([folderPath]),
        folderName: path.basename(folderPath),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.UPLOAD_HANDLE_DROP, async (_event, filePaths: string[]) => {
    try {
      if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > 1_000) {
        return { success: false, error: '拖拽路径数量无效' }
      }
      return { success: true, files: collectUploadFiles(filePaths) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.UPLOAD_FILES, async (_event, params: UploadParams) => {
    try {
      if (!params || !Array.isArray(params.files) || params.files.length === 0 || params.files.length > MAX_UPLOAD_FILES) {
        return { success: false, error: '上传文件列表无效' }
      }

      const row = getAccountById(params.accountId)
      if (!row) return { success: false, error: '账号不存在' }
      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      if (!adapter.upload) return { success: false, error: `${account.platform} 暂不支持上传功能` }

      const files = validateUploadFiles(params.files)
      const conflictPolicy = normalizeConflictPolicy(params.conflictPolicy, params.overwrite)

      const taskId = createAndEnqueueTask(
        params.accountId,
        account.platform,
        'upload',
        `上传 ${files.length} 个文件`,
        { files, targetDirId: params.targetDirId || '0', overwrite: params.overwrite, conflictPolicy },
      )
      invalidateFilesCacheParents(params.accountId, [params.targetDirId || '0'])
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Download handlers ----

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_SELECT_DIR, async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      })

      if (result.canceled) return { success: false, dirPath: '' }

      return { success: true, dirPath: result.filePaths[0] }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_FILES, async (_event, params: import('../../shared/types').DownloadParams) => {
    try {
      if (!params || !Array.isArray(params.files) || params.files.length === 0 || params.files.length > MAX_UPLOAD_FILES) {
        return { success: false, error: '下载文件列表无效' }
      }
      const targetDirPath = path.resolve(String(params.targetDirPath || ''))
      if (!fs.existsSync(targetDirPath) || !fs.statSync(targetDirPath).isDirectory()) {
        return { success: false, error: '下载目标目录不存在' }
      }
      const row = getAccountById(params.accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.download) {
        return { success: false, error: `${account.platform} 暂不支持下载功能` }
      }

      const title = params.files.length === 1
        ? `下载文件: ${params.files[0].fileName}`
        : `下载 ${params.files.length} 个文件`

      const taskId = createAndEnqueueTask(params.accountId, account.platform, 'download', title, {
        accountId: params.accountId,
        platform: account.platform,
        files: params.files,
        targetDirPath,
        overwrite: params.overwrite,
        conflictPolicy: normalizeConflictPolicy(params.conflictPolicy, params.overwrite),
      })

      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Share handlers ----

  ipcMain.handle(IPC_CHANNELS.SHARE_BATCH_CREATE, async (_event, accountId: string, items: { fileId: string; name?: string; isDir?: boolean; raw?: Record<string, unknown> }[], options?: { expireDays?: number; password?: string; title?: string }) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const title = items.length === 1 ? (items[0].name || '分享文件') : `分享 ${items.length} 个文件`
      const taskId = createAndEnqueueTask(accountId, account.platform, 'share', title, {
        accountId,
        platform: account.platform,
        items,
        options: options || {},
      })
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SHARE_LIST, async (_event, filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }) => {
    try {
      const links = listShareLinks(filters)
      return { success: true, links }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SHARE_DELETE, async (_event, id: string) => {
    try {
      deleteShareLink(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SHARE_CANCEL, async (_event, id: string) => {
    try {
      const link = getShareLinkById(id)
      if (!link) return { success: false, error: '分享记录不存在' }
      if (link.status !== 'active') return { success: false, error: '该分享已经失效' }

      const row = getAccountById(link.account_id)
      if (!row) return { success: false, error: '分享所属账号不存在' }
      const adapter = getAdapter(link.platform)
      if (!adapter.cancelShare) return { success: false, error: `${link.platform} 暂不支持远端取消分享` }

      await adapter.cancelShare(dbAccountToDriveAccount(row), link.id)
      updateShareLinkStatus(id, 'cancelled')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SHARE_EXPORT_CSV, async (_event, filters?: { accountId?: string; platform?: string; status?: string }) => {
    try {
      const links = listShareLinks(filters) as (Awaited<ReturnType<typeof listShareLinks>>[number] & { account_nickname?: string })[]
      const { escapeCsvField } = await import('../../shared/utils')
      const header = 'platform,accountNickname,title,shareUrl,password,expiredAt,status,createdAt'
      const rows = links.map((l) =>
        [l.platform, l.account_nickname || '', l.title || '', l.share_url, l.password || '', l.expired_at ? String(l.expired_at) : '', l.status, String(l.created_at)]
          .map(escapeCsvField).join(',')
      )
      const csv = [header, ...rows].join('\n')
      return { success: true, csv }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Transfer handlers ----

  ipcMain.handle(IPC_CHANNELS.TRANSFER_BATCH_CREATE, async (
    _event,
    accountId: string,
    links: { url: string; password?: string }[],
    targetDirId?: string,
    targetPath?: string,
    options?: { autoShare?: boolean; shareOptions?: { expireDays?: number; password?: string } },
  ) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const title = links.length === 1 ? '转存分享链接' : `批量转存 ${links.length} 个链接`
      const taskId = createAndEnqueueTask(accountId, account.platform, 'transfer', title, {
        accountId,
        platform: account.platform,
        links,
        targetDirId: targetDirId || '0',
        targetPath,
        autoShare: options?.autoShare || false,
        shareOptions: options?.shareOptions,
      })
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TRANSFER_LIST, async (_event, filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }) => {
    try {
      const records = listTransferRecords(filters)
      return { success: true, records }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TRANSFER_DELETE, async (_event, id: string) => {
    try {
      deleteTransferRecord(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TRANSFER_EXPORT_CSV, async (_event, filters?: { accountId?: string; platform?: string; status?: string }) => {
    try {
      const records = listTransferRecords(filters) as (Awaited<ReturnType<typeof listTransferRecords>>[number] & { account_nickname?: string })[]
      const { escapeCsvField } = await import('../../shared/utils')
      const header = 'platform,accountNickname,sourceUrl,targetPath,savedCount,status,errorMessage,createdAt,finishedAt'
      const rows = records.map((r) =>
        [r.platform, r.account_nickname || '', r.source_url, r.target_path || '', String(r.saved_count), r.status, r.error_message || '', String(r.created_at), r.finished_at ? String(r.finished_at) : '']
          .map(escapeCsvField).join(',')
      )
      const csv = [header, ...rows].join('\n')
      return { success: true, csv }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Link verification (batch concurrent) ----

  ipcMain.handle(IPC_CHANNELS.LINK_VERIFY, async (_event, accountId: string, links: { url: string; password?: string }[]) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.getShareDetail) {
        return { success: false, error: `${account.platform} 不支持链接检测` }
      }

      // 并发检测（最多 3 个同时进行）
      const MAX_CONCURRENT = 3
      const results: Array<{ url: string; valid: boolean; title?: string; fileCount?: number; error?: string }> = []
      let index = 0

      async function worker() {
        while (index < links.length) {
          const link = links[index++]
          try {
            const detail = await adapter.getShareDetail!(account, link)
            results.push({
              url: link.url,
              valid: true,
              title: detail.title,
              fileCount: detail.files.length,
            })
          } catch (err) {
            results.push({
              url: link.url,
              valid: false,
              error: String(err instanceof Error ? err.message : err),
            })
          }
        }
      }

      const workers = Array.from({ length: Math.min(MAX_CONCURRENT, links.length) }, () => worker())
      await Promise.all(workers)

      return { success: true, results }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

}

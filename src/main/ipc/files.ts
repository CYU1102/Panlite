import { IPC_CHANNELS } from '../../shared/constants'
import type { DriveAccount } from '../../shared/types'
import { getAccountById, replaceFilesCacheSnapshot, getFilesCacheByParent, getFilesCacheLatestTimestamp, invalidateFilesCacheParents, getCachedParentIdsForFiles, getCachedSearchResults, setCachedSearchResults, getSearchHistory, addSearchHistory, clearSearchHistory } from '../db'
import { getAdapter } from '../../adapters/registry'
import { createAndEnqueueTask } from '../task-runner'
import log from 'electron-log'
import { FilePreviewService, registerFilePreviewIpc } from '../file-preview'
import { downloadPreviewSource } from '../preview-download'
import type { IpcRegistrar } from './types'
import { dbAccountToDriveAccount } from './account-mapping'
import { handlePreviewCors } from '../preview-cors'

const filePreviewService = new FilePreviewService()

export function getFilePreviewService(): FilePreviewService { return filePreviewService }

export function cleanupFileIpc(): void {
  filePreviewService.cleanupAll()
}

export function handleFilePreviewRequest(request: Request): Promise<Response> {
  return handlePreviewCors(request, value => filePreviewService.handleRequest(value))
}

// 搜索筛选辅助函数
function applySearchFilters(files: any[], options?: {
  maxSize?: number
  minSize?: number
  fileTypes?: string[]
  dateFrom?: number
  dateTo?: number
}): any[] {
  if (!options) return files

  let filtered = files

  // 按文件大小筛选
  if (options.minSize !== undefined) {
    filtered = filtered.filter(f => f.size >= options.minSize!)
  }
  if (options.maxSize !== undefined) {
    filtered = filtered.filter(f => f.size <= options.maxSize!)
  }

  // 按文件类型筛选
  if (options.fileTypes && options.fileTypes.length > 0) {
    filtered = filtered.filter(f => {
      if (f.isDir) return options.fileTypes!.includes('folder')
      const ext = f.name?.split('.').pop()?.toLowerCase() || ''
      return options.fileTypes!.some(type => {
        if (type === 'video') return ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'].includes(ext)
        if (type === 'audio') return ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'].includes(ext)
        if (type === 'image') return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext)
        if (type === 'document') return ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'].includes(ext)
        if (type === 'archive') return ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)
        return ext === type
      })
    })
  }

  // 按日期筛选
  if (options.dateFrom !== undefined) {
    filtered = filtered.filter(f => f.updatedAt >= options.dateFrom!)
  }
  if (options.dateTo !== undefined) {
    filtered = filtered.filter(f => f.updatedAt <= options.dateTo!)
  }

  return filtered
}

function cachedDirectoryResult(account: DriveAccount, parentId: string, offlineReason?: string) {
  const cacheTime = getFilesCacheLatestTimestamp(account.id, parentId)
  if (cacheTime === null) return null
  const files = getFilesCacheByParent(account.id, parentId).map((file) => ({
    id: file.file_id,
    parentId: file.parent_id || '',
    name: file.filename,
    isDir: file.is_dir === 1,
    size: file.size,
    createdAt: file.created_at || 0,
    updatedAt: file.updated_at || 0,
    platform: account.platform,
    accountId: account.id,
    raw: parseCachedRaw(file.raw_json),
  }))
  return { success: true, files, parentId, hasMore: false, cached: true, cacheTime, offlineReason }
}

function parseCachedRaw(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function registerFilesIpcHandlers(ipcMain: IpcRegistrar): void {
  registerFilePreviewIpc(ipcMain, filePreviewService, async (request, context) => {
    const row = getAccountById(request.accountId)
    if (!row) return { success: false, error: '账号不存在' }
    const account = dbAccountToDriveAccount(row)
    const adapter = getAdapter(account.platform)
    if (adapter.getDownloadSource) {
      try {
        return await downloadPreviewSource(await adapter.getDownloadSource(account, request.fileId), context)
      } catch {
        return { success: false, error: '无法获取预览文件，请检查网络或重新登录账号' }
      }
    }
    if (!adapter.download) return { success: false, error: `${account.platform} 暂不支持下载预览` }
    return adapter.download(account, request.fileId, context.directory, { fileName: context.fileName })
  }, async (request) => {
    const row = getAccountById(request.accountId)
    if (!row) throw new Error('账号不存在')
    const account = dbAccountToDriveAccount(row)
    const adapter = getAdapter(account.platform)
    if (!adapter.getDownloadSource) return undefined
    try {
      return await adapter.getDownloadSource(account, request.fileId)
    } catch {
      throw new Error('无法获取在线预览地址，请检查网络或重新登录账号')
    }
  })

  // ---- File handlers (unified via adapter registry) ----

  ipcMain.handle(IPC_CHANNELS.FILE_LIST, async (_event, accountId: string, parentId: string, useCache?: boolean) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)

      // Explicit cache mode is useful for instant navigation and works for an
      // empty directory because snapshots have their own metadata row.
      if (useCache) {
        const cached = cachedDirectoryResult(account, parentId)
        if (cached) return cached
      }

      try {
        const adapter = getAdapter(account.platform)
        const result = await adapter.listFiles(account, parentId)

        // Replace the complete parent snapshot. This removes entries that were
        // deleted remotely and avoids merging stale pages with fresh results.
        const ts = Date.now()
        const cacheFiles = result.files.map((f) => ({
          id: `${accountId}_${f.id}`,
          account_id: accountId,
          platform: account.platform,
          file_id: f.id,
          parent_id: parentId,
          filename: f.name,
          is_dir: f.isDir ? 1 : 0,
          size: f.size,
          created_at: f.createdAt,
          updated_at: f.updatedAt,
          raw_json: f.raw ? JSON.stringify(f.raw) : null,
        }))
        try {
          replaceFilesCacheSnapshot(accountId, parentId, cacheFiles, ts)
        } catch (cacheErr) {
          log.warn('Failed to replace file cache snapshot:', String(cacheErr))
        }

        return { success: true, ...result, cached: false }
      } catch (onlineErr) {
        const reason = onlineErr instanceof Error ? onlineErr.message : String(onlineErr)
        const cached = cachedDirectoryResult(account, parentId, reason)
        if (cached) {
          log.warn(`File list failed for ${accountId}/${parentId}; using offline cache:`, reason)
          return cached
        }
        throw onlineErr
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, async (_event, accountId: string, keyword: string, options?: {
    maxSize?: number
    minSize?: number
    fileTypes?: string[]
    dateFrom?: number
    dateTo?: number
    useCache?: boolean
  }) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      // 检查缓存
      const useCache = options?.useCache !== false
      if (useCache) {
        const cached = getCachedSearchResults(accountId, keyword)
        if (cached) {
          let files = JSON.parse(cached)
          files = applySearchFilters(files, options)
          addSearchHistory(accountId, keyword, files.length)
          return { success: true, files, keyword, hasMore: false, fromCache: true }
        }
      }

      // 调用适配器搜索
      let files = await adapter.searchFiles(account, keyword)

      // 保存到缓存
      setCachedSearchResults(accountId, keyword, JSON.stringify(files))
      addSearchHistory(accountId, keyword, files.length)

      // 应用筛选条件
      files = applySearchFilters(files, options)

      return { success: true, files, keyword, hasMore: false, fromCache: false }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // 搜索历史
  ipcMain.handle(IPC_CHANNELS.SEARCH_HISTORY, async (_event, accountId: string) => {
    try {
      const history = getSearchHistory(accountId, 10)
      return { success: true, history }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_CLEAR_HISTORY, async (_event, accountId: string) => {
    try {
      clearSearchHistory(accountId)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_MKDIR, async (_event, accountId: string, parentId: string, name: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      const folder = await adapter.mkdir(account, parentId, name)
      invalidateFilesCacheParents(accountId, [parentId])
      return { success: true, file: folder }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_RENAME, async (_event, accountId: string, fileId: string, newName: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      const sourceParents = getCachedParentIdsForFiles(accountId, [fileId])
      await adapter.rename(account, fileId, newName)
      invalidateFilesCacheParents(accountId, sourceParents)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_MOVE, async (_event, accountId: string, fileIds: string[], targetDirId: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      const sourceParents = getCachedParentIdsForFiles(accountId, fileIds)
      await adapter.move(account, fileIds, targetDirId)
      invalidateFilesCacheParents(accountId, [...sourceParents, targetDirId])
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, async (_event, accountId: string, fileIds: string[]) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      const sourceParents = getCachedParentIdsForFiles(accountId, fileIds)
      await adapter.delete(account, fileIds)
      invalidateFilesCacheParents(accountId, sourceParents)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })


  // ---- Batch operations (create tasks) ----

  ipcMain.handle(IPC_CHANNELS.BATCH_RENAME, async (_event, accountId: string, items: { fileId: string; path?: string; newName: string }[]) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      invalidateFilesCacheParents(accountId, getCachedParentIdsForFiles(accountId, items.map((item) => item.fileId)))
      const title = `批量重命名 ${items.length} 个文件`
      const taskId = createAndEnqueueTask(accountId, account.platform, 'rename', title, { items })
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.BATCH_MOVE, async (_event, accountId: string, items: { fileId: string; path?: string }[], targetDirId: string, targetPath?: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const sourceParents = getCachedParentIdsForFiles(accountId, items.map((item) => item.fileId))
      invalidateFilesCacheParents(accountId, [...sourceParents, targetDirId])
      const title = `批量移动 ${items.length} 个文件`
      const taskId = createAndEnqueueTask(accountId, account.platform, 'move', title, { items, targetDirId, targetPath })
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- File preview and copy ----

  ipcMain.handle(IPC_CHANNELS.FILE_GET_LINK, async (_event, accountId: string, fileId: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.getDownloadUrl) {
        return { success: false, error: `${account.platform} 暂不支持获取链接` }
      }

      const url = await adapter.getDownloadUrl(account, fileId)
      return { success: true, url }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_COPY, async (_event, accountId: string, fileIds: string[], targetDirId: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.copy) {
        return { success: false, error: `${account.platform} 暂不支持复制功能` }
      }

      await adapter.copy(account, fileIds, targetDirId)
      invalidateFilesCacheParents(accountId, [targetDirId])
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.BATCH_DELETE, async (_event, accountId: string, items: { fileId: string; path?: string }[]) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      invalidateFilesCacheParents(accountId, getCachedParentIdsForFiles(accountId, items.map((item) => item.fileId)))
      const title = `批量删除 ${items.length} 个文件`
      const taskId = createAndEnqueueTask(accountId, account.platform, 'delete', title, { items })
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })


  // ---- Export ----

  ipcMain.handle(IPC_CHANNELS.EXPORT_CSV, async (_event, accountId: string, parentId: string) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: 'Account not found' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      const result = await adapter.listFiles(account, parentId)

      const { escapeCsvField } = await import('../../shared/utils')
      const header = 'name,path,size,isDir,createdAt,updatedAt,platform,accountId'
      const rows = result.files.map((f) =>
        [f.name, f.path || '', String(f.size), f.isDir ? '1' : '0', String(f.createdAt), String(f.updatedAt), account.platform, accountId]
          .map(escapeCsvField).join(',')
      )
      const csv = [header, ...rows].join('\n')
      return { success: true, csv }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

}

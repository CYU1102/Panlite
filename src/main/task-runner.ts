import PQueue from 'p-queue'
import { BrowserWindow } from 'electron'
import type { DriveAccount, ShareTaskPayload, TransferTaskPayload, ShareTaskPayload as SharePayloadType, UploadTaskPayload, DownloadTaskPayload } from '../shared/types'
import { IPC_CHANNELS, CONCURRENCY, MAX_RETRY_COUNT, TRANSFER_DELAY_MS, SETTINGS_KEYS, DEFAULT_BANNED_KEYWORDS } from '../shared/constants'
import { getAdapter } from '../adapters/registry'
import { isPermanentError, sanitizeError as sanitizeErr } from '../adapters/errors'
import {
  getTaskById,
  getPendingTasks,
  updateTaskStatus,
  updateTaskProgress,
  incrementTaskRetry,
  markTaskSuccess,
  markTaskFailed,
  insertTask,
  insertLog,
  getAccountById,
  insertShareLink,
  insertTransferRecord,
  markTransferRecordSuccess,
  markTransferRecordFailed,
  getSetting,
} from './db'
import { decryptCredential } from './crypto'
import { generateId, now, formatFileSize } from '../shared/utils'
import type { DbTask } from './db'
import log from 'electron-log'

// One queue per platform with configured concurrency
const queues: Map<string, PQueue> = new Map()

function getQueue(platform: string): PQueue {
  if (!queues.has(platform)) {
    const concurrency = CONCURRENCY[platform] || 1
    queues.set(platform, new PQueue({ concurrency }))
  }
  return queues.get(platform)!
}

function dbTaskToAccount(task: DbTask): DriveAccount | null {
  const row = getAccountById(task.account_id)
  if (!row) return null

  let credential: DriveAccount['credential'] = {}
  try {
    credential = JSON.parse(decryptCredential(row.encrypted_credential))
  } catch {
    // credential unavailable
  }

  return {
    id: row.id,
    platform: row.platform as DriveAccount['platform'],
    nickname: row.nickname || '',
    loginType: row.login_type as DriveAccount['loginType'],
    credential,
    userAgent: row.user_agent || undefined,
    status: row.status as DriveAccount['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckAt: row.last_check_at || undefined,
  }
}

function taskLog(level: 'info' | 'warn' | 'error', taskId: string, accountId: string, platform: string, message: string, detail?: string): void {
  insertLog({
    id: generateId(),
    level,
    module: 'task-runner',
    message,
    detail: detail || null,
    created_at: now(),
    account_id: accountId,
    task_id: taskId,
  })
  log.info(`[Task ${taskId}] ${message}`)
}

/** 向渲染进程推送任务进度更新 */
function notifyTaskProgress(taskId: string, progress: number, message?: string): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.TASK_UPDATED, { taskId, progress, message })
      }
    }
  } catch { /* ignore */ }
}

/** Sanitize error message — remove any potential credential leaks. */
function sanitizeError(err: unknown): string {
  let msg = String(err instanceof Error ? err.message : err)
  // Remove anything that looks like a token, cookie, or secret
  msg = msg.replace(/access_token=[^&\s]+/gi, 'access_token=***')
  msg = msg.replace(/refresh_token=[^&\s]+/gi, 'refresh_token=***')
  msg = msg.replace(/client_secret=[^&\s]+/gi, 'client_secret=***')
  msg = msg.replace(/Cookie:[^\n]+/gi, 'Cookie:***')
  msg = msg.replace(/BDUSS=[^;\s]+/gi, 'BDUSS=***')
  msg = msg.replace(/BDCLND=[^;\s]+/gi, 'BDCLND=***')
  // Truncate to reasonable length
  if (msg.length > 500) msg = msg.substring(0, 500) + '...'
  return msg
}

// ── Ad filtering ──

/** 检查文件名是否包含广告关键词 */
function containsAdKeyword(filename: string, keywords: string[]): boolean {
  const lower = filename.toLowerCase()
  return keywords.some((kw) => lower.includes(kw.toLowerCase()))
}

/** 获取已启用的广告关键词列表 */
function getBannedKeywords(): string[] {
  const enabled = getSetting(SETTINGS_KEYS.AD_FILTER_ENABLED)
  // 默认启用
  if (enabled && enabled.value === 'false') return []
  const setting = getSetting(SETTINGS_KEYS.BANNED_KEYWORDS)
  const raw = setting?.value || DEFAULT_BANNED_KEYWORDS
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * 广告文件过滤（参考 xinyue-search QuarkPan/BaiduPan）
 * 转存后扫描文件名，匹配黑名单则删除
 * 返回过滤后的文件 ID 列表，如果全部是广告则返回 null
 */
async function filterAdFiles(
  account: DriveAccount,
  savedFileIds: string[],
  savedFileNames: string[],
  targetDirId: string,
  taskId: string,
  savedFilePaths?: string[],
): Promise<string[] | null> {
  const keywords = getBannedKeywords()
  if (keywords.length === 0 || savedFileIds.length === 0) return savedFileIds

  const adapter = getAdapter(account.platform)
  const adIndices: number[] = []
  const cleanIndices: number[] = []

  // 如果有文件名列表且长度匹配，直接用文件名匹配
  if (savedFileNames.length > 0 && savedFileNames.length === savedFileIds.length) {
    for (let i = 0; i < savedFileNames.length; i++) {
      const name = savedFileNames[i] || ''
      if (containsAdKeyword(name, keywords)) {
        adIndices.push(i)
      } else {
        cleanIndices.push(i)
      }
    }
  } else {
    // 没有文件名列表时，尝试列出目标目录获取文件名
    try {
      const dirId = targetDirId === '0' ? '/' : targetDirId
      const listResult = await adapter.listFiles(account, dirId)
      for (let i = 0; i < listResult.files.length; i++) {
        const f = listResult.files[i]
        if (containsAdKeyword(f.name, keywords)) {
          adIndices.push(i)
        } else {
          cleanIndices.push(i)
        }
      }
      // 更新 savedFileIds 为目录内的文件 ID
      savedFileIds = listResult.files.map((f) => f.id)
    } catch {
      // 列出文件失败，跳过广告过滤
      return savedFileIds
    }
  }

  if (adIndices.length === 0) {
    return savedFileIds // 没有广告文件
  }

  // 构建要删除的文件 ID 列表
  // 百度需要用文件路径删除，夸克用 fid 删除
  const adFileIdsToDelete = adIndices.map((i) => {
    if (savedFilePaths && savedFilePaths[i]) return savedFilePaths[i]
    return savedFileIds[i]
  })

  // 尝试删除广告文件
  try {
    await adapter.delete(account, adFileIdsToDelete)
    taskLog('info', taskId, account.id, account.platform,
      `广告过滤: 删除了 ${adIndices.length} 个广告文件`)
  } catch (err) {
    taskLog('warn', taskId, account.id, account.platform,
      `广告过滤: 删除广告文件失败 — ${sanitizeError(err)}`)
    // 删除失败不阻断流程，返回原始列表
    return savedFileIds
  }

  // 如果所有文件都是广告
  if (cleanIndices.length === 0) {
    taskLog('warn', taskId, account.id, account.platform,
      `广告过滤: 所有文件都包含广告关键词，已全部删除`)
    return null
  }

  // 返回过滤后的文件 ID 列表
  return cleanIndices.map((i) => savedFileIds[i])
}

// ── Auto-share after transfer ──

/** 转存后自动分享（参考 xinyue-search 转存→分享一体化流程） */
async function autoShareAfterTransfer(
  account: DriveAccount,
  taskId: string,
  taskAccountId: string,
  fileIds: string[],
  shareOptions?: ShareTaskPayload['options'],
  savedFilePaths?: string[],
  targetDirId?: string,
): Promise<void> {
  const adapter = getAdapter(account.platform)
  if (!adapter.createShare) {
    taskLog('warn', taskId, taskAccountId, account.platform,
      '自动分享: 当前平台不支持分享功能')
    return
  }

  // 百度转存后需要获取用户网盘中的新 fs_id（原始 fs_id 是分享者的，不能用于分享）
  let shareFileIds = fileIds
  if (account.platform === 'baidu' && savedFilePaths && savedFilePaths.length > 0) {
    // 通过列出目标目录获取转存后的文件 fs_id
    try {
      const listDir = targetDirId && targetDirId !== '0' ? targetDirId : '/'
      const dirList = await adapter.listFiles(account, listDir)
      const pathSet = new Set(savedFilePaths)
      const matchedFiles = dirList.files.filter((f) => pathSet.has(f.path || f.id))
      if (matchedFiles.length > 0) {
        shareFileIds = matchedFiles.map((f) => {
          const rawFsId = f.raw?.fs_id
          return rawFsId != null ? String(rawFsId) : f.id
        })
        taskLog('info', taskId, taskAccountId, account.platform,
          `自动分享: 通过目录列表匹配到 ${matchedFiles.length} 个文件的 fs_id`)
      } else {
        taskLog('warn', taskId, taskAccountId, account.platform,
          '自动分享: 无法匹配转存后的文件 fs_id，将使用原始 fs_id')
      }
    } catch (err) {
      taskLog('warn', taskId, taskAccountId, account.platform,
        `自动分享: 获取转存后 fs_id 失败 — ${sanitizeError(err)}，将使用原始 fs_id`)
    }
  }

  // 构建分享项目列表
  const items = shareFileIds.map((fid) => ({
    fileId: fid,
    name: '',
    raw: account.platform === 'baidu' ? { fs_id: fid } : undefined,
  }))

  const options = shareOptions || { expireDays: 0 } // 默认永久

  try {
    taskLog('info', taskId, taskAccountId, account.platform,
      `自动分享: 开始分享 ${shareFileIds.length} 个文件`)

    const shareInfo = await adapter.createShare(account, items, options)

    // 保存分享链接到数据库
    insertShareLink({
      id: shareInfo.id,
      account_id: taskAccountId,
      platform: account.platform,
      share_url: shareInfo.shareUrl,
      password: shareInfo.password || null,
      title: shareInfo.title || null,
      file_ids: JSON.stringify(shareInfo.fileIds),
      expired_at: shareInfo.expiredAt || null,
      status: 'active',
      created_at: now(),
      updated_at: now(),
    })

    taskLog('info', taskId, taskAccountId, account.platform,
      `自动分享成功: ${shareInfo.shareUrl}${shareInfo.password ? ` (密码: ${shareInfo.password})` : ''}`)
  } catch (err) {
    taskLog('error', taskId, taskAccountId, account.platform,
      `自动分享失败: ${sanitizeError(err)}`)
    // 分享失败不阻断转存流程
  }
}

// ── Task execution ──

async function runRenameTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')

  const adapter = getAdapter(task.platform)
  const payload = JSON.parse(task.payload) as {
    items: { fileId: string; path?: string; newName: string }[]
  }

  const total = payload.items.length
  let completed = 0

  for (const item of payload.items) {
    const identifier = item.path || item.fileId
    taskLog('info', task.id, task.account_id, task.platform, `Renaming: ${identifier} → ${item.newName}`)
    await adapter.rename(account, identifier, item.newName)
    completed++
    updateTaskProgress(task.id, Math.round((completed / total) * 100))
  }
}

async function runMoveTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')

  const adapter = getAdapter(task.platform)
  const payload = JSON.parse(task.payload) as {
    items: { fileId: string; path?: string }[]
    targetDirId: string
    targetPath?: string
  }

  const identifiers = payload.items.map((item) => item.path || item.fileId)
  taskLog('info', task.id, task.account_id, task.platform, `Moving ${identifiers.length} items to ${payload.targetPath || payload.targetDirId}`)
  await adapter.move(account, identifiers, payload.targetDirId)
  updateTaskProgress(task.id, 100)
}

async function runDeleteTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')

  const adapter = getAdapter(task.platform)
  const payload = JSON.parse(task.payload) as {
    items: { fileId: string; path?: string }[]
  }

  const identifiers = payload.items.map((item) => item.path || item.fileId)
  taskLog('info', task.id, task.account_id, task.platform, `Deleting ${identifiers.length} items`)
  await adapter.delete(account, identifiers)
  updateTaskProgress(task.id, 100)
}

async function runShareTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')

  const adapter = getAdapter(task.platform)
  if (!adapter.createShare) {
    throw new Error(`${task.platform} 不支持分享功能`)
  }

  const payload = JSON.parse(task.payload) as ShareTaskPayload
  const total = payload.items.length
  let completed = 0

  taskLog('info', task.id, task.account_id, task.platform, `开始分享 ${total} 个文件`)

  // 百度每次只能分享一个文件，需要逐个分享
  // 其他平台（夸克、UC等）支持一次分享多个文件
  const needsPerItemShare = task.platform === 'baidu'

  if (needsPerItemShare) {
    // 逐个文件分享（参考 BaiduPanFilesTransfers 每个文件调用一次 create_share）
    for (const item of payload.items) {
      try {
        const shareInfo = await adapter.createShare(account, [item], payload.options)

        // Save share link to DB
        try {
          insertShareLink({
            id: shareInfo.id,
            account_id: task.account_id,
            platform: task.platform,
            share_url: shareInfo.shareUrl,
            password: shareInfo.password || null,
            title: shareInfo.title || null,
            file_ids: JSON.stringify(shareInfo.fileIds),
            expired_at: shareInfo.expiredAt || null,
            status: 'active',
            created_at: now(),
            updated_at: now(),
          })
        } catch (dbErr) {
          taskLog('error', task.id, task.account_id, task.platform, `保存分享记录失败: ${String(dbErr)}`)
        }

        completed++
        updateTaskProgress(task.id, Math.round((completed / total) * 100))
        taskLog('info', task.id, task.account_id, task.platform,
          `分享成功 (${completed}/${total}): ${shareInfo.shareUrl}${shareInfo.password ? ` (密码: ${shareInfo.password})` : ''}`)

        // 每次分享之间添加延迟，避免请求过于频繁
        if (completed < total) {
          await new Promise((r) => setTimeout(r, 500))
        }
      } catch (err) {
        taskLog('error', task.id, task.account_id, task.platform,
          `分享失败: ${item.name || item.fileId} — ${sanitizeError(err)}`)
        completed++
        updateTaskProgress(task.id, Math.round((completed / total) * 100))
      }
    }
  } else {
    // 一次性分享所有文件（夸克、UC等支持多文件分享）
    const shareInfo = await adapter.createShare(account, payload.items, payload.options)

    // Save share link to DB
    try {
      insertShareLink({
        id: shareInfo.id,
        account_id: task.account_id,
        platform: task.platform,
        share_url: shareInfo.shareUrl,
        password: shareInfo.password || null,
        title: shareInfo.title || null,
        file_ids: JSON.stringify(shareInfo.fileIds),
        expired_at: shareInfo.expiredAt || null,
        status: 'active',
        created_at: now(),
        updated_at: now(),
      })
      taskLog('info', task.id, task.account_id, task.platform, `分享记录已保存`)
    } catch (dbErr) {
      taskLog('error', task.id, task.account_id, task.platform, `保存分享记录失败: ${String(dbErr)}`)
    }

    completed = total
    updateTaskProgress(task.id, Math.round((completed / total) * 100))
    taskLog('info', task.id, task.account_id, task.platform,
      `分享成功: ${shareInfo.shareUrl}${shareInfo.password ? ` (密码: ${shareInfo.password})` : ''}`)
  }
}

async function runTransferTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')

  const adapter = getAdapter(task.platform)
  if (!adapter.saveSharedFiles) {
    throw new Error(`${task.platform} 不支持转存功能`)
  }

  const payload = JSON.parse(task.payload) as TransferTaskPayload
  const total = payload.links.length
  let completed = 0

  taskLog('info', task.id, task.account_id, task.platform, `开始转存 ${total} 个分享链接`)

  let failedCount = 0
  let lastError: unknown = null

  for (const link of payload.links) {
    const recordId = generateId()
    const ts = now()

    // Insert transfer record as pending
    insertTransferRecord({
      id: recordId,
      account_id: task.account_id,
      platform: task.platform,
      source_url: link.url,
      password: link.password || null,
      target_dir_id: payload.targetDirId || null,
      target_path: payload.targetPath || null,
      saved_count: 0,
      status: 'running',
      error_message: null,
      created_at: ts,
      updated_at: ts,
      finished_at: null,
    })

    try {
      taskLog('info', task.id, task.account_id, task.platform, `转存: ${link.url}`)
      const result = await adapter.saveSharedFiles(account, link, payload.targetDirId || '0')

      // ── 广告过滤（参考 xinyue-search 转存后扫描删除广告文件） ──
      let finalFileIds = result.savedFileIds || []
      if (result.savedFileIds && result.savedFileIds.length > 0) {
        const filtered = await filterAdFiles(
          account, result.savedFileIds, result.savedFileNames || [],
          payload.targetDirId || '0', task.id, result.savedFilePaths,
        )
        if (filtered === null) {
          // 所有文件都是广告，标记转存失败
          markTransferRecordFailed(recordId, '所有文件都包含广告关键词，已全部删除')
          failedCount++
          continue
        }
        finalFileIds = filtered
      }

      markTransferRecordSuccess(recordId, result.savedCount || 0)
      completed++
      const progress = Math.round((completed / total) * 100)
      updateTaskProgress(task.id, progress)
      notifyTaskProgress(task.id, progress, `转存成功: ${completed}/${total}`)
      taskLog('info', task.id, task.account_id, task.platform, `转存成功: ${link.url} (${result.savedCount || 0} 个文件)`)

      // ── 转存后自动分享（参考 xinyue-search 转存→分享一体化流程） ──
      if (payload.autoShare && finalFileIds.length > 0) {
        await autoShareAfterTransfer(account, task.id, task.account_id, finalFileIds, payload.shareOptions, result.savedFilePaths, payload.targetDirId)
      }
    } catch (err) {
      const errorMsg = sanitizeError(err)
      markTransferRecordFailed(recordId, errorMsg)
      taskLog('error', task.id, task.account_id, task.platform, `转存失败: ${link.url} — ${errorMsg}`)
      failedCount++
      lastError = err
      // Continue processing remaining links — don't abort the batch
    }

    // 每个链接之间添加延迟，避免请求过于频繁（参考 BaiduPanFilesTransfers DELAY_SECONDS）
    if (completed + failedCount < total) {
      await new Promise((r) => setTimeout(r, TRANSFER_DELAY_MS))
    }
  }

  // After processing all links
  if (failedCount > 0 && completed === 0) {
    // All links failed — throw to trigger retry or permanent failure
    throw lastError || new Error(`全部 ${failedCount} 个链接转存失败`)
  }
  if (failedCount > 0) {
    taskLog('warn', task.id, task.account_id, task.platform, `批量转存部分完成: ${completed} 成功, ${failedCount} 失败`)
  }
}

// ── Upload task ──

async function runUploadTask(task: DbTask): Promise<void> {
  const payload: UploadTaskPayload = JSON.parse(task.payload)
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('账号不存在')

  const adapter = getAdapter(task.platform)
  if (!adapter.upload) {
    throw new Error(`${task.platform} 暂不支持上传功能`)
  }

  const totalFiles = payload.files.length
  const totalSize = payload.files.reduce((sum, f) => sum + f.fileSize, 0)
  let completedFiles = 0
  let completedSize = 0
  let failedCount = 0
  let lastError: Error | null = null

  taskLog('info', task.id, task.account_id, task.platform, `开始上传 ${totalFiles} 个文件，总大小: ${formatFileSize(totalSize)}`)

  for (const file of payload.files) {
    try {
      taskLog('info', task.id, task.account_id, task.platform, `正在上传: ${file.fileName} (${formatFileSize(file.fileSize)})`)

      const result = await adapter.upload(account, file.localPath, payload.targetDirId, {
        fileName: file.fileName,
        overwrite: payload.overwrite,
        onProgress: (progress) => {
          // 计算总体进度
          const currentFileProgress = progress.loaded / file.fileSize
          const totalProgress = Math.round(((completedSize + file.fileSize * currentFileProgress) / totalSize) * 100)

          updateTaskProgress(task.id, totalProgress)
          notifyTaskProgress(task.id, totalProgress, `正在上传: ${file.fileName} (${progress.percent}%)`)
        },
      })

      if (result.success) {
        completedFiles++
        completedSize += file.fileSize
        taskLog('info', task.id, task.account_id, task.platform, `上传成功: ${file.fileName} -> ${result.fileId || 'unknown'}`)
      } else {
        failedCount++
        lastError = new Error(result.error || '上传失败')
        taskLog('error', task.id, task.account_id, task.platform, `上传失败: ${file.fileName} - ${result.error}`)
      }
    } catch (err) {
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      taskLog('error', task.id, task.account_id, task.platform, `上传异常: ${file.fileName} - ${sanitizeError(err)}`)
      // 继续处理其他文件，不中断
    }
  }

  // 更新最终进度
  updateTaskProgress(task.id, 100)
  notifyTaskProgress(task.id, 100, `上传完成: ${completedFiles}/${totalFiles} 个文件`)

  if (failedCount > 0 && completedFiles === 0) {
    // 全部失败
    throw lastError || new Error(`全部 ${failedCount} 个文件上传失败`)
  }

  if (failedCount > 0) {
    taskLog('warn', task.id, task.account_id, task.platform, `批量上传部分完成: ${completedFiles} 成功, ${failedCount} 失败`)
  }

  taskLog('info', task.id, task.account_id, task.platform, `上传任务完成: ${completedFiles}/${totalFiles} 个文件`)
}

// ── Download task ──

async function runDownloadTask(task: DbTask): Promise<void> {
  const payload: DownloadTaskPayload = JSON.parse(task.payload)
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('账号不存在')

  const adapter = getAdapter(task.platform)
  if (!adapter.download) {
    throw new Error(`${task.platform} 暂不支持下载功能`)
  }

  const totalFiles = payload.files.length
  const totalSize = payload.files.reduce((sum, f) => sum + f.fileSize, 0)
  let completedFiles = 0
  let completedSize = 0
  let failedCount = 0
  let lastError: Error | null = null

  taskLog('info', task.id, task.account_id, task.platform, `开始下载 ${totalFiles} 个文件，总大小: ${formatFileSize(totalSize)}`)

  for (const file of payload.files) {
    try {
      taskLog('info', task.id, task.account_id, task.platform, `正在下载: ${file.fileName} (${formatFileSize(file.fileSize)})`)

      const result = await adapter.download(account, file.fileId, payload.targetDirPath, {
        fileName: file.fileName,
        onProgress: (progress) => {
          // 计算总体进度
          const currentFileProgress = progress.loaded / file.fileSize
          const totalProgress = Math.round(((completedSize + file.fileSize * currentFileProgress) / totalSize) * 100)

          updateTaskProgress(task.id, totalProgress)
          notifyTaskProgress(task.id, totalProgress, `正在下载: ${file.fileName} (${progress.percent}%)`)
        },
      })

      if (result.success) {
        completedFiles++
        completedSize += file.fileSize
        taskLog('info', task.id, task.account_id, task.platform, `下载成功: ${file.fileName} -> ${result.localPath || 'unknown'}`)
      } else {
        failedCount++
        lastError = new Error(result.error || '下载失败')
        taskLog('error', task.id, task.account_id, task.platform, `下载失败: ${file.fileName} - ${result.error}`)
      }
    } catch (err) {
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      taskLog('error', task.id, task.account_id, task.platform, `下载异常: ${file.fileName} - ${sanitizeError(err)}`)
      // 继续处理其他文件，不中断
    }
  }

  // 更新最终进度
  updateTaskProgress(task.id, 100)
  notifyTaskProgress(task.id, 100, `下载完成: ${completedFiles}/${totalFiles} 个文件`)

  if (failedCount > 0 && completedFiles === 0) {
    // 全部失败
    throw lastError || new Error(`全部 ${failedCount} 个文件下载失败`)
  }

  if (failedCount > 0) {
    taskLog('warn', task.id, task.account_id, task.platform, `批量下载部分完成: ${completedFiles} 成功, ${failedCount} 失败`)
  }

  taskLog('info', task.id, task.account_id, task.platform, `下载任务完成: ${completedFiles}/${totalFiles} 个文件`)
}

async function runTask(task: DbTask): Promise<void> {
  updateTaskStatus(task.id, 'running')
  taskLog('info', task.id, task.account_id, task.platform, `Task started: ${task.task_type}`)

  try {
    switch (task.task_type) {
      case 'rename':
        await runRenameTask(task)
        break
      case 'move':
        await runMoveTask(task)
        break
      case 'delete':
        await runDeleteTask(task)
        break
      case 'share':
      case 'batch_share':
        await runShareTask(task)
        break
      case 'transfer':
      case 'batch_transfer':
        await runTransferTask(task)
        break
      case 'upload':
        await runUploadTask(task)
        break
      case 'download':
        await runDownloadTask(task)
        break
      default:
        throw new Error(`Unknown task type: ${task.task_type}`)
    }

    markTaskSuccess(task.id)
    taskLog('info', task.id, task.account_id, task.platform, 'Task completed successfully')
  } catch (err) {
    const errorMsg = sanitizeError(err)

    // 永久性错误不重试（登录失效、链接失效、容量不足等）
    if (isPermanentError(err)) {
      markTaskFailed(task.id, errorMsg)
      taskLog('error', task.id, task.account_id, task.platform, `Task failed permanently (non-retryable): ${errorMsg}`)
      return
    }

    if (task.retry_count < MAX_RETRY_COUNT) {
      incrementTaskRetry(task.id)
      updateTaskStatus(task.id, 'pending')
      taskLog('warn', task.id, task.account_id, task.platform, `Task failed, will retry (${task.retry_count + 1}/${MAX_RETRY_COUNT}): ${errorMsg}`)
      // Re-enqueue with delay
      const retryDelay = Math.min(2000 * (task.retry_count + 1), 10000)
      setTimeout(() => enqueueTask(task.id), retryDelay)
    } else {
      markTaskFailed(task.id, errorMsg)
      taskLog('error', task.id, task.account_id, task.platform, `Task failed permanently after ${MAX_RETRY_COUNT} retries: ${errorMsg}`)
    }
  }
}

// ── Public API ──

/** Enqueue a task for execution. */
export function enqueueTask(taskId: string): void {
  const task = getTaskById(taskId)
  if (!task) {
    log.warn('TaskRunner: task not found:', taskId)
    return
  }

  const queue = getQueue(task.platform)
  queue.add(() => runTask(task))
}

/** Create a new task and enqueue it. Returns the task ID. */
export function createAndEnqueueTask(
  accountId: string,
  platform: string,
  taskType: string,
  title: string,
  payload: Record<string, unknown>,
): string {
  const id = generateId()
  const ts = now()

  insertTask({
    id,
    account_id: accountId,
    platform,
    task_type: taskType,
    title,
    payload: JSON.stringify(payload),
    status: 'pending',
    progress: 0,
    retry_count: 0,
    error_message: null,
    created_at: ts,
    updated_at: ts,
    finished_at: null,
  })

  taskLog('info', id, accountId, platform, `Task created: ${taskType} — ${title}`)

  enqueueTask(id)
  return id
}

/** Retry a failed task. */
export function retryTask(taskId: string): boolean {
  const task = getTaskById(taskId)
  if (!task) return false
  if (task.status !== 'failed' && task.status !== 'cancelled') return false

  incrementTaskRetry(taskId)
  updateTaskStatus(taskId, 'pending')
  enqueueTask(taskId)
  taskLog('info', taskId, task.account_id, task.platform, 'Task retry requested')
  return true
}

/** Cancel a task. */
export function cancelTask(taskId: string): boolean {
  const task = getTaskById(taskId)
  if (!task) return false
  if (task.status === 'success') return false

  markTaskFailed(taskId, 'Cancelled by user')
  taskLog('info', taskId, task.account_id, task.platform, 'Task cancelled by user')
  return true
}

/** Get queue status for all platforms. */
export function getQueueStatus(): Record<string, { pending: number; running: number; size: number }> {
  const status: Record<string, { pending: number; running: number; size: number }> = {}
  for (const [platform, queue] of queues) {
    status[platform] = {
      pending: queue.pending,
      running: queue.size,
      size: queue.size + queue.pending,
    }
  }
  return status
}

/** On startup, re-enqueue any pending tasks. */
export function resumePendingTasks(): void {
  const pending = getPendingTasks()
  for (const task of pending) {
    enqueueTask(task.id)
  }
  if (pending.length > 0) {
    log.info(`TaskRunner: re-enqueued ${pending.length} pending tasks`)
  }
}

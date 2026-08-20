import PQueue from 'p-queue'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { DriveAccount, FileItem, ShareTaskPayload, TransferTaskPayload, ShareTaskPayload as SharePayloadType, UploadTaskPayload, DownloadTaskPayload, TransferItemResult, ArchiveExtractTaskPayload, ArchiveCompressTaskPayload, CloudTransferTaskPayload } from '../shared/types'
import { IPC_CHANNELS, CONCURRENCY, MAX_RETRY_COUNT, TRANSFER_DELAY_MS, SETTINGS_KEYS, DEFAULT_BANNED_KEYWORDS } from '../shared/constants'
import { getAdapter } from '../adapters/registry'
import { isPermanentError, sanitizeError as sanitizeErr } from '../adapters/errors'
import {
  getTaskById,
  getPendingTasks,
  updateTaskStatus,
  updateTaskProgress,
  updateTaskPayload,
  incrementTaskRetry,
  markTaskSuccess,
  markTaskFailed,
  markTaskCancelled,
  recoverInterruptedTasks,
  insertTask,
  insertLog,
  getAccountById,
  insertShareLink,
  insertTransferRecord,
  markTransferRecordSuccess,
  markTransferRecordFailed,
  getSetting,
  invalidateFilesCacheParents,
} from './db'
import { decryptCredential } from './crypto'
import { generateId, now, formatFileSize } from '../shared/utils'
import type { DbAccount, DbTask } from './db'
import log from 'electron-log'
import { calculateTransferProgress, chooseAvailableName, normalizeConflictPolicy, normalizeRelativePath, resolvePathInside, sanitizeFileName } from './file-transfer'
import { cleanupTempDir, createArchive, extractArchive } from './archive'
import { isTargetInsideSelectedDirectory, selectCloudTransferMode } from '../shared/cloud-transfer'
import { notifyTaskTerminal } from './runtime-services'

// One queue per platform with configured concurrency
const queues: Map<string, PQueue> = new Map()
const activeTaskControllers = new Map<string, AbortController>()

class TaskCancelledError extends Error {
  constructor() {
    super('Task cancelled by user')
    this.name = 'TaskCancelledError'
  }
}

class TaskPausedError extends TaskCancelledError {
  constructor() {
    super()
    this.message = 'Task paused by user'
    this.name = 'TaskPausedError'
  }
}

function isTaskCancelled(taskId: string): boolean {
  return getTaskById(taskId)?.status === 'cancelled'
}

function throwIfTaskCancelled(taskId: string): void {
  const status = getTaskById(taskId)?.status
  if (status === 'paused') throw new TaskPausedError()
  if (status === 'cancelled') throw new TaskCancelledError()
}

function getQueue(platform: string): PQueue {
  if (!queues.has(platform)) {
    const concurrency = CONCURRENCY[platform] || 1
    queues.set(platform, new PQueue({ concurrency }))
  }
  return queues.get(platform)!
}

function dbRowToAccount(row: DbAccount): DriveAccount {
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

function dbTaskToAccount(task: DbTask): DriveAccount | null {
  const row = getAccountById(task.account_id)
  return row ? dbRowToAccount(row) : null
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
  if (isTaskCancelled(taskId)) return
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
    throwIfTaskCancelled(task.id)
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
      throwIfTaskCancelled(task.id)
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
        if (err instanceof TaskCancelledError) throw err
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
    throwIfTaskCancelled(task.id)
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
      throwIfTaskCancelled(task.id)

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
      if (err instanceof TaskCancelledError) {
        markTransferRecordFailed(recordId, 'Task cancelled by user')
        throw err
      }
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
  if (completed > 0) invalidateFilesCacheParents(task.account_id, [payload.targetDirId || '0'])
  if (failedCount > 0 && completed === 0) {
    // All links failed — throw to trigger retry or permanent failure
    throw lastError || new Error(`全部 ${failedCount} 个链接转存失败`)
  }
  if (failedCount > 0) {
    taskLog('warn', task.id, task.account_id, task.platform, `批量转存部分完成: ${completed} 成功, ${failedCount} 失败`)
  }
}

// ── Upload task ──

interface TaskRunOutcome {
  partial?: boolean
  summary?: string
}

function saveTransferResult(
  taskId: string,
  payload: UploadTaskPayload | DownloadTaskPayload,
  result: TransferItemResult,
): void {
  payload.results ||= []
  const index = payload.results.findIndex((item) => item.key === result.key)
  if (index >= 0) payload.results[index] = result
  else payload.results.push(result)
  updateTaskPayload(taskId, payload)
}

function finishedTransferKeys(payload: UploadTaskPayload | DownloadTaskPayload): Set<string> {
  return new Set((payload.results || [])
    .filter((item) => item.status === 'success' || item.status === 'skipped')
    .map((item) => item.key))
}

async function runUploadTask(task: DbTask): Promise<TaskRunOutcome> {
  const payload: UploadTaskPayload = JSON.parse(task.payload)
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('账号不存在')

  const adapter = getAdapter(task.platform)
  if (!adapter.upload) {
    throw new Error(`${task.platform} 暂不支持上传功能`)
  }

  const totalFiles = payload.files.length
  const totalSize = payload.files.reduce((sum, f) => sum + f.fileSize, 0)
  const finishedKeys = finishedTransferKeys(payload)
  let completedFiles = payload.files.filter((file) => finishedKeys.has(file.localPath)).length
  let completedSize = payload.files.filter((file) => finishedKeys.has(file.localPath)).reduce((sum, file) => sum + file.fileSize, 0)
  let failedCount = 0
  let lastError: Error | null = null
  const conflictPolicy = normalizeConflictPolicy(payload.conflictPolicy, payload.overwrite)
  const directoryIds = new Map<string, string>(Object.entries(payload.remoteDirectoryIds || {}))
  const remoteEntries = new Map<string, FileItem[]>()

  const getEntries = async (parentId: string): Promise<FileItem[]> => {
    let entries = remoteEntries.get(parentId)
    if (!entries) {
      entries = (await adapter.listFiles(account, parentId)).files
      remoteEntries.set(parentId, entries)
    }
    return entries
  }

  const ensureDirectory = async (relativeDir: string): Promise<string | null> => {
    if (!relativeDir || relativeDir === '.') return payload.targetDirId
    const normalized = normalizeRelativePath(relativeDir)
    const parts = normalized.split(path.sep)
    let parentId = payload.targetDirId
    let requestedPath = ''
    for (const segment of parts) {
      requestedPath = requestedPath ? path.join(requestedPath, segment) : segment
      const cachedId = directoryIds.get(requestedPath)
      if (cachedId) {
        parentId = cachedId
        continue
      }

      const entries = await getEntries(parentId)
      let actualName = segment
      const existing = entries.find((entry) => entry.name === actualName)
      if (existing?.isDir) {
        if (conflictPolicy === 'rename') {
          actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
          const created = await adapter.mkdir(account, parentId, actualName)
          entries.push(created)
          parentId = created.id
        } else {
          parentId = existing.id
        }
      } else {
        if (existing && conflictPolicy === 'skip') return null
        if (existing && conflictPolicy === 'overwrite') {
          await adapter.delete(account, [existing.id])
          entries.splice(entries.indexOf(existing), 1)
        } else if (existing || conflictPolicy === 'rename') {
          actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
        }
        const created = await adapter.mkdir(account, parentId, actualName)
        entries.push(created)
        parentId = created.id
      }
      directoryIds.set(requestedPath, parentId)
      payload.remoteDirectoryIds = Object.fromEntries(directoryIds)
      updateTaskPayload(task.id, payload)
    }
    return parentId
  }

  taskLog('info', task.id, task.account_id, task.platform, `开始上传 ${totalFiles} 个文件，总大小: ${formatFileSize(totalSize)}`)

  for (const file of payload.files) {
    throwIfTaskCancelled(task.id)
    const key = file.localPath
    if (finishedKeys.has(key)) continue
    try {
      const relativePath = normalizeRelativePath(file.relativePath || file.fileName)
      const remoteDirId = await ensureDirectory(path.dirname(relativePath))
      if (!remoteDirId) {
        completedFiles++
        completedSize += file.fileSize
        saveTransferResult(task.id, payload, { key, name: file.fileName, status: 'skipped' })
        taskLog('warn', task.id, task.account_id, task.platform, `跳过上传（目录冲突）: ${relativePath}`)
        continue
      }

      const entries = await getEntries(remoteDirId)
      let uploadName = path.basename(relativePath)
      const existing = entries.find((entry) => entry.name === uploadName)
      if (existing) {
        if (conflictPolicy === 'skip') {
          completedFiles++
          completedSize += file.fileSize
          saveTransferResult(task.id, payload, { key, name: file.fileName, status: 'skipped' })
          taskLog('warn', task.id, task.account_id, task.platform, `跳过同名文件: ${relativePath}`)
          continue
        }
        if (conflictPolicy === 'overwrite') {
          if (existing.isDir) throw new Error(`无法用文件覆盖远端目录: ${relativePath}`)
          await adapter.delete(account, [existing.id])
          entries.splice(entries.indexOf(existing), 1)
        } else {
          uploadName = chooseAvailableName(uploadName, false, (candidate) => entries.some((entry) => entry.name === candidate))
        }
      }

      taskLog('info', task.id, task.account_id, task.platform, `正在上传: ${relativePath} (${formatFileSize(file.fileSize)})`)

      const result = await adapter.upload(account, file.localPath, remoteDirId, {
        signal: activeTaskControllers.get(task.id)?.signal,
        fileName: uploadName,
        overwrite: conflictPolicy === 'overwrite',
        onProgress: (progress) => {
          if (isTaskCancelled(task.id)) return
          const totalProgress = calculateTransferProgress({
            completedBytes: completedSize,
            currentLoaded: Math.min(progress.loaded, file.fileSize),
            totalBytes: totalSize,
            completedFiles,
            currentPercent: progress.percent,
            totalFiles,
          })

          updateTaskProgress(task.id, totalProgress)
          notifyTaskProgress(task.id, totalProgress, `正在上传: ${file.fileName} (${progress.percent}%)`)
        },
      })
      throwIfTaskCancelled(task.id)

      if (result.success) {
        completedFiles++
        completedSize += file.fileSize
        entries.push({ id: result.fileId || `uploaded:${key}`, parentId: remoteDirId, name: uploadName, isDir: false, size: file.fileSize, createdAt: Date.now(), updatedAt: Date.now(), platform: account.platform, accountId: account.id })
        saveTransferResult(task.id, payload, { key, name: file.fileName, status: 'success', outputPath: path.join(path.dirname(relativePath), uploadName) })
        taskLog('info', task.id, task.account_id, task.platform, `上传成功: ${relativePath} -> ${result.fileId || 'unknown'}`)
      } else {
        failedCount++
        lastError = new Error(result.error || '上传失败')
        saveTransferResult(task.id, payload, { key, name: file.fileName, status: 'failed', error: result.error || '上传失败' })
        taskLog('error', task.id, task.account_id, task.platform, `上传失败: ${file.fileName} - ${result.error}`)
      }
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveTransferResult(task.id, payload, { key, name: file.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `上传异常: ${file.fileName} - ${sanitizeError(err)}`)
      // 继续处理其他文件，不中断
    }
  }

  // 更新最终进度
  invalidateFilesCacheParents(task.account_id, [payload.targetDirId])
  updateTaskProgress(task.id, 100)
  notifyTaskProgress(task.id, 100, `上传完成: ${completedFiles}/${totalFiles} 个文件`)

  if (failedCount > 0 && completedFiles === 0) {
    // 全部失败
    throw lastError || new Error(`全部 ${failedCount} 个文件上传失败`)
  }

  if (failedCount > 0) {
    taskLog('warn', task.id, task.account_id, task.platform, `批量上传部分完成: ${completedFiles} 成功, ${failedCount} 失败`)
    return { partial: true, summary: `${completedFiles} 成功/跳过，${failedCount} 失败` }
  }

  taskLog('info', task.id, task.account_id, task.platform, `上传任务完成: ${completedFiles}/${totalFiles} 个文件`)
  return {}
}

// ── Download task ──

async function runDownloadTask(task: DbTask): Promise<TaskRunOutcome> {
  const payload: DownloadTaskPayload = JSON.parse(task.payload)
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('账号不存在')

  const adapter = getAdapter(task.platform)
  if (!adapter.download) {
    throw new Error(`${task.platform} 暂不支持下载功能`)
  }

  const conflictPolicy = normalizeConflictPolicy(payload.conflictPolicy, payload.overwrite)
  const expandedFiles: Array<{ fileId: string; fileName: string; fileSize: number; relativePath: string; key: string }> = []
  const resolvedRoots = payload.resolvedRoots ||= {}
  let discovered = 0

  const allocateTopRoot = (file: DownloadTaskPayload['files'][number]): string | null => {
    const persisted = resolvedRoots[file.fileId]
    if (persisted) return persisted
    const safeName = sanitizeFileName(file.fileName)
    const requestedPath = resolvePathInside(payload.targetDirPath, safeName)
    let outputName = safeName
    if (fs.existsSync(requestedPath)) {
      if (conflictPolicy === 'skip') return null
      if (conflictPolicy === 'rename') {
        outputName = chooseAvailableName(safeName, file.isDir, (candidate) => fs.existsSync(resolvePathInside(payload.targetDirPath, candidate)))
      } else if (file.isDir && !fs.statSync(requestedPath).isDirectory()) {
        fs.unlinkSync(requestedPath)
      } else if (!file.isDir && fs.statSync(requestedPath).isDirectory()) {
        throw new Error(`无法用文件覆盖本地目录: ${safeName}`)
      }
    }
    resolvedRoots[file.fileId] = outputName
    updateTaskPayload(task.id, payload)
    return outputName
  }

  const walkDirectory = async (directoryId: string, relativeDir: string, ancestors: Set<string>): Promise<void> => {
    throwIfTaskCancelled(task.id)
    if (ancestors.has(directoryId)) throw new Error('云端目录结构包含循环引用')
    const nextAncestors = new Set(ancestors).add(directoryId)
    const localDir = resolvePathInside(payload.targetDirPath, relativeDir)
    if (fs.existsSync(localDir) && !fs.statSync(localDir).isDirectory()) {
      if (conflictPolicy !== 'overwrite') throw new Error(`本地目录路径已被文件占用: ${relativeDir}`)
      fs.unlinkSync(localDir)
    }
    fs.mkdirSync(localDir, { recursive: true })
    const entries = (await adapter.listFiles(account, directoryId)).files
    const allocated = new Set<string>()
    for (const entry of entries) {
      if (++discovered > 10_000) throw new Error('单次目录下载最多包含 10000 个项目')
      let safeName = sanitizeFileName(entry.name)
      safeName = chooseAvailableName(safeName, entry.isDir, (candidate) => allocated.has(candidate))
      allocated.add(safeName)
      const childRelative = path.join(relativeDir, safeName)
      if (entry.isDir) {
        await walkDirectory(entry.id, childRelative, nextAncestors)
      } else {
        expandedFiles.push({ fileId: entry.id, fileName: entry.name, fileSize: entry.size || 0, relativePath: childRelative, key: `${entry.id}:${childRelative}` })
      }
    }
  }

  for (const file of payload.files) {
    throwIfTaskCancelled(task.id)
    const relativeRoot = allocateTopRoot(file)
    if (!relativeRoot) {
      saveTransferResult(task.id, payload, { key: file.fileId, name: file.fileName, status: 'skipped' })
      continue
    }
    if (file.isDir) {
      await walkDirectory(file.fileId, relativeRoot, new Set())
    } else {
      expandedFiles.push({ ...file, relativePath: relativeRoot, key: `${file.fileId}:${relativeRoot}` })
    }
  }

  const totalFiles = expandedFiles.length
  const totalSize = expandedFiles.reduce((sum, f) => sum + f.fileSize, 0)
  const finishedKeys = finishedTransferKeys(payload)
  let completedFiles = expandedFiles.filter((file) => finishedKeys.has(file.key)).length
  let completedSize = expandedFiles.filter((file) => finishedKeys.has(file.key)).reduce((sum, file) => sum + file.fileSize, 0)
  let failedCount = 0
  let lastError: Error | null = null

  taskLog('info', task.id, task.account_id, task.platform, `开始下载 ${totalFiles} 个文件，总大小: ${formatFileSize(totalSize)}`)

  for (const file of expandedFiles) {
    throwIfTaskCancelled(task.id)
    if (finishedKeys.has(file.key)) continue
    try {
      let localPath = resolvePathInside(payload.targetDirPath, file.relativePath)
      if (fs.existsSync(localPath)) {
        if (conflictPolicy === 'skip') {
          completedFiles++
          completedSize += file.fileSize
          saveTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'skipped', outputPath: localPath })
          continue
        }
        if (conflictPolicy === 'rename') {
          const parentDir = path.dirname(localPath)
          const renamed = chooseAvailableName(path.basename(localPath), false, (candidate) => fs.existsSync(path.join(parentDir, candidate)))
          localPath = resolvePathInside(payload.targetDirPath, path.join(path.dirname(file.relativePath), renamed))
        } else if (fs.statSync(localPath).isDirectory()) {
          throw new Error(`无法用文件覆盖本地目录: ${file.relativePath}`)
        }
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      taskLog('info', task.id, task.account_id, task.platform, `正在下载: ${file.relativePath} (${formatFileSize(file.fileSize)})`)

      const result = await adapter.download(account, file.fileId, path.dirname(localPath), {
        signal: activeTaskControllers.get(task.id)?.signal,
        fileName: path.basename(localPath),
        onProgress: (progress) => {
          if (isTaskCancelled(task.id)) return
          const totalProgress = calculateTransferProgress({
            completedBytes: completedSize,
            currentLoaded: Math.min(progress.loaded, file.fileSize),
            totalBytes: totalSize,
            completedFiles,
            currentPercent: progress.percent,
            totalFiles,
          })

          updateTaskProgress(task.id, totalProgress)
          notifyTaskProgress(task.id, totalProgress, `正在下载: ${file.fileName} (${progress.percent}%)`)
        },
      })
      throwIfTaskCancelled(task.id)

      if (result.success) {
        completedFiles++
        completedSize += file.fileSize
        saveTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'success', outputPath: result.localPath || localPath })
        taskLog('info', task.id, task.account_id, task.platform, `下载成功: ${file.fileName} -> ${result.localPath || 'unknown'}`)
      } else {
        failedCount++
        lastError = new Error(result.error || '下载失败')
        saveTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'failed', error: result.error || '下载失败' })
        taskLog('error', task.id, task.account_id, task.platform, `下载失败: ${file.fileName} - ${result.error}`)
      }
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'failed', error: sanitizeError(err) })
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
    return { partial: true, summary: `${completedFiles} 成功/跳过，${failedCount} 失败` }
  }

  taskLog('info', task.id, task.account_id, task.platform, `下载任务完成: ${completedFiles}/${totalFiles} 个文件`)
  return {}
}

interface ExpandedCloudDirectory {
  relativePath: string
  key: string
}

interface ExpandedCloudFile {
  fileId: string
  fileName: string
  fileSize: number
  relativePath: string
  key: string
}

function saveCloudTransferResult(taskId: string, payload: CloudTransferTaskPayload, result: TransferItemResult): void {
  payload.results ||= []
  const index = payload.results.findIndex((item) => item.key === result.key)
  if (index >= 0) payload.results[index] = result
  else payload.results.push(result)
  updateTaskPayload(taskId, payload)
}

function cloudTransferFinishedKeys(payload: CloudTransferTaskPayload): Set<string> {
  return new Set((payload.results || [])
    .filter((item) => item.status === 'success' || item.status === 'skipped')
    .map((item) => item.key))
}

function cloudTransferHasSkippedAncestor(relativePath: string, skippedDirectories: Set<string>): boolean {
  let parent = path.dirname(relativePath)
  while (parent && parent !== '.') {
    if (skippedDirectories.has(parent)) return true
    parent = path.dirname(parent)
  }
  return false
}

async function expandCloudTransferFiles(
  task: DbTask,
  payload: CloudTransferTaskPayload,
  sourceAdapter: ReturnType<typeof getAdapter>,
  sourceAccount: DriveAccount,
): Promise<{ directories: ExpandedCloudDirectory[]; files: ExpandedCloudFile[] }> {
  const directories: ExpandedCloudDirectory[] = []
  const files: ExpandedCloudFile[] = []
  let discovered = 0

  const walkDirectory = async (directoryId: string, relativePath: string, ancestors: Set<string>): Promise<void> => {
    throwIfTaskCancelled(task.id)
    if (ancestors.has(directoryId)) throw new Error('云端目录结构包含循环引用')
    if (++discovered > 10_000) throw new Error('单次迁移最多包含 10000 个项目')
    directories.push({ relativePath, key: `dir:${relativePath}` })
    const entries = (await sourceAdapter.listFiles(sourceAccount, directoryId)).files
    const allocated = new Set<string>()
    const nextAncestors = new Set(ancestors).add(directoryId)
    for (const entry of entries) {
      const safeName = chooseAvailableName(sanitizeFileName(entry.name), entry.isDir, (candidate) => allocated.has(candidate))
      allocated.add(safeName)
      const childPath = path.join(relativePath, safeName)
      if (entry.isDir) {
        await walkDirectory(entry.id, childPath, nextAncestors)
      } else {
        if (++discovered > 10_000) throw new Error('单次迁移最多包含 10000 个项目')
        files.push({
          fileId: entry.id,
          fileName: entry.name,
          fileSize: Math.max(0, Number(entry.size) || 0),
          relativePath: childPath,
          key: `file:${entry.id}:${childPath}`,
        })
      }
    }
  }

  for (const item of payload.files) {
    throwIfTaskCancelled(task.id)
    const rootName = sanitizeFileName(item.fileName)
    if (item.isDir) {
      await walkDirectory(item.fileId, rootName, new Set())
    } else {
      if (++discovered > 10_000) throw new Error('单次迁移最多包含 10000 个项目')
      files.push({
        fileId: item.fileId,
        fileName: item.fileName,
        fileSize: Math.max(0, Number(item.fileSize) || 0),
        relativePath: rootName,
        key: `file:${item.fileId}:${rootName}`,
      })
    }
  }

  return { directories, files }
}

async function runNativeCloudCopyTask(
  task: DbTask,
  payload: CloudTransferTaskPayload,
  sourceAccount: DriveAccount,
  sourceAdapter: ReturnType<typeof getAdapter>,
): Promise<TaskRunOutcome> {
  if (!sourceAdapter.copy) throw new Error('当前平台不支持云端复制')
  const entries = (await sourceAdapter.listFiles(sourceAccount, payload.targetDirId)).files
  const finishedKeys = cloudTransferFinishedKeys(payload)
  let completed = payload.files.filter((item) => finishedKeys.has(item.fileId)).length
  let failedCount = 0
  let lastError: Error | null = null

  for (const item of payload.files) {
    throwIfTaskCancelled(task.id)
    if (finishedKeys.has(item.fileId)) continue
    const existing = entries.find((entry) => entry.name === item.fileName)
    try {
      if (existing && payload.conflictPolicy === 'skip') {
        saveCloudTransferResult(task.id, payload, { key: item.fileId, name: item.fileName, status: 'skipped' })
        completed++
        continue
      }
      if (existing && payload.conflictPolicy === 'overwrite') {
        if (existing.id === item.fileId) throw new Error('不能在原目录中覆盖迁移源文件')
        await sourceAdapter.delete(sourceAccount, [existing.id])
        entries.splice(entries.indexOf(existing), 1)
      }
      await sourceAdapter.copy(sourceAccount, [item.fileId], payload.targetDirId)
      saveCloudTransferResult(task.id, payload, { key: item.fileId, name: item.fileName, status: 'success' })
      completed++
      taskLog('info', task.id, task.account_id, task.platform, `云端复制成功: ${item.fileName}`)
    } catch (err) {
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveCloudTransferResult(task.id, payload, { key: item.fileId, name: item.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `云端复制失败: ${item.fileName} — ${sanitizeError(err)}`)
    }
    updateTaskProgress(task.id, Math.round(((completed + failedCount) / payload.files.length) * 100))
  }

  invalidateFilesCacheParents(payload.targetAccountId, [payload.targetDirId])
  if (failedCount > 0 && completed === 0) throw lastError || new Error('云端复制失败')
  if (failedCount > 0) return { partial: true, summary: `${completed} 成功/跳过，${failedCount} 失败` }
  return {}
}

async function runSharedCloudTransferTask(
  task: DbTask,
  payload: CloudTransferTaskPayload,
  sourceAccount: DriveAccount,
  targetAccount: DriveAccount,
  sourceAdapter: ReturnType<typeof getAdapter>,
  targetAdapter: ReturnType<typeof getAdapter>,
): Promise<TaskRunOutcome> {
  if (!sourceAdapter.createShare || !targetAdapter.saveSharedFiles) throw new Error('当前平台不支持云端迁移')
  const entries = (await targetAdapter.listFiles(targetAccount, payload.targetDirId)).files
  const finishedKeys = cloudTransferFinishedKeys(payload)
  let completed = payload.files.filter((item) => finishedKeys.has(item.fileId)).length
  let failedCount = 0
  let lastError: Error | null = null

  for (const item of payload.files) {
    throwIfTaskCancelled(task.id)
    if (finishedKeys.has(item.fileId)) continue
    const existing = entries.find((entry) => entry.name === item.fileName)
    try {
      if (existing && payload.conflictPolicy === 'skip') {
        saveCloudTransferResult(task.id, payload, { key: item.fileId, name: item.fileName, status: 'skipped' })
        completed++
        continue
      }
      let requestedName = item.fileName
      if (existing && payload.conflictPolicy === 'rename') {
        requestedName = chooseAvailableName(item.fileName, item.isDir, (candidate) => entries.some((entry) => entry.name === candidate))
      }
      if (existing && payload.conflictPolicy === 'overwrite') {
        if (sourceAccount.id === targetAccount.id && existing.id === item.fileId) {
          throw new Error('不能在原目录中覆盖迁移源文件')
        }
        await targetAdapter.delete(targetAccount, [existing.id])
        entries.splice(entries.indexOf(existing), 1)
      }
      const share = await sourceAdapter.createShare(sourceAccount, [{
        fileId: item.fileId,
        name: item.fileName,
        isDir: item.isDir,
        path: item.path,
      }], { title: item.fileName })
      const result = await targetAdapter.saveSharedFiles(targetAccount, { url: share.shareUrl, password: share.password }, payload.targetDirId)
      if (!result.success) throw new Error(result.error || '云端转存失败')
      if (requestedName !== item.fileName) {
        const refreshedEntries = (await targetAdapter.listFiles(targetAccount, payload.targetDirId)).files
        const savedIds = new Set((result.savedFileIds || []).map((id) => String(id)))
        const candidate = refreshedEntries.find((entry) =>
          savedIds.has(String(entry.id)) || (entry.name === item.fileName && (!existing || entry.id !== existing.id)))
        if (candidate && candidate.name !== requestedName) {
          await targetAdapter.rename(targetAccount, candidate.id, requestedName)
        }
        entries.splice(0, entries.length, ...refreshedEntries.map((entry) => (
          candidate && entry.id === candidate.id ? { ...entry, name: requestedName } : entry
        )))
      }
      saveCloudTransferResult(task.id, payload, { key: item.fileId, name: item.fileName, status: 'success' })
      completed++
      taskLog('info', task.id, task.account_id, task.platform, `云端迁移成功: ${item.fileName}`)
    } catch (err) {
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveCloudTransferResult(task.id, payload, { key: item.fileId, name: item.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `云端迁移失败: ${item.fileName} — ${sanitizeError(err)}`)
    }
    updateTaskProgress(task.id, Math.round(((completed + failedCount) / payload.files.length) * 100))
  }

  invalidateFilesCacheParents(payload.targetAccountId, [payload.targetDirId])
  if (failedCount > 0 && completed === 0) throw lastError || new Error('云端迁移失败')
  if (failedCount > 0) return { partial: true, summary: `${completed} 成功/跳过，${failedCount} 失败` }
  return {}
}

async function runStagedCloudTransferTask(
  task: DbTask,
  payload: CloudTransferTaskPayload,
  sourceAccount: DriveAccount,
  targetAccount: DriveAccount,
  sourceAdapter: ReturnType<typeof getAdapter>,
  targetAdapter: ReturnType<typeof getAdapter>,
): Promise<TaskRunOutcome> {
  if (!sourceAdapter.download) throw new Error(`${sourceAccount.platform} 暂不支持下载功能`)
  if (!targetAdapter.upload) throw new Error(`${targetAccount.platform} 暂不支持上传功能`)

  const expanded = await expandCloudTransferFiles(task, payload, sourceAdapter, sourceAccount)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-cloud-transfer-'))
  const allWork = [...expanded.directories.map((item) => item.key), ...expanded.files.map((item) => item.key)]
  const finishedKeys = cloudTransferFinishedKeys(payload)
  let completedWork = allWork.filter((key) => finishedKeys.has(key)).length
  let completedBytes = expanded.files
    .filter((item) => finishedKeys.has(item.key))
    .reduce((sum, item) => sum + item.fileSize, 0)
  const totalBytes = expanded.files.reduce((sum, item) => sum + item.fileSize, 0)
  let failedCount = 0
  let lastError: Error | null = null
  const skippedDirectories = new Set<string>()
  const targetEntries = new Map<string, FileItem[]>()
  const directoryIds = new Map<string, string>(Object.entries(payload.remoteDirectoryIds || {}))

  const getTargetEntries = async (parentId: string): Promise<FileItem[]> => {
    let entries = targetEntries.get(parentId)
    if (!entries) {
      entries = (await targetAdapter.listFiles(targetAccount, parentId)).files
      targetEntries.set(parentId, entries)
    }
    return entries
  }

  const ensureTargetDirectory = async (relativeDir: string): Promise<string | null> => {
    if (!relativeDir || relativeDir === '.') return payload.targetDirId
    const normalized = normalizeRelativePath(relativeDir)
    const parts = normalized.split(path.sep)
    let parentId = payload.targetDirId
    let requestedPath = ''
    for (const segment of parts) {
      requestedPath = requestedPath ? path.join(requestedPath, segment) : segment
      const cachedId = directoryIds.get(requestedPath)
      if (cachedId) {
        parentId = cachedId
        continue
      }
      const entries = await getTargetEntries(parentId)
      let actualName = segment
      const existing = entries.find((entry) => entry.name === actualName)
      if (existing?.isDir) {
        if (payload.conflictPolicy === 'rename') {
          actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
          const created = await targetAdapter.mkdir(targetAccount, parentId, actualName)
          entries.push(created)
          parentId = created.id
        } else {
          parentId = existing.id
        }
      } else {
        if (existing && payload.conflictPolicy === 'skip') return null
        if (existing && payload.conflictPolicy === 'overwrite') {
          await targetAdapter.delete(targetAccount, [existing.id])
          entries.splice(entries.indexOf(existing), 1)
        } else if (existing || payload.conflictPolicy === 'rename') {
          actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
        }
        const created = await targetAdapter.mkdir(targetAccount, parentId, actualName)
        entries.push(created)
        parentId = created.id
      }
      directoryIds.set(requestedPath, parentId)
      payload.remoteDirectoryIds = Object.fromEntries(directoryIds)
      updateTaskPayload(task.id, payload)
    }
    return parentId
  }

  const updateProgress = (file: ExpandedCloudFile, phase: 'download' | 'upload', percent: number, speed = 0): void => {
    const fraction = phase === 'download' ? percent / 200 : 0.5 + percent / 200
    if (totalBytes > 0) {
      updateTaskProgress(task.id, Math.min(99, Math.round(((completedBytes + file.fileSize * fraction) / totalBytes) * 100)))
    } else if (allWork.length > 0) {
      updateTaskProgress(task.id, Math.min(99, Math.round(((completedWork + fraction) / allWork.length) * 100)))
    }
    const speedText = speed > 0 ? ` · ${formatFileSize(speed)}/s` : ''
    notifyTaskProgress(task.id, getTaskById(task.id)?.progress || 0, `${phase === 'download' ? '官方下载' : '官方上传'}: ${file.fileName} (${Math.round(percent)}%${speedText})`)
  }

  try {
    taskLog('info', task.id, task.account_id, task.platform,
      `开始迁移: ${sourceAccount.nickname} → ${targetAccount.nickname}，${expanded.files.length} 个文件`)

  for (const directory of expanded.directories) {
    throwIfTaskCancelled(task.id)
    if (finishedKeys.has(directory.key)) continue
    if (cloudTransferHasSkippedAncestor(directory.relativePath, skippedDirectories)) {
      skippedDirectories.add(directory.relativePath)
      saveCloudTransferResult(task.id, payload, { key: directory.key, name: path.basename(directory.relativePath), status: 'skipped' })
      completedWork++
      continue
    }
    try {
      const targetId = await ensureTargetDirectory(directory.relativePath)
      if (!targetId) skippedDirectories.add(directory.relativePath)
      saveCloudTransferResult(task.id, payload, { key: directory.key, name: path.basename(directory.relativePath), status: targetId ? 'success' : 'skipped' })
      completedWork++
    } catch (err) {
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveCloudTransferResult(task.id, payload, { key: directory.key, name: path.basename(directory.relativePath), status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `创建目标目录失败: ${directory.relativePath} — ${sanitizeError(err)}`)
    }
    updateTaskProgress(task.id, Math.min(99, Math.round((completedWork / allWork.length) * 100)))
  }

  for (const file of expanded.files) {
    throwIfTaskCancelled(task.id)
    if (finishedKeys.has(file.key)) continue
    if (cloudTransferHasSkippedAncestor(file.relativePath, skippedDirectories)) {
      saveCloudTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'skipped' })
      completedWork++
      completedBytes += file.fileSize
      continue
    }

    const localPath = resolvePathInside(tempDir, file.relativePath)
    let downloadedPath = localPath
    try {
      const relativeDir = path.dirname(file.relativePath)
      const targetDirId = await ensureTargetDirectory(relativeDir)
      if (!targetDirId) {
        saveCloudTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'skipped' })
        completedWork++
        completedBytes += file.fileSize
        continue
      }
      const entries = await getTargetEntries(targetDirId)
      let uploadName = sanitizeFileName(path.basename(file.relativePath))
      const existing = entries.find((entry) => entry.name === uploadName)
      if (existing) {
        if (payload.conflictPolicy === 'skip') {
          saveCloudTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'skipped' })
          completedWork++
          completedBytes += file.fileSize
          continue
        }
        if (payload.conflictPolicy === 'overwrite') {
          if (existing.isDir) throw new Error(`无法用文件覆盖远端目录: ${file.relativePath}`)
          if (sourceAccount.id === targetAccount.id && existing.id === file.fileId) {
            throw new Error('不能在原目录中覆盖迁移源文件')
          }
          await targetAdapter.delete(targetAccount, [existing.id])
          entries.splice(entries.indexOf(existing), 1)
        } else {
          uploadName = chooseAvailableName(uploadName, false, (candidate) => entries.some((entry) => entry.name === candidate))
        }
      }

      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      taskLog('info', task.id, task.account_id, task.platform, `调用 ${sourceAccount.platform} 官方下载接口: ${file.relativePath}`)
      const downloadResult = await sourceAdapter.download(sourceAccount, file.fileId, path.dirname(localPath), {
        signal: activeTaskControllers.get(task.id)?.signal,
        fileName: path.basename(localPath),
        onProgress: (progress) => {
          const percent = progress.percent > 0
            ? progress.percent
            : file.fileSize > 0 ? progress.loaded / file.fileSize * 100 : 0
          updateProgress(file, 'download', Math.min(100, percent), progress.speed)
        },
      })
      throwIfTaskCancelled(task.id)
      if (!downloadResult.success) throw new Error(downloadResult.error || '下载失败')
      downloadedPath = ensureDownloadedPathInside(tempDir, downloadResult.localPath || localPath)
      const uploadResult = await targetAdapter.upload(targetAccount, downloadedPath, targetDirId, {
        signal: activeTaskControllers.get(task.id)?.signal,
        fileName: uploadName,
        overwrite: payload.conflictPolicy === 'overwrite',
        onProgress: (progress) => {
          const percent = progress.percent > 0
            ? progress.percent
            : file.fileSize > 0 ? progress.loaded / file.fileSize * 100 : 0
          updateProgress(file, 'upload', Math.min(100, percent), progress.speed)
        },
      })
      throwIfTaskCancelled(task.id)
      if (!uploadResult.success) throw new Error(uploadResult.error || '上传失败')

      entries.push({ id: uploadResult.fileId || `migrated:${file.key}`, parentId: targetDirId, name: uploadName, isDir: false, size: file.fileSize, createdAt: Date.now(), updatedAt: Date.now(), platform: targetAccount.platform, accountId: targetAccount.id })
      saveCloudTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'success', outputPath: path.join(relativeDir, uploadName) })
      completedWork++
      completedBytes += file.fileSize
      taskLog('info', task.id, task.account_id, task.platform, `迁移成功: ${file.relativePath}`)
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveCloudTransferResult(task.id, payload, { key: file.key, name: file.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `迁移失败: ${file.relativePath} — ${sanitizeError(err)}`)
    } finally {
      try {
        if (fs.existsSync(downloadedPath) && fs.statSync(downloadedPath).isFile()) fs.unlinkSync(downloadedPath)
      } catch { /* ignore temporary file cleanup errors */ }
    }
  }

    invalidateFilesCacheParents(payload.targetAccountId, [payload.targetDirId])
    if (failedCount > 0 && completedWork === 0) throw lastError || new Error('迁移失败')
    if (failedCount > 0) return { partial: true, summary: `${completedWork} 项成功/跳过，${failedCount} 项失败` }
    return {}
  } finally {
    cleanupTempDir(tempDir)
  }
}

async function runCloudTransferTask(task: DbTask): Promise<TaskRunOutcome> {
  const payload: CloudTransferTaskPayload = JSON.parse(task.payload)
  const sourceRow = getAccountById(payload.sourceAccountId)
  const targetRow = getAccountById(payload.targetAccountId)
  if (!sourceRow || !targetRow) throw new Error('源账号或目标账号不存在')
  const sourceAccount = dbRowToAccount(sourceRow)
  const targetAccount = dbRowToAccount(targetRow)
  if (sourceAccount.id === targetAccount.id
    && isTargetInsideSelectedDirectory(payload.files, payload.targetAncestorIds || [])) {
    throw new Error('不能把文件夹迁移到自身或其子目录')
  }
  const sourceAdapter = getAdapter(sourceAccount.platform)
  const targetAdapter = getAdapter(targetAccount.platform)
  const mode = selectCloudTransferMode({
    sameAccount: sourceAccount.id === targetAccount.id,
    samePlatform: sourceAccount.platform === targetAccount.platform,
    conflictPolicy: payload.conflictPolicy,
    canNativeCopy: !!sourceAdapter.copy,
    canSharedTransfer: !!sourceAdapter.createShare && !!targetAdapter.saveSharedFiles,
  })

  if (mode === 'native_copy') {
    taskLog('info', task.id, task.account_id, task.platform, '迁移模式: 原生云端复制')
    return runNativeCloudCopyTask(task, payload, sourceAccount, sourceAdapter)
  }
  if (mode === 'shared_transfer') {
    taskLog('info', task.id, task.account_id, task.platform, '迁移模式: 云端分享转存')
    return runSharedCloudTransferTask(task, payload, sourceAccount, targetAccount, sourceAdapter, targetAdapter)
  }
  taskLog('info', task.id, task.account_id, task.platform, '迁移模式: 下载后上传')
  return runStagedCloudTransferTask(task, payload, sourceAccount, targetAccount, sourceAdapter, targetAdapter)
}

// ── Archive tasks ──

function updateArchiveStage(task: DbTask, progress: number, message: string): void {
  throwIfTaskCancelled(task.id)
  const bounded = Math.max(0, Math.min(100, Math.round(progress)))
  updateTaskProgress(task.id, bounded)
  notifyTaskProgress(task.id, bounded, message)
}

function ensureDownloadedPathInside(tempDir: string, localPath: string): string {
  const root = path.resolve(tempDir)
  const resolved = path.resolve(localPath)
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (resolved !== root && !resolved.toLowerCase().startsWith(rootWithSeparator.toLowerCase())) {
    throw new Error('下载返回了非法的本地路径')
  }
  return resolved
}

async function runArchiveExtractTask(task: DbTask): Promise<TaskRunOutcome> {
  const payload: ArchiveExtractTaskPayload = JSON.parse(task.payload)
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('账号不存在')

  const adapter = getAdapter(task.platform)
  if (!adapter.download) throw new Error(`${task.platform} 暂不支持下载压缩包`)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-archive-extract-'))
  const signal = activeTaskControllers.get(task.id)?.signal
  try {
    updateArchiveStage(task, 0, '准备下载压缩包')
    const downloadResult = await adapter.download(account, payload.fileId, tempDir, {
      signal,
      fileName: sanitizeFileName(payload.fileName),
      onProgress: (progress) => {
        if (!signal?.aborted) updateArchiveStage(task, progress.percent * 0.4, `下载压缩包 (${progress.percent}%)`)
      },
    })
    throwIfTaskCancelled(task.id)
    if (!downloadResult.success || !downloadResult.localPath) {
      throw new Error(downloadResult.error || '压缩包下载失败')
    }

    const archivePath = ensureDownloadedPathInside(tempDir, downloadResult.localPath)
    updateArchiveStage(task, 40, '正在验证并解压')
    await extractArchive(
      archivePath,
      payload.options.targetDir,
      payload.options.password,
      payload.options.files,
      {
        signal,
        onProgress: (completed, total) => {
          const percent = total > 0 ? completed / total : Math.min(completed / 100, 0.95)
          updateArchiveStage(task, 40 + percent * 60, `正在解压 (${completed}${total > 0 ? `/${total}` : ''})`)
        },
      },
    )
    throwIfTaskCancelled(task.id)
    updateArchiveStage(task, 100, '解压完成')
    taskLog('info', task.id, task.account_id, task.platform, `解压完成: ${payload.fileName}`)
    return {}
  } finally {
    cleanupTempDir(tempDir)
  }
}

async function runArchiveCompressTask(task: DbTask): Promise<TaskRunOutcome> {
  const payload: ArchiveCompressTaskPayload = JSON.parse(task.payload)
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('账号不存在')

  const adapter = getAdapter(task.platform)
  if (!adapter.download) throw new Error(`${task.platform} 暂不支持下载文件`)
  if (!adapter.upload) throw new Error(`${task.platform} 暂不支持上传压缩包`)
  if (!payload.files.length) throw new Error('没有可压缩的文件')

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-archive-compress-'))
  const downloadDir = path.join(tempDir, 'files')
  fs.mkdirSync(downloadDir, { recursive: true })
  const signal = activeTaskControllers.get(task.id)?.signal
  const totalBytes = payload.files.reduce((sum, file) => sum + Math.max(file.fileSize, 0), 0)
  let completedBytes = 0
  let downloadedCount = 0
  let failedCount = 0
  const failedNames: string[] = []
  const downloadedFiles: Array<{ relativePath: string; fullPath: string }> = []
  const allocatedNames = new Set<string>()

  try {
    for (const file of payload.files) {
      throwIfTaskCancelled(task.id)
      const safeName = chooseAvailableName(sanitizeFileName(file.fileName), false, (candidate) => allocatedNames.has(candidate))
      allocatedNames.add(safeName)
      try {
        const result = await adapter.download!(account, file.downloadId, downloadDir, {
          signal,
          fileName: safeName,
          onProgress: (progress) => {
            if (signal?.aborted) return
            const fileWeight = totalBytes > 0
              ? (completedBytes + Math.min(progress.loaded, Math.max(file.fileSize, 0))) / totalBytes
              : (downloadedCount + progress.percent / 100) / payload.files.length
            updateArchiveStage(task, fileWeight * 50, `下载待压缩文件: ${file.fileName} (${progress.percent}%)`)
          },
        })
        throwIfTaskCancelled(task.id)
        if (!result.success || !result.localPath) throw new Error(result.error || '下载失败')
        const localPath = ensureDownloadedPathInside(downloadDir, result.localPath)
        downloadedFiles.push({ relativePath: safeName, fullPath: localPath })
        downloadedCount++
        completedBytes += Math.max(file.fileSize, 0)
        updateArchiveStage(task, totalBytes > 0 ? completedBytes / totalBytes * 50 : downloadedCount / payload.files.length * 50, `已下载 ${downloadedCount}/${payload.files.length} 个文件`)
      } catch (error) {
        if (error instanceof TaskCancelledError || signal?.aborted || isTaskCancelled(task.id)) throw error
        failedCount++
        failedNames.push(file.fileName)
        taskLog('error', task.id, task.account_id, task.platform, `压缩前下载失败: ${file.fileName} - ${sanitizeError(error)}`)
      }
    }

    if (downloadedFiles.length === 0) {
      throw new Error(`待压缩文件全部下载失败 (${failedCount}/${payload.files.length})`)
    }

    const extension = payload.format === 'tar' ? '.tar.gz' : '.zip'
    const archiveFileName = `${sanitizeFileName(payload.archiveName)}${extension}`
    const archivePath = path.join(tempDir, archiveFileName)
    updateArchiveStage(task, 50, `正在创建 ${payload.format.toUpperCase()} 压缩包`)
    await createArchive(downloadDir, archivePath, payload.format, downloadedFiles, {
      signal,
      onProgress: (completed, total) => {
        const ratio = total > 0 ? completed / total : Math.min(completed / downloadedFiles.length, 1)
        updateArchiveStage(task, 50 + ratio * 30, `正在压缩 (${completed}${total > 0 ? `/${total}` : ''})`)
      },
    })
    throwIfTaskCancelled(task.id)

    updateArchiveStage(task, 80, '正在上传压缩包')
    const uploadResult = await adapter.upload(account, archivePath, payload.targetDirId, {
      signal,
      fileName: archiveFileName,
      onProgress: (progress) => {
        if (!signal?.aborted) updateArchiveStage(task, 80 + progress.percent * 0.2, `正在上传压缩包 (${progress.percent}%)`)
      },
    })
    throwIfTaskCancelled(task.id)
    if (!uploadResult.success) throw new Error(uploadResult.error || '压缩包上传失败')

    invalidateFilesCacheParents(task.account_id, [payload.targetDirId])
    updateArchiveStage(task, 100, '压缩包已创建并上传')
    if (failedCount > 0) {
      const summary = `${downloadedCount} 个文件已压缩，${failedCount} 个下载失败: ${failedNames.slice(0, 5).join('、')}`
      taskLog('warn', task.id, task.account_id, task.platform, summary)
      return { partial: true, summary }
    }

    taskLog('info', task.id, task.account_id, task.platform, `压缩包创建完成: ${archiveFileName}`)
    return {}
  } finally {
    cleanupTempDir(tempDir)
  }
}

async function runTask(task: DbTask): Promise<void> {
  const current = getTaskById(task.id)
  if (!current || current.status !== 'pending') return
  updateTaskStatus(task.id, 'running')
  const controller = new AbortController()
  activeTaskControllers.set(task.id, controller)
  taskLog('info', task.id, task.account_id, task.platform, `Task started: ${task.task_type}`)

  try {
    let outcome: TaskRunOutcome | void = undefined
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
      case 'cloud_transfer':
        outcome = await runCloudTransferTask(task)
        break
      case 'upload':
        outcome = await runUploadTask(task)
        break
      case 'download':
        outcome = await runDownloadTask(task)
        break
      case 'archive_extract':
        outcome = await runArchiveExtractTask(task)
        break
      case 'archive_compress':
        outcome = await runArchiveCompressTask(task)
        break
      default:
        throw new Error(`Unknown task type: ${task.task_type}`)
    }

    throwIfTaskCancelled(task.id)
    if (outcome?.partial) {
      updateTaskStatus(task.id, 'partial_success', 100, outcome.summary || '任务部分完成')
      taskLog('warn', task.id, task.account_id, task.platform, `Task partially completed: ${outcome.summary || ''}`)
      notifyTaskTerminal({ id: task.id, title: task.title || task.task_type, status: 'partial_success', summary: outcome.summary })
      return
    }
    markTaskSuccess(task.id)
    taskLog('info', task.id, task.account_id, task.platform, 'Task completed successfully')
    notifyTaskTerminal({ id: task.id, title: task.title || task.task_type, status: 'success' })
  } catch (err) {
    if (err instanceof TaskPausedError || getTaskById(task.id)?.status === 'paused') {
      taskLog('info', task.id, task.account_id, task.platform, 'Task paused by user')
      return
    }
    if (err instanceof TaskCancelledError || isTaskCancelled(task.id)) {
      taskLog('info', task.id, task.account_id, task.platform, 'Task stopped after cancellation')
      return
    }
    const errorMsg = sanitizeError(err)

    // 永久性错误不重试（登录失效、链接失效、容量不足等）
    if (isPermanentError(err)) {
      markTaskFailed(task.id, errorMsg)
      taskLog('error', task.id, task.account_id, task.platform, `Task failed permanently (non-retryable): ${errorMsg}`)
      notifyTaskTerminal({ id: task.id, title: task.title || task.task_type, status: 'failed', errorMessage: errorMsg })
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
      notifyTaskTerminal({ id: task.id, title: task.title || task.task_type, status: 'failed', errorMessage: errorMsg })
    }
  } finally {
    activeTaskControllers.delete(task.id)
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
  queue.add(async () => {
    const latest = getTaskById(taskId)
    if (!latest || latest.status !== 'pending') return
    await runTask(latest)
  })
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
  if (task.status !== 'failed' && task.status !== 'partial_success' && task.status !== 'cancelled') return false

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
  if (task.status === 'success' || task.status === 'partial_success' || task.status === 'failed' || task.status === 'cancelled') return false

  markTaskCancelled(taskId)
  activeTaskControllers.get(taskId)?.abort()
  taskLog('info', taskId, task.account_id, task.platform, 'Task cancelled by user')
  return true
}

export function pauseTask(taskId: string): boolean {
  const task = getTaskById(taskId)
  if (!task || (task.status !== 'pending' && task.status !== 'running')) return false
  updateTaskStatus(taskId, 'paused')
  activeTaskControllers.get(taskId)?.abort()
  taskLog('info', taskId, task.account_id, task.platform, 'Task pause requested')
  return true
}

export function resumeTask(taskId: string): boolean {
  const task = getTaskById(taskId)
  if (!task || task.status !== 'paused') return false
  updateTaskStatus(taskId, 'pending')
  enqueueTask(taskId)
  taskLog('info', taskId, task.account_id, task.platform, 'Task resumed')
  return true
}

/** Get queue status for all platforms. */
export function getQueueStatus(): Record<string, { pending: number; running: number; size: number }> {
  const status: Record<string, { pending: number; running: number; size: number }> = {}
  for (const [platform, queue] of queues) {
    status[platform] = {
      pending: queue.size,
      running: queue.pending,
      size: queue.size + queue.pending,
    }
  }
  return status
}

/** On startup, re-enqueue any pending tasks. */
export function resumePendingTasks(): void {
  const recovered = recoverInterruptedTasks()
  if (recovered > 0) log.info(`TaskRunner: recovered ${recovered} interrupted tasks`)
  const pending = getPendingTasks()
  for (const task of pending) {
    enqueueTask(task.id)
  }
  if (pending.length > 0) {
    log.info(`TaskRunner: re-enqueued ${pending.length} pending tasks`)
  }
}

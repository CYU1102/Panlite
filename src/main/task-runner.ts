import { runTaskOperation as journalTaskOperation, guardTaskAdapterMutations, isWithinTaskOperation } from './task-operations'
import { TaskAdmissionQueue } from './task-admission'
import { assertTaskOperationSchedule, taskScheduleInfo, TaskWindowClosedError } from './task-scheduling'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { DriveAccount, FileItem, LogLevel, ShareTaskPayload, TransferTaskPayload, UploadTaskPayload, DownloadTaskPayload, TransferItemResult, ArchiveExtractTaskPayload, ArchiveCompressTaskPayload, CloudTransferTaskPayload } from '../shared/types'
import { IPC_CHANNELS, CONCURRENCY, MAX_RETRY_COUNT, TRANSFER_DELAY_MS, SETTINGS_KEYS, DEFAULT_BANNED_KEYWORDS } from '../shared/constants'
import { getAdapter as getRawAdapter } from '../adapters/registry'
import { accountRequestBudget, budgetDriveAdapter } from './account-request-budget'
import { getTaskExtension } from './task-extensions'
import { taskPayloadWithAutomationOrigin } from './automation-origin'
import { isPermanentError } from '../adapters/errors'
import { CHUNK_THRESHOLD_BYTES, RateLimiter } from './chunked-download'
import { clearTaskResumeCache, downloadTaskResumable } from './task-resumable-download'
import { ResumableDownloadBusyError, ResumableSourceChangedError } from './resumable-download'
import { extractSourceHash } from '../shared/cloud-transfer'
import { getTransferRuntimeSettings } from './transfer-runtime'
import crypto from 'node:crypto'
import {
  getTaskById,
  getPendingTasks,
  updateTaskProgressIfOwned,
  updateTaskPayloadIfOwned,
  transitionTaskStatusIfCurrent,
  recoverInterruptedTasks,
  insertTask,
  insertLog,
  getAccountById,
  insertShareLink,
  insertTransferRecord,
  markTransferRecordSuccess,
  markTransferRecordFailed,
  markShareSubscriptionSynced,
  getSetting,
  invalidateFilesCacheParents,
} from './db'
import { decryptCredential } from './crypto'
import { generateId, now, formatFileSize } from '../shared/utils'
import type { DbAccount, DbTask, TaskStatusTransitionOptions } from './db'
import log from 'electron-log'
import { calculateTransferProgress, chooseAvailableName, normalizeConflictPolicy, normalizeRelativePath, resolvePathInside, sanitizeFileName } from './file-transfer'
import { cleanupTempDir, createArchive, extractArchive } from './archive'
import { isTargetInsideSelectedDirectory, selectCloudTransferMode } from '../shared/cloud-transfer'
import { notifyTaskTerminal } from './runtime-services'
import { isTaskStatus, transitionTaskState, type TaskTransition, type TaskTransitionResult } from './task-state-machine'

type ScheduledTask = DbTask & { createdAt: number }
const admission = new TaskAdmissionQueue<ScheduledTask>({
  getTask(id) { const task = getTaskById(id); return task ? { ...task, createdAt: task.created_at } : undefined },
  decide(task) { const schedule = taskScheduleInfo(task); return { eligible: !schedule.waitReason, schedule } },
  capacity: platform => CONCURRENCY[platform] || 1,
  run: task => runTask(task),
  onError: error => log.error('Task admission failed:', sanitizeError(error)),
})
const getAdapter = (platform: string): ReturnType<typeof getRawAdapter> => budgetDriveAdapter(getRawAdapter(platform))
interface ActiveTaskController {
  token: string
  controller: AbortController
}

/** Pair controllers with the execution token to prevent ABA races. */
const activeTaskControllers = new Map<string, ActiveTaskController>()

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

class TaskScheduleDeferredError extends TaskCancelledError {
  readonly code = 'TASK_SCHEDULE_DEFERRED'
  constructor() { super(); this.name = 'TaskScheduleDeferredError'; this.message = '传输时段已结束，已保存进度并等待下一时段' }
}

function assertTaskDispatchAllowed(task: DbTask): void {
  try { assertTaskOperationSchedule(task) } catch (error) {
    if (error instanceof TaskWindowClosedError) throw new TaskScheduleDeferredError()
    throw error
  }
}

/**
 * Apply a lifecycle event through the pure state machine and persist it with
 * an optimistic status check. A false result means the task disappeared or a
 * concurrent actor won the race (for example pause/cancel vs worker start).
 */
function applyTaskTransition(
  taskId: string,
  event: TaskTransition,
  options: TaskStatusTransitionOptions = {},
  executionToken?: string | null,
): TaskTransitionResult | null {
  const current = getTaskById(taskId)
  if (!current) return null

  const currentToken = current.execution_token ?? null
  const expectedExecutionToken = options.expectedExecutionToken !== undefined
    ? options.expectedExecutionToken
    : executionToken !== undefined
      ? executionToken
      : currentToken

  // A stale worker must not apply an event after another attempt owns the row.
  if (executionToken !== undefined && currentToken !== executionToken) {
    return {
      ok: false,
      from: current.status,
      to: current.status,
      state: current.status,
      changed: false,
      idempotent: false,
      reason: '任务执行权已转移到新的执行尝试',
    }
  }

  const transition = transitionTaskState(current.status, event)
  if (!transition.ok || !transition.changed) return transition

  const persisted = transitionTaskStatusIfCurrent(
    taskId,
    transition.from,
    transition.to,
    {
      ...options,
      expectedExecutionToken,
    },
  )
  if (persisted) return transition

  return {
    ...transition,
    ok: false,
    reason: '任务状态已被并发操作更新',
  }
}

class TaskSupersededError extends TaskCancelledError {
  constructor() {
    super()
    this.message = 'Task execution superseded by a newer attempt'
    this.name = 'TaskSupersededError'
  }
}

function isTaskExecutionOwner(task: DbTask): boolean {
  const token = task.execution_token
  if (!token) return false
  const current = getTaskById(task.id)
  return current?.status === 'running' && current.execution_token === token
}

function isTaskCancelled(task: DbTask): boolean {
  const current = getTaskById(task.id)
  return current?.status === 'cancelled'
    || (!!current && current.execution_token !== (task.execution_token ?? null))
}

function throwIfTaskCancelled(task: DbTask): void {
  const current = getTaskById(task.id)
  if (!current || current.execution_token !== (task.execution_token ?? null)) throw new TaskSupersededError()
  const status = current.status
  if (status === 'paused') throw new TaskPausedError()
  if (status === 'cancelled') throw new TaskCancelledError()
  if (status !== 'running') throw new TaskSupersededError()
}

function getTaskController(task: DbTask): AbortController | undefined {
  const active = activeTaskControllers.get(task.id)
  if (!active || active.token !== task.execution_token) return undefined
  return active.controller
}

/** Abort only the controller that belonged to the pre-transition attempt. */
function abortTaskController(taskId: string, token: string | null): void {
  const active = activeTaskControllers.get(taskId)
  if (!active) return
  // A null token means the row was pending/unclaimed; any controller for this
  // task is stale and safe to abort. Otherwise preserve a newer controller.
  if (token === null || active.token === token) active.controller.abort()
}

function updateOwnedTaskProgress(task: DbTask, progress: number): boolean {
  const token = task.execution_token
  if (!token || !updateTaskProgressIfOwned(task.id, token, progress)) {
    // Treat a rejected checkpoint as loss of execution ownership.  This stops
    // long-running provider loops promptly instead of allowing a stale worker
    // to continue issuing remote mutations after a replacement attempt wins.
    throw new TaskSupersededError()
  }
  return true
}

function updateOwnedTaskPayload(task: DbTask, payload: unknown): boolean {
  const token = task.execution_token
  if (!token || !updateTaskPayloadIfOwned(task.id, token, payload)) {
    // Payload checkpoints (transfer results, resolved directories, etc.) are
    // part of the attempt's recovery record.  Silently dropping one after a
    // token race would let a stale worker continue with an inconsistent
    // checkpoint, so fail the attempt immediately.
    throw new TaskSupersededError()
  }
  return true
}

function notifyTaskTerminalOwned(
  task: DbTask,
  status: 'success' | 'partial_success' | 'failed',
  options: { summary?: string; errorMessage?: string } = {},
): void {
  const token = task.execution_token
  const current = getTaskById(task.id)
  // Terminal transitions retain the token as an ownership proof. Retry,
  // pause, cancel, and recovery clear it to invalidate stale workers.
  if (!token || current?.status !== status || current.execution_token !== token) return
  notifyTaskTerminal({
    id: task.id,
    title: task.title || task.task_type,
    status,
    ...options,
  })
}

async function runTaskOperation<T>(task: DbTask, kind: string, item: string, execute: () => Promise<T>): Promise<T> {
  // Check before starting an operation, never between a remote commit and its journal receipt.
  if (!isWithinTaskOperation(task)) assertTaskDispatchAllowed(task)
  return journalTaskOperation(task, kind, item, execute)
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

function taskLog(level: LogLevel, taskId: string, accountId: string, platform: string, message: string, detail?: string): void {
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
  log[level](`[Task ${taskId}] ${message}`)
}

/** 向渲染进程推送任务进度更新（仅当前 execution token 可发送） */
function notifyTaskProgress(task: DbTask, progress: number, message?: string): void {
  if (!isTaskExecutionOwner(task)) return
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.TASK_UPDATED, { taskId: task.id, progress, message })
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
  task: DbTask,
  savedFilePaths?: string[],
): Promise<string[] | null> {
  // Filtering is a destructive post-processing step.  Check ownership before
  // every provider call so an old worker cannot delete files created by a
  // newer retry attempt after pause/resume or recovery.
  throwIfTaskCancelled(task)
  const keywords = getBannedKeywords()
  if (keywords.length === 0 || savedFileIds.length === 0) return savedFileIds

  const adapter = guardTaskAdapterMutations(getAdapter(account.platform))
  const adIndices: number[] = []
  const cleanIndices: number[] = []
  // Keep every name/path aligned with the provider-confirmed destination IDs.
  // A directory listing may supply metadata, but must never expand this set.
  const alignedPaths = savedFilePaths?.length === savedFileIds.length ? savedFilePaths : undefined
  const deleteTargets = savedFileIds.map((id, i) => account.platform === 'baidu'
    ? alignedPaths?.[i] || (id.startsWith('/') ? id : undefined)
    : id)

  // 如果有文件名列表且长度匹配，直接用文件名匹配
  if (savedFileNames.length === savedFileIds.length && savedFileNames.every(name => name.length > 0)) {
    for (let i = 0; i < savedFileNames.length; i++) {
      const name = savedFileNames[i] || ''
      if (containsAdKeyword(name, keywords) && deleteTargets[i]) {
        adIndices.push(i)
      } else {
        cleanIndices.push(i)
      }
    }
  } else {
    // 没有文件名列表时，尝试列出目标目录获取文件名
    try {
      throwIfTaskCancelled(task)
      // Each adapter normalizes its own root directory identifier.
      const listResult = await adapter.listFiles(account, targetDirId)
      throwIfTaskCancelled(task)
      const filesById = new Map(listResult.files.map(file => [file.id, file]))
      if (account.platform === 'baidu') {
        for (const file of listResult.files) {
          if (file.raw?.fs_id != null) filesById.set(String(file.raw.fs_id), file)
        }
      }
      for (let i = 0; i < savedFileIds.length; i++) {
        const file = filesById.get(savedFileIds[i])
        if (file && account.platform === 'baidu') {
          deleteTargets[i] = file.path || (file.id.startsWith('/') ? file.id : undefined)
        }
        // Missing/late metadata is not evidence that an existing file belongs
        // to this transfer. Leave unmatched saved IDs untouched.
        if (file && containsAdKeyword(file.name, keywords) && deleteTargets[i]) {
          adIndices.push(i)
        } else {
          cleanIndices.push(i)
        }
      }
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      // 列出文件失败，跳过广告过滤
      return savedFileIds
    }
  }

  if (adIndices.length === 0) {
    return savedFileIds // 没有广告文件
  }

  // 构建要删除的文件 ID 列表
  // 百度需要用文件路径删除，夸克用 fid 删除
  const adFileIdsToDelete = adIndices.map((i) => deleteTargets[i]!)

  // 尝试删除广告文件
  try {
    throwIfTaskCancelled(task)
    await adapter.delete(account, adFileIdsToDelete)
    throwIfTaskCancelled(task)
    taskLog('info', task.id, task.account_id, task.platform,
      `广告过滤: 删除了 ${adIndices.length} 个广告文件`)
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err
    taskLog('warn', task.id, task.account_id, task.platform,
      `广告过滤: 删除广告文件失败 — ${sanitizeError(err)}`)
    // 删除失败不阻断流程，返回原始列表
    return savedFileIds
  }

  // 如果所有文件都是广告
  if (cleanIndices.length === 0) {
    throwIfTaskCancelled(task)
    taskLog('warn', task.id, task.account_id, task.platform,
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
  task: DbTask,
  fileIds: string[],
  shareOptions?: ShareTaskPayload['options'],
  savedFilePaths?: string[],
  targetDirId?: string,
): Promise<void> {
  // Auto-share is a separate remote mutation.  Do not let a superseded
  // transfer attempt create or persist a share for the replacement attempt.
  throwIfTaskCancelled(task)
  const adapter = guardTaskAdapterMutations(getAdapter(account.platform))
  if (!adapter.createShare) {
    taskLog('warn', task.id, task.account_id, account.platform,
      '自动分享: 当前平台不支持分享功能')
    return
  }

  // 百度按路径列目录，但分享使用 fs_id；两者必须仍属于过滤后保留的目标文件。
  let shareFileIds = fileIds
  if (account.platform === 'baidu' && savedFilePaths && savedFilePaths.length > 0) {
    // 通过列出目标目录获取转存后的文件 fs_id
    try {
      const listDir = targetDirId && targetDirId !== '0' ? targetDirId : '/'
      const dirList = await adapter.listFiles(account, listDir)
      throwIfTaskCancelled(task)
      const pathSet = new Set(savedFilePaths)
      const idSet = new Set(fileIds)
      const matchedFiles = dirList.files.filter((f) => pathSet.has(f.path || f.id)
        && idSet.has(f.raw?.fs_id != null ? String(f.raw.fs_id) : f.id))
      if (matchedFiles.length > 0) {
        const matchedIds = new Set(matchedFiles.map((f) => f.raw?.fs_id != null ? String(f.raw.fs_id) : f.id))
        shareFileIds = fileIds.filter(id => matchedIds.has(id))
        taskLog('info', task.id, task.account_id, account.platform,
          `自动分享: 通过目录列表匹配到 ${matchedFiles.length} 个文件的 fs_id`)
      } else {
        taskLog('warn', task.id, task.account_id, account.platform,
          '自动分享: 无法确认转存后的文件 fs_id，已跳过分享')
        return
      }
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      taskLog('warn', task.id, task.account_id, account.platform,
        `自动分享: 获取转存后 fs_id 失败 — ${sanitizeError(err)}，已跳过分享`)
      return
    }
  }

  // 构建分享项目列表
  const items = shareFileIds.map((fid) => ({
    fileId: fid,
    name: '',
    raw: account.platform === 'baidu' ? { fs_id: fid } : undefined,
  }))

  const options = shareOptions || { expireDays: 0 } // 默认永久

  let createdShareId: string | undefined
  let persistedShare = false
  try {
    throwIfTaskCancelled(task)
    taskLog('info', task.id, task.account_id, account.platform,
      `自动分享: 开始分享 ${shareFileIds.length} 个文件`)

    const shareInfo = await adapter.createShare!(account, items, options)
    createdShareId = shareInfo.id
    throwIfTaskCancelled(task)

    // 保存分享链接到数据库
    insertShareLink({
      id: shareInfo.id,
      account_id: task.account_id,
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
    persistedShare = true

    taskLog('info', task.id, task.account_id, account.platform,
      `自动分享成功: ${shareInfo.shareUrl}${shareInfo.password ? ` (密码: ${shareInfo.password})` : ''}`)
  } catch (err) {
    // If ownership is lost after the provider has created a share but before
    // it is persisted locally, revoke that share so a cancelled/superseded
    // attempt cannot leave an orphaned public link behind.
    if (!persistedShare && createdShareId && adapter.cancelShare) {
      try {
        await adapter.cancelShare(account, createdShareId)
      } catch (cleanupError) {
        taskLog('warn', task.id, task.account_id, account.platform,
          `自动分享: 清理孤立分享失败 — ${sanitizeError(cleanupError)}`)
      }
    }
    if (err instanceof TaskCancelledError) throw err
    taskLog('error', task.id, task.account_id, account.platform,
      `自动分享失败: ${sanitizeError(err)}`)
    // 分享失败不阻断转存流程
  }
}

// ── Task execution ──

async function runRenameTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  const payload = JSON.parse(task.payload) as {
    items: { fileId: string; path?: string; newName: string }[]
  }

  const total = payload.items.length
  let completed = 0

  for (const item of payload.items) {
    throwIfTaskCancelled(task)
    const identifier = item.path || item.fileId
    taskLog('info', task.id, task.account_id, task.platform, `Renaming: ${identifier} → ${item.newName}`)
    await adapter.rename(account, identifier, item.newName)
    throwIfTaskCancelled(task)
    completed++
    updateOwnedTaskProgress(task, Math.round((completed / total) * 100))
  }
}

async function runMoveTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')
  throwIfTaskCancelled(task)

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  const payload = JSON.parse(task.payload) as {
    items: { fileId: string; path?: string }[]
    targetDirId: string
    targetPath?: string
  }

  const identifiers = payload.items.map((item) => item.path || item.fileId)
  taskLog('info', task.id, task.account_id, task.platform, `Moving ${identifiers.length} items to ${payload.targetPath || payload.targetDirId}`)
  await adapter.move(account, identifiers, payload.targetDirId)
  throwIfTaskCancelled(task)
  updateOwnedTaskProgress(task, 100)
}

async function runDeleteTask(task: DbTask): Promise<void> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')
  throwIfTaskCancelled(task)

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  const payload = JSON.parse(task.payload) as {
    items: { fileId: string; path?: string }[]
  }

  const identifiers = payload.items.map((item) => item.path || item.fileId)
  taskLog('info', task.id, task.account_id, task.platform, `Deleting ${identifiers.length} items`)
  await adapter.delete(account, identifiers)
  throwIfTaskCancelled(task)
  updateOwnedTaskProgress(task, 100)
}

async function runShareTask(task: DbTask): Promise<TaskRunOutcome> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')
  throwIfTaskCancelled(task)

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  if (!adapter.createShare) {
    throw new Error(`${task.platform} 不支持分享功能`)
  }

  const payload = JSON.parse(task.payload) as ShareTaskPayload
  const total = payload.items.length
  let completed = 0
  let failedCount = 0
  let lastError: unknown = null

  taskLog('info', task.id, task.account_id, task.platform, `开始分享 ${total} 个文件`)

  // All supported adapters accept a batch of file IDs, so combined mode must
  // stay combined all the way to the provider API.
  const needsPerItemShare = false

  if (needsPerItemShare) {
    // 逐个文件分享（参考 BaiduPanFilesTransfers 每个文件调用一次 create_share）
    for (const item of payload.items) {
      throwIfTaskCancelled(task)
      try {
        const shareInfo = await runTaskOperation(task, '创建分享', item.fileId, () =>
          adapter.createShare!(account, [item], payload.options))
        throwIfTaskCancelled(task)

        // Save share link to DB
        try {
          throwIfTaskCancelled(task)
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
          throwIfTaskCancelled(task)
        } catch (dbErr) {
          if (dbErr instanceof TaskCancelledError) throw dbErr
          taskLog('error', task.id, task.account_id, task.platform, `保存分享记录失败: ${String(dbErr)}`)
        }

        completed++
        updateOwnedTaskProgress(task, Math.round((completed / total) * 100))
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
        failedCount++
        lastError = err
        updateOwnedTaskProgress(task, Math.round(((completed + failedCount) / total) * 100))
      }
    }
  } else {
    // 一次性分享所有文件（夸克、UC等支持多文件分享）
    const shareInfo = await runTaskOperation(task, '创建分享', JSON.stringify(payload.items.map(item => item.fileId)), () =>
      adapter.createShare!(account, payload.items, payload.options))
    throwIfTaskCancelled(task)

    // Save share link to DB
    try {
      throwIfTaskCancelled(task)
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
      throwIfTaskCancelled(task)
      taskLog('info', task.id, task.account_id, task.platform, `分享记录已保存`)
    } catch (dbErr) {
      if (dbErr instanceof TaskCancelledError) throw dbErr
      taskLog('error', task.id, task.account_id, task.platform, `保存分享记录失败: ${String(dbErr)}`)
    }

    completed = total
    updateOwnedTaskProgress(task, Math.round((completed / total) * 100))
    taskLog('info', task.id, task.account_id, task.platform,
      `分享成功: ${shareInfo.shareUrl}${shareInfo.password ? ` (密码: ${shareInfo.password})` : ''}`)
  }
  if (failedCount > 0 && completed === 0) throw lastError || new Error('全部分享失败')
  if (failedCount > 0) return { partial: true, summary: `${completed} 成功，${failedCount} 失败` }
  return {}
}

async function runTransferTask(task: DbTask): Promise<TaskRunOutcome> {
  const account = dbTaskToAccount(task)
  if (!account) throw new Error('Account not found for task')

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  if (!adapter.saveSharedFiles) {
    throw new Error(`${task.platform} 不支持转存功能`)
  }

  const payload = JSON.parse(task.payload) as TransferTaskPayload & { transferRecordIds?: Record<string, string> }
  const total = payload.links.length
  let completed = 0

  taskLog('info', task.id, task.account_id, task.platform, `开始转存 ${total} 个分享链接`)

  let failedCount = 0
  let lastError: unknown = null

  for (const link of payload.links) {
    throwIfTaskCancelled(task)
    assertTaskDispatchAllowed(task)
    const existingRecordId = payload.transferRecordIds?.[link.url]
    const recordId = existingRecordId || generateId()
    const ts = now()

    // Reuse the receipt row when a scheduled task resumes its post-processing.
    if (!existingRecordId) {
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
      payload.transferRecordIds = { ...payload.transferRecordIds, [link.url]: recordId }
      updateOwnedTaskPayload(task, payload)
    }

    try {
      taskLog('info', task.id, task.account_id, task.platform, `转存: ${link.url}`)
      const result = await runTaskOperation(task, '分享转存', link.url, async () => {
        const saved = await adapter.saveSharedFiles!(account, link, payload.targetDirId || '0')
        if (!saved.success) throw new Error(saved.error || '转存失败')
        // Older durable results may contain source share IDs. Stamp only a
        // fresh adapter result; never upgrade a replay or resend the save.
        return { ...saved, postprocessTargetIdsVersion: 1 as const }
      })
      throwIfTaskCancelled(task)
      markTransferRecordSuccess(recordId, result.savedCount || 0)

      // ── 广告过滤（参考 xinyue-search 转存后扫描删除广告文件） ──
      let finalFileIds = result.postprocessTargetIdsVersion === 1 ? result.savedFileIds || [] : []
      if (result.postprocessTargetIdsVersion !== 1) {
        taskLog('warn', task.id, task.account_id, task.platform,
          '转存后处理: 旧任务结果无法确认目标文件 ID，已跳过广告过滤和自动分享')
      }
      if (finalFileIds.length > 0) {
        const filtered = await runTaskOperation(task, '转存广告过滤', link.url, () => filterAdFiles(
          account, finalFileIds, result.savedFileNames || [],
          payload.targetDirId || '0', task, result.savedFilePaths,
        ))
        if (filtered === null) {
          // 所有文件都是广告，标记转存失败
          throwIfTaskCancelled(task)
          markTransferRecordFailed(recordId, '所有文件都包含广告关键词，已全部删除')
          failedCount++
          continue
        }
        finalFileIds = filtered
      }

      throwIfTaskCancelled(task)
      markTransferRecordSuccess(recordId, result.savedCount || 0)
      throwIfTaskCancelled(task)

      // ── 转存后自动分享（参考 xinyue-search 转存→分享一体化流程） ──
      if (payload.autoShare && finalFileIds.length > 0) {
        const retainedIds = new Set(finalFileIds)
        const finalFilePaths = result.savedFilePaths?.length === result.savedFileIds?.length
          ? result.savedFilePaths?.filter((_, i) => retainedIds.has(result.savedFileIds![i]))
          : undefined
        await runTaskOperation(task, '自动分享', link.url, () =>
          autoShareAfterTransfer(account, task, finalFileIds, payload.shareOptions, finalFilePaths, payload.targetDirId))
      } else if (payload.autoShare && finalFileIds.length === 0 && result.postprocessTargetIdsVersion === 1) {
        taskLog('warn', task.id, task.account_id, task.platform,
          '自动分享: 转存接口未返回已确认的目标文件 ID，已跳过分享')
      }
      completed++
      const progress = Math.round((completed / total) * 100)
      updateOwnedTaskProgress(task, progress)
      notifyTaskProgress(task, progress, `转存成功: ${completed}/${total}`)
      taskLog('info', task.id, task.account_id, task.platform, `转存成功: ${link.url} (${result.savedCount || 0} 个文件)`)
    } catch (err) {
      if (err instanceof TaskScheduleDeferredError) throw err
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
  if (completed > 0) {
    throwIfTaskCancelled(task)
    invalidateFilesCacheParents(task.account_id, [payload.targetDirId || '0'])
  }
  if (failedCount > 0 && completed === 0) {
    // All links failed — throw to trigger retry or permanent failure
    throw lastError || new Error(`全部 ${failedCount} 个链接转存失败`)
  }
  if (failedCount > 0) {
    taskLog('warn', task.id, task.account_id, task.platform, `批量转存部分完成: ${completed} 成功, ${failedCount} 失败`)
    return { partial: true, summary: `${completed} 成功，${failedCount} 失败` }
  }
  if (payload.subscriptionSync) {
    markShareSubscriptionSynced(
      payload.subscriptionSync.subscriptionId,
      payload.subscriptionSync.signature,
      payload.subscriptionSync.seenFileIds,
    )
  }
  return {}
}

// ── Upload task ──

interface TaskRunOutcome {
  partial?: boolean
  summary?: string
}

function saveTransferResult(
  task: DbTask,
  payload: UploadTaskPayload | DownloadTaskPayload,
  result: TransferItemResult,
): void {
  payload.results ||= []
  const index = payload.results.findIndex((item) => item.key === result.key)
  if (index >= 0) payload.results[index] = result
  else payload.results.push(result)
  updateOwnedTaskPayload(task, payload)
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

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
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
    throwIfTaskCancelled(task)
    let entries = remoteEntries.get(parentId)
    if (!entries) {
      entries = (await adapter.listFiles(account, parentId)).files
      throwIfTaskCancelled(task)
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

      const resolvedParent = await runTaskOperation(task, '创建目录', requestedPath, async () => {
        const entries = await getEntries(parentId)
        throwIfTaskCancelled(task)
        let actualName = segment
        const existing = entries.find((entry) => entry.name === actualName)
        if (existing?.isDir) {
          if (conflictPolicy === 'rename') {
            actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
            throwIfTaskCancelled(task)
            const created = await adapter.mkdir(account, parentId, actualName)
            throwIfTaskCancelled(task)
            entries.push(created)
            parentId = created.id
          } else {
            parentId = existing.id
          }
        } else {
          if (existing && conflictPolicy === 'skip') return null
          if (existing && conflictPolicy === 'overwrite') {
            throwIfTaskCancelled(task)
            await adapter.delete(account, [existing.id])
            throwIfTaskCancelled(task)
            entries.splice(entries.indexOf(existing), 1)
          } else if (existing || conflictPolicy === 'rename') {
            actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
          }
          throwIfTaskCancelled(task)
          const created = await adapter.mkdir(account, parentId, actualName)
          throwIfTaskCancelled(task)
          entries.push(created)
          parentId = created.id
        }
        return parentId
      })
      if (!resolvedParent) return null
      parentId = resolvedParent
      directoryIds.set(requestedPath, parentId)
      payload.remoteDirectoryIds = Object.fromEntries(directoryIds)
      updateOwnedTaskPayload(task, payload)
    }
    return parentId
  }

  taskLog('info', task.id, task.account_id, task.platform, `开始上传 ${totalFiles} 个文件，总大小: ${formatFileSize(totalSize)}`)

  for (const file of payload.files) {
    throwIfTaskCancelled(task)
    const key = file.localPath
    if (finishedKeys.has(key)) continue
    try {
      await runTaskOperation(task, '上传文件', key, async () => {
        const relativePath = normalizeRelativePath(file.relativePath || file.fileName)
        const remoteDirId = await ensureDirectory(path.dirname(relativePath))
        if (!remoteDirId) {
          completedFiles++
          completedSize += file.fileSize
          saveTransferResult(task, payload, { key, name: file.fileName, status: 'skipped' })
          taskLog('warn', task.id, task.account_id, task.platform, `跳过上传（目录冲突）: ${relativePath}`)
          return
        }

        const entries = await getEntries(remoteDirId)
        let uploadName = path.basename(relativePath)
        const existing = entries.find((entry) => entry.name === uploadName)
        if (existing) {
          if (conflictPolicy === 'skip') {
            completedFiles++
            completedSize += file.fileSize
            saveTransferResult(task, payload, { key, name: file.fileName, status: 'skipped' })
            taskLog('warn', task.id, task.account_id, task.platform, `跳过同名文件: ${relativePath}`)
            return
          }
          if (conflictPolicy === 'overwrite') {
            if (existing.isDir) throw new Error(`无法用文件覆盖远端目录: ${relativePath}`)
            throwIfTaskCancelled(task)
            await adapter.delete(account, [existing.id])
            throwIfTaskCancelled(task)
            entries.splice(entries.indexOf(existing), 1)
          } else {
            uploadName = chooseAvailableName(uploadName, false, (candidate) => entries.some((entry) => entry.name === candidate))
          }
        }

        taskLog('info', task.id, task.account_id, task.platform, `正在上传: ${relativePath} (${formatFileSize(file.fileSize)})`)

        const result = await adapter.upload!(account, file.localPath, remoteDirId, {
          signal: getTaskController(task)?.signal,
          fileName: uploadName,
          overwrite: conflictPolicy === 'overwrite',
          onProgress: (progress) => {
            if (isTaskCancelled(task)) return
            const totalProgress = calculateTransferProgress({
              completedBytes: completedSize,
              currentLoaded: Math.min(progress.loaded, file.fileSize),
              totalBytes: totalSize,
              completedFiles,
              currentPercent: progress.percent,
              totalFiles,
            })

            updateOwnedTaskProgress(task, totalProgress)
            notifyTaskProgress(task, totalProgress, `正在上传: ${file.fileName} (${progress.percent}%)`)
          },
        })
        throwIfTaskCancelled(task)

        if (result.success) {
          completedFiles++
          completedSize += file.fileSize
          entries.push({ id: result.fileId || `uploaded:${key}`, parentId: remoteDirId, name: uploadName, isDir: false, size: file.fileSize, createdAt: Date.now(), updatedAt: Date.now(), platform: account.platform, accountId: account.id })
          saveTransferResult(task, payload, { key, name: file.fileName, status: 'success', outputPath: path.join(path.dirname(relativePath), uploadName) })
          taskLog('info', task.id, task.account_id, task.platform, `上传成功: ${relativePath} -> ${result.fileId || 'unknown'}`)
        } else {
          throw new Error(result.error || '上传失败')
        }
      })
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveTransferResult(task, payload, { key, name: file.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `上传异常: ${file.fileName} - ${sanitizeError(err)}`)
      // 继续处理其他文件，不中断
    }
  }

  // 更新最终进度
  throwIfTaskCancelled(task)
  invalidateFilesCacheParents(task.account_id, [payload.targetDirId])
  updateOwnedTaskProgress(task, 100)
  notifyTaskProgress(task, 100, `上传完成: ${completedFiles}/${totalFiles} 个文件`)

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

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  if (!adapter.download) {
    throw new Error(`${task.platform} 暂不支持下载功能`)
  }

  const conflictPolicy = normalizeConflictPolicy(payload.conflictPolicy, payload.overwrite)
  const expandedFiles: Array<{ fileId: string; fileName: string; fileSize: number; relativePath: string; key: string; sourceParentId?: string }> = []
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
    updateOwnedTaskPayload(task, payload)
    return outputName
  }

  const walkDirectory = async (directoryId: string, relativeDir: string, ancestors: Set<string>): Promise<void> => {
    throwIfTaskCancelled(task)
    if (ancestors.has(directoryId)) throw new Error('云端目录结构包含循环引用')
    const nextAncestors = new Set(ancestors).add(directoryId)
    const localDir = resolvePathInside(payload.targetDirPath, relativeDir)
    if (fs.existsSync(localDir) && !fs.statSync(localDir).isDirectory()) {
      if (conflictPolicy !== 'overwrite') throw new Error(`本地目录路径已被文件占用: ${relativeDir}`)
      fs.unlinkSync(localDir)
    }
    fs.mkdirSync(localDir, { recursive: true })
    const entries = (await adapter.listFiles(account, directoryId)).files
    throwIfTaskCancelled(task)
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
        expandedFiles.push({ fileId: entry.id, fileName: entry.name, fileSize: entry.size || 0, relativePath: childRelative, key: `${entry.id}:${childRelative}`, sourceParentId: directoryId })
      }
    }
  }

  for (const file of payload.files) {
    throwIfTaskCancelled(task)
    const relativeRoot = allocateTopRoot(file)
    if (!relativeRoot) {
      saveTransferResult(task, payload, { key: file.fileId, name: file.fileName, status: 'skipped' })
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
    assertTaskDispatchAllowed(task)
    throwIfTaskCancelled(task)
    if (finishedKeys.has(file.key)) continue
    try {
      let localPath = resolvePathInside(payload.targetDirPath, file.relativePath)
      if (fs.existsSync(localPath)) {
        if (conflictPolicy === 'skip') {
          completedFiles++
          completedSize += file.fileSize
          saveTransferResult(task, payload, { key: file.key, name: file.fileName, status: 'skipped', outputPath: localPath })
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

      const downloadSignal = getTaskController(task)?.signal
      const downloadProgress = (progress: { loaded: number; percent: number }) => {
        if (isTaskCancelled(task)) return
        const totalProgress = calculateTransferProgress({
          completedBytes: completedSize,
          currentLoaded: Math.min(progress.loaded, file.fileSize),
          totalBytes: totalSize,
          completedFiles,
          currentPercent: progress.percent,
          totalFiles,
        })

        updateOwnedTaskProgress(task, totalProgress)
        notifyTaskProgress(task, totalProgress, `正在下载: ${file.fileName} (${progress.percent}%)`)
      }

      await downloadTransferFile({
        task,
        account,
        adapter,
        fileId: file.fileId,
        localPath,
        fileSize: file.fileSize,
        overwrite: conflictPolicy === 'overwrite',
        sourceParentId: file.sourceParentId,
        signal: downloadSignal,
        onProgress: (progress) => downloadProgress({ loaded: progress.loaded, percent: progress.percent }),
      })
      throwIfTaskCancelled(task)

      completedFiles++
      completedSize += file.fileSize
      saveTransferResult(task, payload, { key: file.key, name: file.fileName, status: 'success', outputPath: localPath })
      taskLog('info', task.id, task.account_id, task.platform, `下载成功: ${file.fileName} -> ${localPath}`)
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveTransferResult(task, payload, { key: file.key, name: file.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `下载异常: ${file.fileName} - ${sanitizeError(err)}`)
      // 继续处理其他文件，不中断
    }
  }

  // 更新最终进度
  updateOwnedTaskProgress(task, 100)
  notifyTaskProgress(task, 100, `下载完成: ${completedFiles}/${totalFiles} 个文件`)

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
  sourceParentId?: string
  hash?: { algorithm: 'md5' | 'sha1'; value: string }
}

function saveCloudTransferResult(task: DbTask, payload: CloudTransferTaskPayload, result: TransferItemResult): void {
  payload.results ||= []
  const index = payload.results.findIndex((item) => item.key === result.key)
  if (index >= 0) payload.results[index] = result
  else payload.results.push(result)
  updateOwnedTaskPayload(task, payload)
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
    throwIfTaskCancelled(task)
    if (ancestors.has(directoryId)) throw new Error('云端目录结构包含循环引用')
    if (++discovered > 10_000) throw new Error('单次迁移最多包含 10000 个项目')
    directories.push({ relativePath, key: `dir:${relativePath}` })
    const entries = (await sourceAdapter.listFiles(sourceAccount, directoryId)).files
    throwIfTaskCancelled(task)
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
          hash: extractSourceHash(sourceAccount.platform, entry.raw),
          sourceParentId: directoryId,
        })
      }
    }
  }

  for (const item of payload.files) {
    throwIfTaskCancelled(task)
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
        hash: item.hash ?? extractSourceHash(sourceAccount.platform, (item as { raw?: unknown }).raw),
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
  throwIfTaskCancelled(task)
  const entries = (await sourceAdapter.listFiles(sourceAccount, payload.targetDirId)).files
  throwIfTaskCancelled(task)
  const finishedKeys = cloudTransferFinishedKeys(payload)
  let completed = payload.files.filter((item) => finishedKeys.has(item.fileId)).length
  let failedCount = 0
  let lastError: Error | null = null

  for (const item of payload.files) {
    throwIfTaskCancelled(task)
    if (finishedKeys.has(item.fileId)) continue
    const existing = entries.find((entry) => entry.name === item.fileName)
    try {
      await runTaskOperation(task, '云端复制', item.fileId, async () => {
        throwIfTaskCancelled(task)
        if (existing && payload.conflictPolicy === 'skip') {
          saveCloudTransferResult(task, payload, { key: item.fileId, name: item.fileName, status: 'skipped' })
          completed++
          return
        }
        if (existing && payload.conflictPolicy === 'overwrite') {
          if (existing.id === item.fileId) throw new Error('不能在原目录中覆盖迁移源文件')
          throwIfTaskCancelled(task)
          await sourceAdapter.delete(sourceAccount, [existing.id])
          throwIfTaskCancelled(task)
          entries.splice(entries.indexOf(existing), 1)
        }
        throwIfTaskCancelled(task)
        await sourceAdapter.copy!(sourceAccount, [item.fileId], payload.targetDirId)
        throwIfTaskCancelled(task)
        saveCloudTransferResult(task, payload, { key: item.fileId, name: item.fileName, status: 'success' })
        completed++
        taskLog('info', task.id, task.account_id, task.platform, `云端复制成功: ${item.fileName}`)
      })
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveCloudTransferResult(task, payload, { key: item.fileId, name: item.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `云端复制失败: ${item.fileName} — ${sanitizeError(err)}`)
    }
    updateOwnedTaskProgress(task, Math.round(((completed + failedCount) / payload.files.length) * 100))
  }

  throwIfTaskCancelled(task)
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
  throwIfTaskCancelled(task)
  const entries = (await targetAdapter.listFiles(targetAccount, payload.targetDirId)).files
  throwIfTaskCancelled(task)
  const finishedKeys = cloudTransferFinishedKeys(payload)
  let completed = payload.files.filter((item) => finishedKeys.has(item.fileId)).length
  let failedCount = 0
  let lastError: Error | null = null

  for (const item of payload.files) {
    throwIfTaskCancelled(task)
    if (finishedKeys.has(item.fileId)) continue
    const existing = entries.find((entry) => entry.name === item.fileName)
    let temporaryShareId: string | undefined
    try {
      await runTaskOperation(task, '云端转存', item.fileId, async () => {
        throwIfTaskCancelled(task)
        if (existing && payload.conflictPolicy === 'skip') {
          saveCloudTransferResult(task, payload, { key: item.fileId, name: item.fileName, status: 'skipped' })
          completed++
          return
        }
        let requestedName = item.fileName
        if (existing && payload.conflictPolicy === 'rename') {
          requestedName = chooseAvailableName(item.fileName, item.isDir, (candidate) => entries.some((entry) => entry.name === candidate))
        }
        if (existing && payload.conflictPolicy === 'overwrite') {
          if (sourceAccount.id === targetAccount.id && existing.id === item.fileId) {
            throw new Error('不能在原目录中覆盖迁移源文件')
          }
          throwIfTaskCancelled(task)
          await targetAdapter.delete(targetAccount, [existing.id])
          throwIfTaskCancelled(task)
          entries.splice(entries.indexOf(existing), 1)
        }
        throwIfTaskCancelled(task)
        const share = await sourceAdapter.createShare!(sourceAccount, [{
          fileId: item.fileId,
          name: item.fileName,
          isDir: item.isDir,
          path: item.path,
        }], { title: item.fileName })
        temporaryShareId = share.id
        throwIfTaskCancelled(task)
        const result = await targetAdapter.saveSharedFiles!(targetAccount, { url: share.shareUrl, password: share.password }, payload.targetDirId)
        throwIfTaskCancelled(task)
        if (!result.success) throw new Error(result.error || '云端转存失败')
        // 转存用的临时分享完成使命后立即失效，避免内容以公开链接形式残留
        const cancelShare = sourceAdapter.cancelShare
        if (temporaryShareId && cancelShare) {
          try {
            await cancelShare(sourceAccount, temporaryShareId)
          } catch (error) {
            taskLog('warn', task.id, task.account_id, task.platform, `迁移后取消临时分享失败（不影响迁移结果）: ${sanitizeError(error)}`)
          } finally {
            temporaryShareId = undefined
          }
        }
        if (requestedName !== item.fileName) {
          throwIfTaskCancelled(task)
          const refreshedEntries = (await targetAdapter.listFiles(targetAccount, payload.targetDirId)).files
          throwIfTaskCancelled(task)
          const savedIds = new Set((result.savedFileIds || []).map((id) => String(id)))
          const candidate = refreshedEntries.find((entry) =>
            savedIds.has(String(entry.id)) || (entry.name === item.fileName && (!existing || entry.id !== existing.id)))
          if (candidate && candidate.name !== requestedName) {
            throwIfTaskCancelled(task)
            await targetAdapter.rename(targetAccount, candidate.id, requestedName)
            throwIfTaskCancelled(task)
          }
          entries.splice(0, entries.length, ...refreshedEntries.map((entry) => (
            candidate && entry.id === candidate.id ? { ...entry, name: requestedName } : entry
          )))
        }
        saveCloudTransferResult(task, payload, { key: item.fileId, name: item.fileName, status: 'success' })
        completed++
        taskLog('info', task.id, task.account_id, task.platform, `云端迁移成功: ${item.fileName}`)
      })
    } catch (err) {
      // Cleanup belongs to this attempt's own temporary share and is safe even
      // after ownership is lost.  It also prevents a failed/cancelled transfer
      // from leaving an unintended public link behind.
      if (temporaryShareId && sourceAdapter.cancelShare) {
        try {
          await sourceAdapter.cancelShare(sourceAccount, temporaryShareId)
        } catch (cleanupError) {
          taskLog('warn', task.id, task.account_id, task.platform, `迁移失败后取消临时分享失败: ${sanitizeError(cleanupError)}`)
        }
      }
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveCloudTransferResult(task, payload, { key: item.fileId, name: item.fileName, status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `云端迁移失败: ${item.fileName} — ${sanitizeError(err)}`)
    }
    updateOwnedTaskProgress(task, Math.round(((completed + failedCount) / payload.files.length) * 100))
  }

  throwIfTaskCancelled(task)
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
  const uploadToTarget = targetAdapter.upload.bind(targetAdapter)

  const expanded = await expandCloudTransferFiles(task, payload, sourceAdapter, sourceAccount)
  // 临时目录可配置；按最大单文件预估占用，空间不足直接报错而不是传一半失败
  const tempRoot = getTransferTempRoot()
  const peakFileBytes = expanded.files.reduce((max, item) => Math.max(max, item.fileSize), 0)
  if (peakFileBytes > 0) {
    try {
      const stats = fs.statfsSync(tempRoot)
      const freeBytes = stats.bsize * stats.bavail
      if (freeBytes < peakFileBytes * 1.2) {
        throw new Error(`临时目录空间不足（${tempRoot}）：迁移最大单文件需约 ${formatFileSize(peakFileBytes)}，剩余仅 ${formatFileSize(freeBytes)}。可在设置中更换传输临时目录`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('临时目录空间不足')) throw error
      // statfs 在部分文件系统上不可用时跳过预检
    }
  }
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'panlite-cloud-transfer-'))
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
    throwIfTaskCancelled(task)
    let entries = targetEntries.get(parentId)
    if (!entries) {
      entries = (await targetAdapter.listFiles(targetAccount, parentId)).files
      throwIfTaskCancelled(task)
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
      const resolvedParent = await runTaskOperation(task, '创建目录', requestedPath, async () => {
        const entries = await getTargetEntries(parentId)
        throwIfTaskCancelled(task)
        let actualName = segment
        const existing = entries.find((entry) => entry.name === actualName)
        if (existing?.isDir) {
          if (payload.conflictPolicy === 'rename') {
            actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
            throwIfTaskCancelled(task)
            const created = await targetAdapter.mkdir(targetAccount, parentId, actualName)
            throwIfTaskCancelled(task)
            entries.push(created)
            parentId = created.id
          } else {
            parentId = existing.id
          }
        } else {
          if (existing && payload.conflictPolicy === 'skip') return null
          if (existing && payload.conflictPolicy === 'overwrite') {
            throwIfTaskCancelled(task)
            await targetAdapter.delete(targetAccount, [existing.id])
            throwIfTaskCancelled(task)
            entries.splice(entries.indexOf(existing), 1)
          } else if (existing || payload.conflictPolicy === 'rename') {
            actualName = chooseAvailableName(actualName, true, (candidate) => entries.some((entry) => entry.name === candidate))
          }
          throwIfTaskCancelled(task)
          const created = await targetAdapter.mkdir(targetAccount, parentId, actualName)
          throwIfTaskCancelled(task)
          entries.push(created)
          parentId = created.id
        }
        return parentId
      })
      if (!resolvedParent) return null
      parentId = resolvedParent
      directoryIds.set(requestedPath, parentId)
      payload.remoteDirectoryIds = Object.fromEntries(directoryIds)
      updateOwnedTaskPayload(task, payload)
    }
    return parentId
  }

  const updateProgress = (file: ExpandedCloudFile, phase: 'download' | 'upload', percent: number, speed = 0): void => {
    const fraction = phase === 'download' ? percent / 200 : 0.5 + percent / 200
    if (totalBytes > 0) {
      updateOwnedTaskProgress(task, Math.min(99, Math.round(((completedBytes + file.fileSize * fraction) / totalBytes) * 100)))
    } else if (allWork.length > 0) {
      updateOwnedTaskProgress(task, Math.min(99, Math.round(((completedWork + fraction) / allWork.length) * 100)))
    }
    const speedText = speed > 0 ? ` · ${formatFileSize(speed)}/s` : ''
    notifyTaskProgress(task, getTaskById(task.id)?.progress || 0, `${phase === 'download' ? '官方下载' : '官方上传'}: ${file.fileName} (${Math.round(percent)}%${speedText})`)
  }

  try {
    taskLog('info', task.id, task.account_id, task.platform,
      `开始迁移: ${sourceAccount.nickname} → ${targetAccount.nickname}，${expanded.files.length} 个文件`)

  for (const directory of expanded.directories) {
    throwIfTaskCancelled(task)
    if (finishedKeys.has(directory.key)) continue
    if (cloudTransferHasSkippedAncestor(directory.relativePath, skippedDirectories)) {
      skippedDirectories.add(directory.relativePath)
      saveCloudTransferResult(task, payload, { key: directory.key, name: path.basename(directory.relativePath), status: 'skipped' })
      completedWork++
      continue
    }
    try {
      await runTaskOperation(task, '迁移目录', directory.key, async () => {
        const targetId = await ensureTargetDirectory(directory.relativePath)
        if (!targetId) skippedDirectories.add(directory.relativePath)
        saveCloudTransferResult(task, payload, { key: directory.key, name: path.basename(directory.relativePath), status: targetId ? 'success' : 'skipped' })
        completedWork++
      })
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err
      failedCount++
      lastError = err instanceof Error ? err : new Error(String(err))
      saveCloudTransferResult(task, payload, { key: directory.key, name: path.basename(directory.relativePath), status: 'failed', error: sanitizeError(err) })
      taskLog('error', task.id, task.account_id, task.platform, `创建目标目录失败: ${directory.relativePath} — ${sanitizeError(err)}`)
    }
    updateOwnedTaskProgress(task, Math.min(99, Math.round((completedWork / allWork.length) * 100)))
  }

  // 多文件并发：每个 worker 从队列取文件；同一目标目录的"建目录/冲突处理"串行化避免竞态
  const settings = getTransferRuntimeSettings()
  const fileQueue = [...expanded.files]
  const dirLocks = new Map<string, Promise<unknown>>()
  const withDirLock = async <T>(dirKey: string, fn: () => Promise<T>): Promise<T> => {
    const previous = dirLocks.get(dirKey) ?? Promise.resolve()
    // Keep the rejection visible to the worker. Swallowing it here turns a
    // real mkdir/conflict error into an undefined result and hides the cause.
    const run = previous.then(fn, fn)
    dirLocks.set(dirKey, run)
    return run
  }
  const sharedLimiter = settings.speedLimitBps > 0 ? new RateLimiter(settings.speedLimitBps) : undefined
  let queueCursor = 0

  const runStagedWorker = async (): Promise<void> => {
    while (true) {
      throwIfTaskCancelled(task)
      const cursor = queueCursor++
      if (cursor >= fileQueue.length) return
      const file = fileQueue[cursor]
      if (finishedKeys.has(file.key)) continue
      if (cloudTransferHasSkippedAncestor(file.relativePath, skippedDirectories)) {
        saveCloudTransferResult(task, payload, { key: file.key, name: file.fileName, status: 'skipped' })
        completedWork++
        completedBytes += file.fileSize
        continue
      }

      const localPath = resolvePathInside(tempDir, file.relativePath)
      let downloadedPath = localPath
      try {
        await runTaskOperation(task, '迁移文件', file.key, async () => {
          const relativeDir = path.dirname(file.relativePath)
          // 同目录的建目录/冲突处理串行化；名字先登记占位，避免并发 worker 取到同名
          const resolved = await withDirLock(relativeDir, async () => {
            throwIfTaskCancelled(task)
            const targetDirId = await ensureTargetDirectory(relativeDir)
            if (!targetDirId) return { skip: true as const }
            const entries = await getTargetEntries(targetDirId)
            let uploadName = sanitizeFileName(path.basename(file.relativePath))
            const existing = entries.find((entry) => entry.name === uploadName)
            if (existing) {
              if (payload.conflictPolicy === 'skip') return { skip: true as const }
              if (payload.conflictPolicy === 'overwrite') {
                if (existing.isDir) throw new Error(`无法用文件覆盖远端目录: ${file.relativePath}`)
                if (sourceAccount.id === targetAccount.id && existing.id === file.fileId) {
                  throw new Error('不能在原目录中覆盖迁移源文件')
                }
                throwIfTaskCancelled(task)
                await targetAdapter.delete(targetAccount, [existing.id])
                throwIfTaskCancelled(task)
                entries.splice(entries.indexOf(existing), 1)
              } else {
                uploadName = chooseAvailableName(uploadName, false, (candidate) => entries.some((entry) => entry.name === candidate))
              }
            }
            entries.push({ id: `pending:${file.key}`, parentId: targetDirId, name: uploadName, isDir: false, size: file.fileSize, createdAt: Date.now(), updatedAt: Date.now(), platform: targetAccount.platform, accountId: targetAccount.id })
            return { skip: false as const, targetDirId, uploadName }
          })
          if (resolved.skip) {
            saveCloudTransferResult(task, payload, { key: file.key, name: file.fileName, status: 'skipped' })
            completedWork++
            completedBytes += file.fileSize
            return
          }
          const { targetDirId, uploadName } = resolved

          throwIfTaskCancelled(task)
          fs.mkdirSync(path.dirname(localPath), { recursive: true })
          taskLog('info', task.id, task.account_id, task.platform, `调用 ${sourceAccount.platform} 官方下载接口: ${file.relativePath}`)
          // 下载 + 内容校验；校验失败（截断/损坏）自动重下一次，仍失败才判该文件失败
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              await downloadTransferFile({
                task,
                account: sourceAccount,
                adapter: sourceAdapter,
                fileId: file.fileId,
                localPath,
                fileSize: file.fileSize,
                sourceParentId: file.sourceParentId,
                expectedHash: file.hash,
                signal: getTaskController(task)?.signal,
                limiter: sharedLimiter,
                onProgress: (progress) => {
                  const percent = progress.percent > 0
                    ? progress.percent
                    : file.fileSize > 0 ? progress.loaded / file.fileSize * 100 : 0
                  updateProgress(file, 'download', Math.min(100, percent), progress.speed)
                },
              })
              downloadedPath = ensureDownloadedPathInside(tempDir, localPath)
              await verifyDownloadedFile(downloadedPath, file.fileSize, file.hash)
              break
            } catch (error) {
              if (error instanceof TaskCancelledError || error instanceof ResumableSourceChangedError) throw error
              try { fs.rmSync(localPath, { force: true }) } catch { /* ignore */ }
              downloadedPath = localPath
              if (attempt === 2) throw error
              taskLog('warn', task.id, task.account_id, task.platform, `下载校验失败，自动重试: ${file.relativePath} — ${sanitizeError(error)}`)
            }
          }
          throwIfTaskCancelled(task)
          const uploadResult = await uploadToTarget(targetAccount, downloadedPath, targetDirId, {
            signal: getTaskController(task)?.signal,
            fileName: uploadName,
            overwrite: payload.conflictPolicy === 'overwrite',
            onProgress: (progress) => {
              const percent = progress.percent > 0
                ? progress.percent
                : file.fileSize > 0 ? progress.loaded / file.fileSize * 100 : 0
              updateProgress(file, 'upload', Math.min(100, percent), progress.speed)
            },
          })
          throwIfTaskCancelled(task)
          if (!uploadResult.success) throw new Error(uploadResult.error || '上传失败')

          const entries = await getTargetEntries(targetDirId)
          throwIfTaskCancelled(task)
          const pendingId = `pending:${file.key}`
          const realEntry = { id: uploadResult.fileId || `migrated:${file.key}`, parentId: targetDirId, name: uploadName, isDir: false, size: file.fileSize, createdAt: Date.now(), updatedAt: Date.now(), platform: targetAccount.platform, accountId: targetAccount.id }
          const placeholderIndex = entries.findIndex((entry) => entry.id === pendingId)
          if (placeholderIndex >= 0) entries.splice(placeholderIndex, 1, realEntry)
          else entries.push(realEntry)
          saveCloudTransferResult(task, payload, { key: file.key, name: file.fileName, status: 'success', outputPath: path.join(relativeDir, uploadName) })
          completedWork++
          completedBytes += file.fileSize
          taskLog('info', task.id, task.account_id, task.platform, `迁移成功: ${file.relativePath}`)
        })
      } catch (err) {
        if (err instanceof TaskCancelledError) throw err
        failedCount++
        lastError = err instanceof Error ? err : new Error(String(err))
        saveCloudTransferResult(task, payload, { key: file.key, name: file.fileName, status: 'failed', error: sanitizeError(err) })
        taskLog('error', task.id, task.account_id, task.platform, `迁移失败: ${file.relativePath} — ${sanitizeError(err)}`)
      } finally {
        try {
          if (fs.existsSync(downloadedPath) && fs.statSync(downloadedPath).isFile()) fs.unlinkSync(downloadedPath)
        } catch { /* ignore temporary file cleanup errors */ }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(settings.parallelFiles, Math.max(1, fileQueue.length)))
  taskLog('info', task.id, task.account_id, task.platform, `并发迁移：${workerCount} 个文件并行`)
  // allSettled is intentional: when cancellation/ownership loss rejects one
  // worker, sibling workers may still be inside provider I/O.  Waiting for
  // every worker before the finally block prevents cleanupTempDir from
  // deleting files while another worker is still reading or writing them.
  const workerResults = await Promise.allSettled(
    Array.from({ length: workerCount }, () => runStagedWorker()),
  )
  const rejectedWorker = workerResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejectedWorker) throw rejectedWorker.reason

    throwIfTaskCancelled(task)
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
  const sourceAdapter = guardTaskAdapterMutations(getAdapter(sourceAccount.platform))
  const targetAdapter = guardTaskAdapterMutations(getAdapter(targetAccount.platform))
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
  throwIfTaskCancelled(task)
  const bounded = Math.max(0, Math.min(100, Math.round(progress)))
  updateOwnedTaskProgress(task, bounded)
  notifyTaskProgress(task, bounded, message)
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

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  if (!adapter.download) throw new Error(`${task.platform} 暂不支持下载压缩包`)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-archive-extract-'))
  const signal = getTaskController(task)?.signal
  try {
    updateArchiveStage(task, 0, '准备下载压缩包')
    const downloadResult = await adapter.download(account, payload.fileId, tempDir, {
      signal,
      fileName: sanitizeFileName(payload.fileName),
      onProgress: (progress) => {
        if (!signal?.aborted) updateArchiveStage(task, progress.percent * 0.4, `下载压缩包 (${progress.percent}%)`)
      },
    })
    throwIfTaskCancelled(task)
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
    throwIfTaskCancelled(task)
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

  const adapter = guardTaskAdapterMutations(getAdapter(task.platform))
  if (!adapter.download) throw new Error(`${task.platform} 暂不支持下载文件`)
  if (!adapter.upload) throw new Error(`${task.platform} 暂不支持上传压缩包`)
  if (!payload.files.length) throw new Error('没有可压缩的文件')

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-archive-compress-'))
  const downloadDir = path.join(tempDir, 'files')
  fs.mkdirSync(downloadDir, { recursive: true })
  const signal = getTaskController(task)?.signal
  const totalBytes = payload.files.reduce((sum, file) => sum + Math.max(file.fileSize, 0), 0)
  let completedBytes = 0
  let downloadedCount = 0
  let failedCount = 0
  const failedNames: string[] = []
  const downloadedFiles: Array<{ relativePath: string; fullPath: string }> = []
  const allocatedPaths = new Set<string>()

  try {
    for (const file of payload.files) {
      throwIfTaskCancelled(task)
      const normalizedRelativePath = normalizeRelativePath(file.relativePath || file.fileName)
      const safeParts = normalizedRelativePath.split(/[\\/]/).filter(Boolean).map(sanitizeFileName)
      const relativeDirectory = safeParts.slice(0, -1).join('/')
      const baseName = safeParts[safeParts.length - 1] || sanitizeFileName(file.fileName)
      const safeName = chooseAvailableName(baseName, false, (candidate) => {
        const candidatePath = relativeDirectory ? `${relativeDirectory}/${candidate}` : candidate
        return allocatedPaths.has(candidatePath)
      })
      const archiveRelativePath = relativeDirectory ? `${relativeDirectory}/${safeName}` : safeName
      allocatedPaths.add(archiveRelativePath)
      const localTargetDir = relativeDirectory
        ? resolvePathInside(downloadDir, relativeDirectory)
        : downloadDir
      fs.mkdirSync(localTargetDir, { recursive: true })
      try {
        const result = await adapter.download!(account, file.downloadId, localTargetDir, {
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
        throwIfTaskCancelled(task)
        if (!result.success || !result.localPath) throw new Error(result.error || '下载失败')
        const localPath = ensureDownloadedPathInside(downloadDir, result.localPath)
        downloadedFiles.push({ relativePath: archiveRelativePath, fullPath: localPath })
        downloadedCount++
        completedBytes += Math.max(file.fileSize, 0)
        updateArchiveStage(task, totalBytes > 0 ? completedBytes / totalBytes * 50 : downloadedCount / payload.files.length * 50, `已下载 ${downloadedCount}/${payload.files.length} 个文件`)
      } catch (error) {
        if (error instanceof TaskCancelledError || signal?.aborted || isTaskCancelled(task)) throw error
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
    throwIfTaskCancelled(task)

    updateArchiveStage(task, 80, '正在上传压缩包')
    await runTaskOperation(task, '上传压缩包', payload.targetDirId, async () => {
      const uploadResult = await adapter.upload!(account, archivePath, payload.targetDirId, {
        signal,
        fileName: archiveFileName,
        onProgress: (progress) => {
          if (!signal?.aborted) updateArchiveStage(task, 80 + progress.percent * 0.2, `正在上传压缩包 (${progress.percent}%)`)
        },
      })
      throwIfTaskCancelled(task)
      if (!uploadResult.success) throw new Error(uploadResult.error || '压缩包上传失败')
    })

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
  // Settings may have changed after admission but before this microtask ran.
  if (taskScheduleInfo(current).waitReason) { admission.enqueue(task.id); return }
  const executionToken = crypto.randomUUID()
  // Claim the pending row atomically. If pause/cancel/retry won the race,
  // this worker must not start or later overwrite that decision.
  const started = applyTaskTransition(task.id, 'start', {
    executionToken,
    expectedExecutionToken: current.execution_token ?? null,
  })
  // A queue duplicate may observe an already-claimed `running` row. The
  // state machine reports that replay as idempotent, but it must not start a
  // second worker; only the actor that changed pending → running owns it.
  if (!started?.ok || !started.changed) return
  const controller = new AbortController()
  // Keep the claimed token on the task snapshot passed to every worker helper.
  // Never let helpers look it up from the mutable controller map.
  task.execution_token = executionToken
  activeTaskControllers.set(task.id, { token: executionToken, controller })
  if (!isTaskExecutionOwner(task)) {
    controller.abort()
    // A pause/cancel can win between the DB claim and controller setup.  Do
    // not leave an orphaned controller that could be mistaken for a later
    // execution attempt.
    const active = activeTaskControllers.get(task.id)
    if (active?.token === executionToken) activeTaskControllers.delete(task.id)
    if (getTaskById(task.id)?.status === 'cancelled') {
      await clearTaskResumeCache(task.id).catch(error => {
        if (!(error instanceof ResumableDownloadBusyError)) taskLog('warn', task.id, task.account_id, task.platform, '任务已取消，部分续传缓存暂未清理')
      })
    }
    return
  }
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
        outcome = await runShareTask(task)
        break
      case 'transfer':
      case 'batch_transfer':
        outcome = await runTransferTask(task)
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
      default: {
        const execute = getTaskExtension(task.task_type)
        if (!execute) throw new Error(`Unknown task type: ${task.task_type}`)
        outcome = await execute({
          task,
          signal: controller.signal,
          assertActive: () => throwIfTaskCancelled(task),
          operation: (kind, item, operation) => runTaskOperation(task, kind, item, operation),
          progress: (percent, summary) => {
            throwIfTaskCancelled(task)
            const progress = Math.min(99, Math.max(0, Math.round(percent)))
            updateOwnedTaskProgress(task, progress)
            notifyTaskProgress(task, progress, summary)
          },
          log: (level, message) => taskLog(level === 'debug' ? 'info' : level, task.id, task.account_id, task.platform, message),
        })
        break
      }
    }

    throwIfTaskCancelled(task)
    if (outcome?.partial) {
      const completed = applyTaskTransition(task.id, 'partial_success', {
        progress: 100,
        errorMessage: outcome.summary || '任务部分完成',
        executionToken,
        expectedExecutionToken: executionToken,
      }, executionToken)
      if (!completed?.ok || !completed.changed) return
      taskLog('warn', task.id, task.account_id, task.platform, `Task partially completed: ${outcome.summary || ''}`)
      notifyTaskTerminalOwned(task, 'partial_success', { summary: outcome.summary })
      return
    }
    const completed = applyTaskTransition(task.id, 'success', {
      progress: 100,
      errorMessage: null,
      executionToken,
      expectedExecutionToken: executionToken,
    }, executionToken)
    if (!completed?.ok || !completed.changed) return
    taskLog('info', task.id, task.account_id, task.platform, 'Task completed successfully')
    notifyTaskTerminalOwned(task, 'success')
  } catch (err) {
    if (err instanceof TaskScheduleDeferredError && isTaskExecutionOwner(task)) {
      const deferred = applyTaskTransition(task.id, 'retry', {
        executionToken: null, expectedExecutionToken: executionToken, errorMessage: null,
      }, executionToken)
      if (deferred?.ok && deferred.changed) {
        taskLog('info', task.id, task.account_id, task.platform, err.message)
        admission.enqueue(task.id)
      }
      return
    }
    if (err instanceof TaskPausedError || getTaskById(task.id)?.status === 'paused') {
      taskLog('info', task.id, task.account_id, task.platform, 'Task paused by user')
      return
    }
    if (err instanceof TaskCancelledError || isTaskCancelled(task)) {
      taskLog('info', task.id, task.account_id, task.platform, 'Task stopped after cancellation')
      return
    }
    const errorMsg = sanitizeError(err)

    // 永久性错误不重试（登录失效、链接失效、容量不足等）
    if (isPermanentError(err) || err instanceof ResumableSourceChangedError || (err as { code?: string })?.code === 'STALE_PREVIEW') {
      const failed = applyTaskTransition(task.id, 'fail', {
        errorMessage: errorMsg,
        executionToken,
        expectedExecutionToken: executionToken,
      }, executionToken)
      if (!failed?.ok || !failed.changed) return
      taskLog('error', task.id, task.account_id, task.platform, `Task failed permanently (non-retryable): ${errorMsg}`)
      notifyTaskTerminalOwned(task, 'failed', { errorMessage: errorMsg })
      return
    }

    const latest = getTaskById(task.id)
    if (latest && latest.status === 'running'
      && latest.execution_token === executionToken
      && latest.retry_count < MAX_RETRY_COUNT) {
      const retry = applyTaskTransition(task.id, 'retry', {
        incrementRetry: true,
        maxRetryCount: MAX_RETRY_COUNT,
        errorMessage: null,
        executionToken: null,
        expectedExecutionToken: executionToken,
      }, executionToken)
      if (!retry?.ok || !retry.changed) {
        // A duplicate failure handler may have consumed the final retry slot
        // between the snapshot above and our CAS.  Re-check ownership and
        // close the row as failed instead of leaving it permanently running.
        const afterRace = getTaskById(task.id)
        if (afterRace?.status === 'running'
          && afterRace.execution_token === executionToken
          && afterRace.retry_count >= MAX_RETRY_COUNT) {
          const failedAfterRace = applyTaskTransition(task.id, 'fail', {
            errorMessage: errorMsg,
            executionToken,
            expectedExecutionToken: executionToken,
          }, executionToken)
          if (failedAfterRace?.ok && failedAfterRace.changed) {
            taskLog('error', task.id, task.account_id, task.platform,
              `Task failed permanently after ${MAX_RETRY_COUNT} retries: ${errorMsg}`)
            notifyTaskTerminalOwned(task, 'failed', { errorMessage: errorMsg })
          }
        }
        return
      }
      const retryCount = (getTaskById(task.id)?.retry_count ?? latest.retry_count + 1)
      taskLog('warn', task.id, task.account_id, task.platform, `Task failed, will retry (${retryCount}/${MAX_RETRY_COUNT}): ${errorMsg}`)
      // Re-enqueue with delay
      const retryDelay = Math.min(2000 * retryCount, 10000)
      admission.enqueue(task.id, retryDelay)
    } else {
      const failed = applyTaskTransition(task.id, 'fail', {
        errorMessage: errorMsg,
        executionToken,
        expectedExecutionToken: executionToken,
      }, executionToken)
      if (!failed?.ok || !failed.changed) return
      taskLog('error', task.id, task.account_id, task.platform, `Task failed permanently after ${MAX_RETRY_COUNT} retries: ${errorMsg}`)
      notifyTaskTerminalOwned(task, 'failed', { errorMessage: errorMsg })
    }
  } finally {
    const active = activeTaskControllers.get(task.id)
    if (active?.token === executionToken) activeTaskControllers.delete(task.id)
    if (getTaskById(task.id)?.status === 'cancelled') {
      await clearTaskResumeCache(task.id).catch(error => {
        if (!(error instanceof ResumableDownloadBusyError)) taskLog('warn', task.id, task.account_id, task.platform, '任务已取消，部分续传缓存暂未清理')
      })
    }
  }
}


/** Persistent parts use trustworthy content evidence; complete fallback publishes atomically. */
export async function downloadTransferFile(options: {
  task: DbTask
  account: DriveAccount
  adapter: ReturnType<typeof getAdapter>
  fileId: string
  localPath: string
  fileSize: number
  sourceParentId?: string
  expectedHash?: { algorithm: 'md5' | 'sha1' | 'sha256'; value: string }
  overwrite?: boolean
  signal?: AbortSignal
  onProgress: (progress: { loaded: number; percent: number; speed: number }) => void
  limiter?: import('./chunked-download').RateLimiter
}): Promise<void> {
  const { task, account, adapter, fileId, localPath, fileSize, signal, onProgress, limiter } = options
  if (!adapter.download) throw new Error(`${account.platform} 暂不支持下载功能`)
  const downloadFile = adapter.download.bind(adapter)
  const settings = getTransferRuntimeSettings()
  const eligible = fileSize > 0
    && (typeof adapter.getDownloadSource === 'function' || typeof adapter.getDownloadUrl === 'function')
    && (fileSize >= CHUNK_THRESHOLD_BYTES || settings.speedLimitBps > 0)
  await accountRequestBudget.run(account.id, 'interactive', async () => {
    throwIfTaskCancelled(task)
    if (eligible) {
      const outcome = await downloadTaskResumable({
        taskId: task.id, account, adapter, fileId, targetPath: localPath, overwrite: options.overwrite, expectedHash: options.expectedHash, expectedSize: fileSize,
        assertActive: () => throwIfTaskCancelled(task), getStatus: () => { const status = getTaskById(task.id)?.status; return isTaskStatus(status) ? status : undefined },
        getFreshFile: options.sourceParentId !== undefined ? async ({ signal: sourceSignal }) => {
          sourceSignal.throwIfAborted()
          const listing = await adapter.listFiles(account, options.sourceParentId!)
          throwIfTaskCancelled(task)
          if (listing.hasMore !== false) throw new Error('源目录未完整列出，无法核对续传内容')
          const matches = listing.files.filter(file => file.id === fileId && file.accountId === account.id)
          const fresh = matches[0]
          if (matches.length !== 1 || fresh.isDir || fresh.size !== fileSize) throw new ResumableSourceChangedError()
          const hash = extractSourceHash(account.platform, fresh.raw)
          if (options.expectedHash && hash && hash.algorithm === options.expectedHash.algorithm && hash.value.toLowerCase() !== options.expectedHash.value.toLowerCase()) throw new ResumableSourceChangedError()
          return fresh
        } : undefined,
        connections: settings.parallelChunks, speedLimitBps: settings.speedLimitBps, limiter, signal, onProgress,
      })
      if (outcome.kind === 'downloaded') {
        if (outcome.reusedBytes) taskLog('info', task.id, task.account_id, task.platform, `已复用校验通过的续传分块：${formatFileSize(outcome.reusedBytes)}`)
        return
      }
      taskLog('info', task.id, task.account_id, task.platform, outcome.reason === 'identity-unavailable'
        ? '源缺少可信版本证据，改用完整下载' : '服务端不支持 Range，改用完整下载')
    }
    // Adapter downloads can truncate their target before failing. Give them an
    // owned staging directory, and publish only a verified successful result.
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    const staging = fs.mkdtempSync(path.join(path.dirname(localPath), '.panlite-download-'))
    const stagedFile = path.join(staging, path.basename(localPath))
    try {
      const result = await downloadFile(account, fileId, staging, {
        signal, fileName: path.basename(localPath),
        onProgress: progress => onProgress({ loaded: progress.loaded, percent: progress.percent, speed: progress.speed }),
      })
      throwIfTaskCancelled(task)
      if (!result.success || !result.localPath || path.resolve(result.localPath) !== path.resolve(stagedFile)) throw new Error('下载未完成或返回了目标范围外的文件')
      const stagedStat = fs.lstatSync(stagedFile)
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) throw new Error('下载产物不是普通文件')
      await verifyDownloadedFile(stagedFile, fileSize, options.expectedHash)
      throwIfTaskCancelled(task)
      if (options.overwrite) {
        if (fs.existsSync(localPath)) {
          const target = fs.lstatSync(localPath)
          if (!target.isFile() || target.isSymbolicLink()) throw new Error('下载目标不是普通文件')
        }
        fs.renameSync(stagedFile, localPath)
      } else fs.linkSync(stagedFile, localPath)
    } finally {
      const absolute = path.resolve(staging)
      if (path.dirname(absolute) === path.resolve(path.dirname(localPath)) && path.basename(absolute).startsWith('.panlite-download-')) {
        fs.rmSync(absolute, { recursive: true, force: true })
      }
    }
  }, signal)
}

function hashFileInStream(filePath: string, algorithm: 'md5' | 'sha1' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm)
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 校验下载产物：大小 + 官方哈希（若源端提供）。不匹配抛错由调用方决定重试 */
async function verifyDownloadedFile(localPath: string, expectedSize: number, hash?: { algorithm: 'md5' | 'sha1' | 'sha256'; value: string }): Promise<void> {
  const stat = fs.statSync(localPath)
  if (expectedSize > 0 && stat.size !== expectedSize) {
    throw new Error(`下载内容大小不匹配（期望 ${expectedSize} 字节，实际 ${stat.size} 字节）`)
  }
  if (hash?.value) {
    const actual = await hashFileInStream(localPath, hash.algorithm)
    if (actual.toLowerCase() !== hash.value.toLowerCase()) {
      throw new Error(`下载内容哈希不匹配（${hash.algorithm}）`)
    }
  }
}

/** 传输临时目录：设置里可指定盘符/目录，默认系统临时目录 */
export function getTransferTempRoot(): string {
  const configured = getTransferRuntimeSettings().tempDir
  if (configured) {
    fs.mkdirSync(configured, { recursive: true })
    return configured
  }
  return os.tmpdir()
}

// ── Public API ──

/** Enqueue a task for execution. */
export function enqueueTask(taskId: string): void {
  const task = getTaskById(taskId)
  if (!task) {
    log.warn('TaskRunner: task not found:', taskId)
    return
  }

  admission.enqueue(taskId)
}

/** Reconsider pending work immediately after a user changes timing or priority. */
export function refreshTaskScheduling(): void { admission.refresh() }

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
    payload: JSON.stringify(taskPayloadWithAutomationOrigin(taskType, payload)),
    status: 'pending',
    progress: 0,
    retry_count: 0,
    error_message: null,
    execution_token: null,
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

  // Transition and retry-count increment happen in one conditional UPDATE,
  // so duplicate UI submissions can enqueue at most one retry.
  const retry = applyTaskTransition(taskId, 'retry', {
    incrementRetry: true,
    progress: 0,
    errorMessage: null,
    executionToken: null,
    expectedExecutionToken: task.execution_token ?? null,
  })
  if (!retry?.ok || !retry.changed) return false
  enqueueTask(taskId)
  taskLog('info', taskId, task.account_id, task.platform, 'Task retry requested')
  return true
}

/** Cancel a task. */
export function cancelTask(taskId: string): boolean {
  const task = getTaskById(taskId)
  if (!task) return false
  if (task.status === 'success' || task.status === 'partial_success' || task.status === 'failed' || task.status === 'cancelled') return false

  const cancelled = applyTaskTransition(taskId, 'cancel', {
    errorMessage: 'Cancelled by user',
    executionToken: null,
    expectedExecutionToken: task.execution_token ?? null,
  })
  if (!cancelled?.ok || !cancelled.changed) return false
  admission.remove(taskId)
  abortTaskController(taskId, task.execution_token ?? null)
  void clearTaskResumeCache(taskId).catch(error => {
    if (!(error instanceof ResumableDownloadBusyError)) taskLog('warn', taskId, task.account_id, task.platform, '续传缓存暂未清理，已保留供后续清理')
  })
  taskLog('info', taskId, task.account_id, task.platform, 'Task cancelled by user')
  return true
}

export function pauseTask(taskId: string): boolean {
  const task = getTaskById(taskId)
  if (!task || (task.status !== 'pending' && task.status !== 'running')) return false
  const paused = applyTaskTransition(taskId, 'pause', {
    executionToken: null,
    expectedExecutionToken: task.execution_token ?? null,
  })
  if (!paused?.ok || !paused.changed) return false
  admission.remove(taskId)
  abortTaskController(taskId, task.execution_token ?? null)
  taskLog('info', taskId, task.account_id, task.platform, 'Task pause requested')
  return true
}

export function resumeTask(taskId: string): boolean {
  const task = getTaskById(taskId)
  if (!task || task.status !== 'paused') return false
  const resumed = applyTaskTransition(taskId, 'resume', {
    executionToken: null,
    expectedExecutionToken: task.execution_token ?? null,
  })
  if (!resumed?.ok || !resumed.changed) return false
  enqueueTask(taskId)
  taskLog('info', taskId, task.account_id, task.platform, 'Task resumed')
  return true
}

/** Get queue status for all platforms. */
export function getQueueStatus(): Record<string, { pending: number; running: number; size: number }> {
  return admission.status()
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

import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../shared/constants'
import { generateId, now } from '../shared/utils'
import type { AddAccountParams, DriveAccount, ArchiveCompressOptions, ArchiveCompressTaskPayload, ArchiveExtractTaskPayload } from '../shared/types'
import {
  insertAccount,
  getAllAccounts,
  getAccountById,
  deleteAccountCascade,
  updateAccountStatus,
  updateAccountCredential,
  getAllTasks,
  getTaskById,
  getTasksByAccount,
  getRecentLogs,
  getLogsByTaskId,
  deleteTaskById,
  getSetting,
  setSetting,
  getAllSettings,
  listShareLinks,
  listTransferRecords,
  deleteShareLink,
  deleteTransferRecord,
  replaceFilesCacheSnapshot,
  getFilesCacheByParent,
  getFilesCacheLatestTimestamp,
  invalidateFilesCacheParents,
  getCachedParentIdsForFiles,
  getAllSearchSources,
  insertSearchSource,
  updateSearchSource,
  deleteSearchSource,
  type DbSearchSource,
  getAllTgChannels,
  insertTgChannel,
  updateTgChannel,
  deleteTgChannel,
  type DbTgChannel,
  getAllCrawlerSources,
  insertCrawlerSource,
  updateCrawlerSource,
  deleteCrawlerSource,
  type DbCrawlerSource,
  getAllKkSources,
  insertKkSource,
  updateKkSource,
  deleteKkSource,
  type DbKkSource,
  getCachedSearchResults,
  setCachedSearchResults,
  getSearchHistory,
  addSearchHistory,
  clearSearchHistory,
} from './db'
import { encryptCredential, decryptCredential } from './crypto'
import { openQuarkLoginWindow, openBaiduLoginWindow, clearQuarkLoginSession } from './login-window'
import { getAdapter } from '../adapters/registry'
import { quarkAdapter } from '../adapters/quark'
import { baiduAdapter, baiduExchangeCode, baiduGetAuthUrl, setBaiduCredentials } from '../adapters/baidu'
import { ucAdapter } from '../adapters/uc'
import { xunleiAdapter } from '../adapters/xunlei'
import { executeSearch } from './search-engine'
import { executeStreamSearch, verifyResourceUrl, verifyResourceUrls } from './stream-search'
import { encryptUrl, decryptUrl } from './url-crypto'
import { isRateLimited, getRateLimitResetSeconds } from './concurrency-control'
import { registerEmbeddedBrowserHandlers } from './embedded-browser'
import { createAndEnqueueTask, retryTask, cancelTask, pauseTask, resumeTask } from './task-runner'
import { listArchiveFiles, cleanupTempDir } from './archive'
import { aggregateSearch } from './aggregate-search'
import type { DbAccount } from './db'
import type { UploadFileInfo, UploadParams } from '../shared/types'
import type { CloudTransferFileInfo, CloudTransferParams, CloudTransferTaskPayload } from '../shared/types'
import { normalizeConflictPolicy, normalizeRelativePath, sanitizeFileName } from './file-transfer'
import {
  configureRequestSettings,
  isRequestSettingKey,
  normalizeRequestSetting,
} from './request-settings'
import log from 'electron-log'
import { isTargetInsideSelectedDirectory, selectCloudTransferMode } from '../shared/cloud-transfer'
import { FilePreviewService, registerFilePreviewIpc } from './file-preview'
import { AppLock, type AppLockRecord } from './app-lock'
import {
  importConfigBackup,
  previewConfigBackupImport,
  serializeConfigBackup,
} from './config-backup'
import { askAiDocuments, deleteAiDocument, importAiFiles, listAiDocuments, listAiTasks, reindexAiDocument, streamAiDocuments, writeAiKnowledgeMarkdown } from './ai/ai-service'
import { getAiProviderConfig, saveAiProviderConfig, testAiProvider } from './ai/ai-provider'
import { activateAiProviderProfile, deleteAiProviderProfile, getAiProviderUsage, listAiProviderProfiles } from './ai/ai-provider-store'
import { getAiLocalToolsConfig, listAiLocalToolStatuses, saveAiLocalToolsConfig } from './ai/local-ai-tools'
import type { AiAskInput, AiAskStreamEvent, AiConversationCreateInput, AiConversationMessageAppendInput, AiProviderSaveInput } from '../shared/ai-types'
import {
  appendAiConversationMessage,
  createAiConversation,
  deleteAiConversation,
  listAiConversationMessages,
  listAiConversations,
  renameAiConversation,
  setAiConversationDocumentIds,
  searchAiConversations,
  exportAiConversationMarkdown,
  truncateAiConversationFromMessage,
  deleteLastAiConversationAssistant,
} from './ai/conversation-service'

const MAX_UPLOAD_FILES = 10_000
const filePreviewService = new FilePreviewService()
const APP_LOCK_SETTING = 'app_lock_record'
let appLock: AppLock | null = null
let appLockTimer: ReturnType<typeof setInterval> | null = null
const activeAiStreams = new Map<string, { controller: AbortController; senderId: number }>()

function appLockState(): Record<string, unknown> {
  try {
    const snapshot = appLock?.snapshot() || { enabled: false, status: 'disabled', reason: null, autoLockMs: 0, failedAttempts: 0, retryAfterMs: 0, lastActivityAt: null }
    return { ...snapshot, locked: snapshot.enabled && snapshot.status !== 'unlocked' }
  } catch (err) {
    // A corrupted/old persisted record must not make the Security page or IPC handler crash.
    log.error('Failed to read app lock state; treating app lock as disabled:', String(err))
    return { enabled: false, status: 'disabled', reason: null, autoLockMs: 0, failedAttempts: 0, retryAfterMs: 0, lastActivityAt: null, locked: false, error: '应用锁配置已损坏，请重新设置' }
  }
}

function broadcastAppLockState(): void {
  const state = appLockState()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.APP_LOCK_CHANGED, state)
  }
}

function persistAppLock(): void {
  const record = appLock?.exportRecord()
  if (record) setSetting(APP_LOCK_SETTING, JSON.stringify(record))
  else setSetting(APP_LOCK_SETTING, '')
}

function initializeAppLock(): void {
  const saved = getSetting(APP_LOCK_SETTING)?.value
  let record: AppLockRecord | null = null
  if (saved) {
    try { record = JSON.parse(saved) as AppLockRecord } catch (err) { log.warn('Invalid app lock record:', String(err)) }
  }
  try {
    appLock = new AppLock({ record })
  } catch (err) {
    // Older builds may have persisted a record that the current validator rejects.
    // Reset only the app-lock setting, leaving accounts and other credentials intact.
    log.error('Invalid persisted app lock record, resetting it:', String(err))
    try { setSetting(APP_LOCK_SETTING, '') } catch (resetError) { log.error('Failed to reset app lock setting:', String(resetError)) }
    appLock = new AppLock()
  }
  const lock = appLock
  appLockTimer = setInterval(() => {
    const before = appLockState()
    lock.tick()
    const after = appLockState()
    if (before.status !== after.status || before.locked !== after.locked) broadcastAppLockState()
  }, 1_000)
}

export function cleanupIpcResources(): void {
  filePreviewService.cleanupAll()
  if (appLockTimer) clearInterval(appLockTimer)
  appLockTimer = null
  appLock = null
}

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

function dbAccountToDriveAccount(row: DbAccount): DriveAccount {
  let credential: DriveAccount['credential'] = {}
  try {
    const decrypted = decryptCredential(row.encrypted_credential)
    credential = JSON.parse(decrypted)
  } catch {
    log.warn('Failed to decrypt credential for account:', row.id)
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

function sanitizeAccount(account: DriveAccount): Omit<DriveAccount, 'credential'> & { credential: undefined } {
  return { ...account, credential: undefined as any }
}

export function registerIpcHandlers(): void {
  // Register embedded browser handlers
  registerEmbeddedBrowserHandlers()
  initializeAppLock()
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_STATUS, async () => ({ success: true, ...appLockState() }))
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_CONFIGURE, async (_event, input: { password: string; autoLockMs?: number }) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      await appLock.configure(String(input?.password || ''), Number(input?.autoLockMs ?? 5 * 60_000))
      persistAppLock()
      const state = appLockState()
      broadcastAppLockState()
      return { success: true, ...state }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_UNLOCK, async (_event, password: string) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      const result = await appLock.unlock(String(password || ''))
      const state = appLockState()
      broadcastAppLockState()
      return { success: result.success, ...state, error: result.success ? undefined : '密码错误或暂时不可重试' }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_CHANGE_PASSWORD, async (_event, input: { currentPassword: string; newPassword: string }) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      await appLock.changePassword(String(input?.currentPassword || ''), String(input?.newPassword || ''))
      persistAppLock()
      broadcastAppLockState()
      return { success: true, ...appLockState() }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_DISABLE, async (_event, password: string) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      await appLock.disable(String(password || ''))
      persistAppLock()
      broadcastAppLockState()
      return { success: true, ...appLockState() }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_SET_AUTO_LOCK, async (_event, autoLockMs: number) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      appLock.setAutoLockMs(Number(autoLockMs))
      persistAppLock()
      broadcastAppLockState()
      return { success: true, ...appLockState() }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_NOW, async () => {
    if (!appLock) return { success: false, error: '应用锁未初始化' }
    appLock.lock('manual')
    broadcastAppLockState()
    return { success: true, ...appLockState() }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_TOUCH, async () => {
    appLock?.noteActivity()
    return { success: true, ...appLockState() }
  })
  registerFilePreviewIpc(ipcMain, filePreviewService, async (request, context) => {
    const row = getAccountById(request.accountId)
    if (!row) return { success: false, error: '账号不存在' }
    const account = dbAccountToDriveAccount(row)
    const adapter = getAdapter(account.platform)
    if (!adapter.download) return { success: false, error: `${account.platform} 暂不支持下载预览` }
    return adapter.download(account, request.fileId, context.directory, { fileName: context.fileName })
  })
  // Settings are held in a small runtime store so every adapter sees changes
  // immediately without reaching into SQLite from its request loop.
  for (const key of ['quarkPageSize', 'baiduPageSize', 'requestDelayMs'] as const) {
    try {
      const value = getSetting(key)?.value
      if (value !== undefined) configureRequestSettings({ [key]: value })
    } catch (err) {
      log.warn(`Invalid persisted request setting ${key}, using default:`, String(err))
    }
  }

  // Load Baidu credentials from settings (if configured)
  try {
    const clientIdRow = getSetting('baiduClientId')
    const clientSecretRow = getSetting('baiduClientSecret')
    const redirectUriRow = getSetting('baiduRedirectUri')
    const clientId = clientIdRow?.value || ''
    let clientSecret = ''
    if (clientSecretRow?.value) {
      try {
        clientSecret = clientSecretRow.encrypted ? decryptCredential(clientSecretRow.value) : clientSecretRow.value
      } catch { /* ignore */ }
    }
    const redirectUri = redirectUriRow?.value || ''
    if (clientId && clientSecret) {
      setBaiduCredentials(clientId, clientSecret, redirectUri || undefined)
      log.info('Baidu credentials loaded from settings')
    }
  } catch (err) {
    log.warn('Failed to load Baidu credentials from settings:', String(err))
  }

  // Wire Baidu credential auto-save on token refresh
  baiduAdapter.setCredentialRefreshHandler((accountId, newCred) => {
    try {
      const encrypted = encryptCredential(JSON.stringify(newCred))
      updateAccountCredential(accountId, encrypted)
      log.info('Baidu: refreshed credential saved to DB for account', accountId)
    } catch (err) {
      log.error('Baidu: failed to save refreshed credential:', String(err))
    }
  })
  baiduAdapter.setSessionInvalidatedHandler((accountId) => {
    try {
      updateAccountStatus(accountId, 'expired', now())
      log.warn('Baidu: marked account expired after keepalive authentication failure', accountId)
    } catch (err) {
      log.warn('Baidu: failed to mark expired account:', String(err))
    }
  })

  // Wire Xunlei credential auto-save on token refresh
  xunleiAdapter.setCredentialRefreshHandler((accountId, newCred) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return
      const existingCred = JSON.parse(decryptCredential(row.encrypted_credential))
      const merged = { ...existingCred, ...newCred }
      const encrypted = encryptCredential(JSON.stringify(merged))
      updateAccountCredential(accountId, encrypted)
      log.info('Xunlei: refreshed credential saved to DB for account', accountId)
    } catch (err) {
      log.error('Xunlei: failed to save refreshed credential:', String(err))
    }
  })

  // ---- Quark Login ----

  ipcMain.handle(IPC_CHANNELS.LOGIN_QUARK, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    if (!parentWindow) {
      return { success: false, error: '无法获取主窗口' }
    }

    log.info('Opening Quark login window...')
    const result = await openQuarkLoginWindow(parentWindow)

    if (!result.success) {
      log.info('Quark login window result: failed -', result.error)
      return { success: false, error: result.error }
    }

    log.info('Quark login: got cookies, length=', result.cookies?.length, 'nickname:', result.nickname)
    return { success: true, cookies: result.cookies, userAgent: result.userAgent, nickname: result.nickname || '夸克用户' }
  })

  // ---- Baidu OAuth ----

  ipcMain.handle(IPC_CHANNELS.BAIDU_GET_AUTH_URL, async () => {
    try {
      const url = baiduGetAuthUrl()
      await shell.openExternal(url)
      log.info('Baidu OAuth authorization page opened in system browser')
      return { success: true, url }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('Failed to open Baidu OAuth authorization page:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.LOGIN_BAIDU, async (_event, code: string) => {
    try {
      log.info('Baidu: exchanging code for token...')
      const tokenData = await baiduExchangeCode(code)

      // Verify token by getting user info
      const tempAccount: DriveAccount = {
        id: 'temp',
        platform: 'baidu',
        nickname: '',
        loginType: 'oauth',
        credential: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: Date.now() + tokenData.expires_in * 1000,
        },
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
      }

      const loginOk = await baiduAdapter.checkLogin(tempAccount)
      if (!loginOk) {
        return { success: false, error: '登录验证失败，请重试' }
      }

      let nickname = '百度用户'
      try {
        const userInfo = await baiduAdapter.getUserInfo(tempAccount)
        nickname = userInfo.nickname
      } catch { /* use default */ }

      return {
        success: true,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
        nickname,
      }
    } catch (err) {
      log.error('Baidu OAuth failed:', String(err))
      return { success: false, error: String(err) }
    }
  })

  // ---- Baidu Cookie Login ----

  ipcMain.handle(IPC_CHANNELS.LOGIN_BAIDU_COOKIE, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    if (!parentWindow) {
      return { success: false, error: '无法获取主窗口' }
    }

    log.info('Opening Baidu cookie login window...')
    const result = await openBaiduLoginWindow(parentWindow)

    if (!result.success) {
      log.info('Baidu cookie login window result: failed -', result.error)
      return { success: false, error: result.error }
    }

    log.info('Baidu cookie login: got cookies, length=', result.cookies?.length, 'verifying...')
    try {
      const tempAccount: DriveAccount = {
        id: 'temp',
        platform: 'baidu',
        nickname: '',
        loginType: 'cookie',
        credential: { cookies: result.cookies },
        userAgent: result.userAgent,
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
      }

      const loginOk = await baiduAdapter.checkLogin(tempAccount)
      if (!loginOk) {
        return { success: false, error: '登录验证失败，请重试' }
      }

      let nickname = result.nickname || ''
      if (!nickname || nickname === '百度用户') {
        // 尝试通过 API 获取真实昵称
        try {
          const userInfo = await baiduAdapter.getUserInfo(tempAccount)
          if (userInfo.nickname && userInfo.nickname !== '百度用户') {
            nickname = userInfo.nickname
            log.info('Baidu login: got nickname from API:', nickname)
          }
        } catch (err) {
          log.warn('Baidu login: getUserInfo failed:', String(err))
        }
      }
      if (!nickname) nickname = '百度用户'

      return { success: true, cookies: result.cookies, userAgent: result.userAgent, nickname }
    } catch (err) {
      log.error('Baidu cookie login verification failed:', String(err))
      return { success: false, error: '登录验证失败: ' + String(err) }
    }
  })

  // ---- UC Login (cookie-based, similar to Quark) ----

  ipcMain.handle(IPC_CHANNELS.LOGIN_UC, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    if (!parentWindow) return { success: false, error: '无法获取主窗口' }

    log.info('Opening UC login window...')
    const { openUcLoginWindow } = await import('./login-window')
    const result = await openUcLoginWindow(parentWindow)

    if (!result.success) return { success: false, error: result.error }

    try {
      const tempAccount: DriveAccount = {
        id: 'temp', platform: 'uc', nickname: '', loginType: 'cookie',
        credential: { cookies: result.cookies },
        status: 'active', createdAt: 0, updatedAt: 0,
      }
      log.info(`UC login: verifying cookies, length=${result.cookies?.length || 0}`)
      const loginOk = await ucAdapter.checkLogin(tempAccount)
      if (!loginOk) {
        log.warn('UC login: checkLogin returned false')
        return { success: false, error: '登录验证失败，请确认已在UC网盘页面完成登录后再点击按钮' }
      }

      let nickname = result.nickname || ''
      log.info(`UC login: page nickname="${nickname}"`)
      if (!nickname || nickname === 'UC用户') {
        // 尝试通过 API 获取真实昵称
        try {
          const userInfo = await ucAdapter.getUserInfo(tempAccount)
          log.info(`UC login: API userInfo=${JSON.stringify(userInfo)}`)
          if (userInfo.nickname && userInfo.nickname !== 'UC用户') {
            nickname = userInfo.nickname
            log.info('UC login: got nickname from API:', nickname)
          }
        } catch (err) {
          log.warn('UC login: getUserInfo failed:', String(err))
        }
      }
      if (!nickname) nickname = 'UC用户'
      return { success: true, cookies: result.cookies, nickname }
    } catch (err) {
      return { success: false, error: '登录验证失败: ' + String(err) }
    }
  })

  // ---- Alipan Login (refresh_token) ----

  // ---- Xunlei Login (refresh_token 手动输入) ----

  ipcMain.handle(IPC_CHANNELS.LOGIN_XUNLEI, async (_event, refreshToken: string) => {
    try {
      log.info('Xunlei: verifying refresh_token...')
      const tempAccount: DriveAccount = {
        id: 'temp', platform: 'xunlei', nickname: '', loginType: 'token',
        credential: { refreshToken },
        status: 'active', createdAt: 0, updatedAt: 0,
      }
      const loginOk = await xunleiAdapter.checkLogin(tempAccount)
      if (!loginOk) return { success: false, error: '登录验证失败，请检查 refresh_token' }

      let nickname = '迅雷用户'
      try {
        const userInfo = await xunleiAdapter.getUserInfo(tempAccount)
        nickname = userInfo.nickname
      } catch { /* use default */ }
      return { success: true, refreshToken, nickname }
    } catch (err) {
      return { success: false, error: '登录验证失败: ' + String(err) }
    }
  })

  // ---- Xunlei Auto Login (浏览器登录，从 localStorage 提取 token) ----

  ipcMain.handle(IPC_CHANNELS.LOGIN_XUNLEI_AUTO, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    if (!parentWindow) return { success: false, error: '无法获取主窗口' }

    log.info('Opening Xunlei login window...')
    const { openXunleiLoginWindow } = await import('./login-window')
    const result = await openXunleiLoginWindow(parentWindow)

    if (!result.success) return { success: false, error: result.error }

    // 缓存浏览器 token 到适配器
    if (result.accessToken && result.userId) {
      xunleiAdapter.cacheBrowserToken('temp_browser', result.accessToken, result.userId)
      log.info(`Xunlei: browser token cached, userId=${result.userId}`)
    }

    // 返回 accessToken 和 userId，前端会保存到 credential
    return {
      success: true,
      refreshToken: result.refreshToken,
      accessToken: result.accessToken,
      userId: result.userId,
      nickname: result.nickname || '迅雷用户',
    }
  })

  // ---- Account handlers ----

  ipcMain.handle(IPC_CHANNELS.ACCOUNT_ADD, async (_event, params: AddAccountParams) => {
    try {
      const id = generateId()
      const ts = now()
      const encrypted = encryptCredential(JSON.stringify(params.credential))

      insertAccount({
        id,
        platform: params.platform,
        nickname: params.nickname,
        login_type: params.loginType,
        encrypted_credential: encrypted,
        user_agent: params.userAgent || null,
        status: 'active',
        bind_machine: 1,
        created_at: ts,
        updated_at: ts,
        last_check_at: null,
      })

      log.info(`Account added: ${params.platform} / ${params.nickname} (${id})`)

      // 百度 Cookie 登录：启动保活定时器
      if (params.platform === 'baidu' && params.loginType === 'cookie') {
        const { baiduAdapter } = await import('../adapters/baidu')
        baiduAdapter.startKeepalive({ id, platform: 'baidu', nickname: params.nickname, loginType: 'cookie', credential: params.credential, status: 'active', createdAt: ts, updatedAt: ts } as any)
      }

      // 迅雷浏览器登录：将临时缓存的 token 复制到新账号
      if (params.platform === 'xunlei' && (params.loginType === 'token' || params.loginType === 'oauth')) {
        xunleiAdapter.copyBrowserToken('temp_browser', id)
      }

      return { success: true, accountId: id }
    } catch (err) {
      log.error('Failed to add account:', String(err))
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ACCOUNT_LIST, async () => {
    try {
      const rows = getAllAccounts()
      const accounts = rows.map((row) => sanitizeAccount(dbAccountToDriveAccount(row)))
      return { success: true, accounts }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ACCOUNT_DELETE, async (_event, id: string) => {
    try {
      const account = getAccountById(id)
      if (!account) return { success: false, error: '账号不存在' }
      const activeTasks = getTasksByAccount(id).filter((task) =>
        task.status === 'pending' || task.status === 'running' || task.status === 'paused'
      )
      if (activeTasks.length > 0) {
        return { success: false, error: `该账号还有 ${activeTasks.length} 个未结束任务，请先取消后再删除账号` }
      }

      // 停止百度保活定时器
      if (account.platform === 'baidu') {
        const { baiduAdapter } = await import('../adapters/baidu')
        baiduAdapter.stopKeepalive(id)
      }

      if (account.platform === 'quark') {
        await clearQuarkLoginSession()
      }

      const deleted = deleteAccountCascade(id)
      log.info(`Account deleted: ${id} — accounts:${deleted.accounts} files:${deleted.files} tasks:${deleted.tasks} logs:${deleted.logs}`)
      return { success: true, deleted }
    } catch (err) {
      log.error('Failed to delete account:', String(err))
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ACCOUNT_CHECK, async (_event, id: string) => {
    try {
      const row = getAccountById(id)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      const ok = await adapter.checkLogin(account)
      const status = ok ? 'active' : 'expired'
      updateAccountStatus(id, status, now())
      return { success: true, status }
    } catch (err) {
      updateAccountStatus(id, 'error', now())
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ACCOUNT_QUOTA, async () => {
    try {
      const rows = getAllAccounts()
      const quotas = await Promise.all(
        rows.map(async (row: any) => {
          const account = dbAccountToDriveAccount(row)
          if (account.status !== 'active') {
            return { accountId: account.id, platform: account.platform, nickname: account.nickname, quota: null, membership: null, error: '账号未登录' }
          }
          const adapter = getAdapter(account.platform)
          const [quotaResult, membershipResult] = await Promise.allSettled([
            adapter.getQuota ? adapter.getQuota(account) : Promise.resolve(null),
            adapter.getMembership ? adapter.getMembership(account) : Promise.resolve(null),
          ])
          return {
            accountId: account.id,
            platform: account.platform,
            nickname: account.nickname,
            quota: quotaResult.status === 'fulfilled' ? quotaResult.value : null,
            membership: membershipResult.status === 'fulfilled' ? membershipResult.value : null,
            error: quotaResult.status === 'rejected' ? String(quotaResult.reason) : undefined,
          }
        }),
      )
      return { success: true, quotas }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ACCOUNT_MEMBERSHIP, async (_event, id: string) => {
    try {
      const row = getAccountById(String(id || ''))
      if (!row) return { success: false, error: '账号不存在' }
      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)
      if (!adapter.getMembership) {
        return { success: true, membership: { known: false, isVip: false, status: 'unknown', label: '会员信息未知', fetchedAt: Date.now() } }
      }
      return { success: true, membership: await adapter.getMembership(account) }
    } catch (err) {
      return { success: false, error: String(err) }
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

  // ---- Task handlers ----

  ipcMain.handle(IPC_CHANNELS.TASK_LIST, async () => {
    try {
      const tasks = getAllTasks().map((task) => ({
        id: task.id,
        accountId: task.account_id,
        platform: task.platform,
        taskType: task.task_type,
        title: task.title,
        payload: JSON.parse(task.payload || '{}'),
        status: task.status,
        progress: task.progress,
        retryCount: task.retry_count,
        errorMessage: task.error_message || undefined,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        finishedAt: task.finished_at || undefined,
      }))
      return { success: true, tasks }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_RETRY, async (_event, taskId: string) => {
    try {
      const ok = retryTask(taskId)
      return ok ? { success: true } : { success: false, error: '任务不存在或无法重试' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL, async (_event, taskId: string) => {
    try {
      const ok = cancelTask(taskId)
      return ok ? { success: true } : { success: false, error: '任务不存在或无法取消' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE, async (_event, taskId: string) => {
    try {
      return pauseTask(taskId) ? { success: true } : { success: false, error: '任务不存在或无法暂停' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME, async (_event, taskId: string) => {
    try {
      return resumeTask(taskId) ? { success: true } : { success: false, error: '任务不存在或无法恢复' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_DELETE, async (_event, taskId: string) => {
    try {
      const task = getTaskById(taskId)
      if (!task) return { success: false, error: '任务不存在' }
      if (!['success', 'partial_success', 'failed', 'cancelled'].includes(task.status)) {
        return { success: false, error: '只能删除已结束的任务' }
      }
      return deleteTaskById(taskId) ? { success: true } : { success: false, error: '删除失败' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_LOGS, async (_event, taskId: string) => {
    try {
      const logs = (taskId ? getLogsByTaskId(taskId) : getRecentLogs(200)).map((entry) => ({
        id: entry.id,
        level: entry.level,
        module: entry.module || undefined,
        message: entry.message,
        detail: entry.detail || undefined,
        createdAt: entry.created_at,
      }))
      return { success: true, logs }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_BACKUP_EXPORT, async () => {
    try {
      return { success: true, backup: serializeConfigBackup() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_BACKUP_PREVIEW, async (_event, input: string, options?: { mode?: 'merge' | 'replace' }) => {
    try {
      return { success: true, preview: previewConfigBackupImport(input, options) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_BACKUP_IMPORT, async (_event, input: string, options?: { mode?: 'merge' | 'replace' }) => {
    try {
      return { success: true, result: importConfigBackup(input, options) }
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
      if (selectedFiles.some(file => file.isDir)) return { success: false, error: '暂不支持压缩网盘文件夹，请只选择普通文件' }

      const payload: ArchiveCompressTaskPayload = {
        accountId,
        platform: account.platform,
        targetDirId: String(options.targetDir || ''),
        archiveName,
        format,
        files: selectedFiles.map(file => ({
          fileId: file.id,
          downloadId: String(file.raw?.fs_id || file.id),
          fileName: file.name,
          fileSize: Math.max(0, Number(file.size) || 0),
        })),
      }
      const taskId = createAndEnqueueTask(accountId, account.platform, 'archive_compress', `创建压缩包 ${archiveName}`, payload as unknown as Record<string, unknown>)
      return { success: true, taskId }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Aggregate Search handler ----

  ipcMain.handle('search:aggregate', async (_event, keyword: string) => {
    try {
      if (!keyword || keyword.trim().length === 0) {
        return { success: false, error: '请输入搜索关键词' }
      }

      log.info(`[Aggregate Search] Searching: ${keyword}`)
      const results = await aggregateSearch(keyword.trim())
      log.info(`[Aggregate Search] Found ${results.length} results`)

      return { success: true, results }
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

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_FILES, async (_event, params: import('../shared/types').DownloadParams) => {
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

  ipcMain.handle(IPC_CHANNELS.SHARE_EXPORT_CSV, async (_event, filters?: { accountId?: string; platform?: string; status?: string }) => {
    try {
      const links = listShareLinks(filters) as (Awaited<ReturnType<typeof listShareLinks>>[number] & { account_nickname?: string })[]
      const { escapeCsvField } = await import('../shared/utils')
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
      const { escapeCsvField } = await import('../shared/utils')
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

  // ---- Resource Search ----

  ipcMain.handle(IPC_CHANNELS.SEARCH_SOURCES_LIST, async () => {
    try {
      const sources = getAllSearchSources()
      return { success: true, sources }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_SOURCES_SAVE, async (_event, source: DbSearchSource) => {
    try {
      const ts = Date.now()
      if (source.id) {
        // Update existing
        updateSearchSource({ ...source, updated_at: ts })
      } else {
        // Insert new
        const id = generateId()
        insertSearchSource({ ...source, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_SOURCES_DELETE, async (_event, id: string) => {
    try {
      deleteSearchSource(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_EXECUTE, async (_event, keyword: string, platform?: string) => {
    try {
      if (!keyword.trim()) return { success: false, error: '请输入搜索关键词' }
      const results = await executeSearch(keyword.trim(), platform)
      return { success: true, results }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Stream Search (SSE-like) ----

  ipcMain.handle(IPC_CHANNELS.SEARCH_STREAM_START, async (event, keyword: string, platform?: string, options?: { verifyLinks?: boolean }) => {
    try {
      if (!keyword.trim()) return { success: false, error: '请输入搜索关键词' }

      // 获取发送事件的窗口ID
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return { success: false, error: '无法获取窗口' }

      // 频率限制检查（与xinyue-search一致）
      const clientId = `window_${window.id}`
      if (isRateLimited(clientId)) {
        const resetSeconds = getRateLimitResetSeconds(clientId)
        return { success: false, error: `请求太过频繁，请 ${resetSeconds} 秒后再试` }
      }

      const windowId = window.id

      // 异步执行流式搜索（不等待完成）
      executeStreamSearch(windowId, keyword.trim(), platform, options).catch(err => {
        log.error('[Stream Search] Error:', String(err))
        // 发送错误事件
        window.webContents.send(IPC_CHANNELS.SEARCH_STREAM_EVENT, {
          event: 'error',
          data: { message: String(err) },
        })
      })

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_STREAM_STOP, async () => {
    // 停止搜索的逻辑（可以添加abort controller）
    return { success: true }
  })

  // ---- Link Verification ----

  ipcMain.handle(IPC_CHANNELS.LINK_VERIFY_SINGLE, async (_event, url: string) => {
    try {
      const result = await verifyResourceUrl(url)
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.LINK_VERIFY_BATCH, async (_event, urls: string[]) => {
    try {
      const results = await verifyResourceUrls(urls)
      return { success: true, results }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- TG Channels ----

  ipcMain.handle(IPC_CHANNELS.TG_CHANNELS_LIST, async () => {
    try {
      const channels = getAllTgChannels()
      return { success: true, channels }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TG_CHANNELS_SAVE, async (_event, channel: DbTgChannel) => {
    try {
      const ts = Date.now()
      if (channel.id) {
        // Update existing
        updateTgChannel({ ...channel, updated_at: ts })
      } else {
        // Insert new
        const id = `tg_${generateId()}`
        insertTgChannel({ ...channel, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TG_CHANNELS_DELETE, async (_event, id: string) => {
    try {
      deleteTgChannel(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Crawler Sources ----

  ipcMain.handle(IPC_CHANNELS.CRAWLER_SOURCES_LIST, async () => {
    try {
      const sources = getAllCrawlerSources()
      return { success: true, sources }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CRAWLER_SOURCES_SAVE, async (_event, source: DbCrawlerSource) => {
    try {
      const ts = Date.now()
      if (source.id) {
        // Update existing
        updateCrawlerSource({ ...source, updated_at: ts })
      } else {
        // Insert new
        const id = `crawler_${generateId()}`
        insertCrawlerSource({ ...source, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CRAWLER_SOURCES_DELETE, async (_event, id: string) => {
    try {
      deleteCrawlerSource(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Test Search Source ----

  ipcMain.handle('search:test-source', async (_event, source: any) => {
    try {
      // 动态导入搜索引擎
      const { searchApi } = await import('./search-engine')
      const testSource = {
        id: 'test',
        name: 'Test',
        type: source.type || 'api',
        platform: source.platform || 'quark',
        url: source.url,
        method: source.method || 'GET',
        params: source.params || null,
        headers: source.headers || null,
        field_map: source.field_map || null,
        html_selectors: null,
        max_count: 5,
        weight: 0,
        status: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      const results = await searchApi(testSource, '测试')
      return { success: true, resultCount: results.length, results: results.slice(0, 3) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- KK Sources ----

  ipcMain.handle(IPC_CHANNELS.KK_SOURCES_LIST, async () => {
    try {
      const sources = getAllKkSources()
      return { success: true, sources }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KK_SOURCES_SAVE, async (_event, source: DbKkSource) => {
    try {
      const ts = Date.now()
      if (source.id) {
        // Update existing
        updateKkSource({ ...source, updated_at: ts })
      } else {
        // Insert new
        const id = `kk_${generateId()}`
        insertKkSource({ ...source, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KK_SOURCES_DELETE, async (_event, id: string) => {
    try {
      deleteKkSource(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- URL Crypto ----

  ipcMain.handle(IPC_CHANNELS.URL_ENCRYPT, async (_event, url: string) => {
    try {
      const encrypted = encryptUrl(url)
      return { success: true, encrypted }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.URL_DECRYPT, async (_event, encryptedUrl: string) => {
    try {
      const decrypted = decryptUrl(encryptedUrl)
      return { success: true, decrypted }
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

      const { escapeCsvField } = await import('../shared/utils')
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

  // ---- System ----

  ipcMain.handle(IPC_CHANNELS.DIALOG_SAVE, async (_event, options: Electron.SaveDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    return dialog.showSaveDialog(win, options)
  })

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN, async (_event, options: Electron.OpenDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    return dialog.showOpenDialog(win, options)
  })

  // ---- Settings handlers ----

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event, key: string) => {
    try {
      const row = getSetting(key)
      if (!row) return { success: true, value: null }
      if (row.encrypted) {
        try {
          const decrypted = decryptCredential(row.value)
          return { success: true, value: decrypted }
        } catch {
          return { success: true, value: '' }
        }
      }
      return { success: true, value: row.value }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, key: string, value: string) => {
    try {
      let storedValue = value
      if (isRequestSettingKey(key)) {
        storedValue = String(normalizeRequestSetting(key, value))
      }

      // Encrypt sensitive settings
      const encryptedKeys = ['baiduClientSecret', 'aiProviderApiKey']
      const shouldEncrypt = encryptedKeys.includes(key)

      if (shouldEncrypt && storedValue) {
        const encrypted = encryptCredential(storedValue)
        setSetting(key, encrypted, true)
      } else {
        setSetting(key, storedValue, false)
      }

      if (isRequestSettingKey(key)) {
        configureRequestSettings({ [key]: storedValue })
      }

      // Apply Baidu credentials immediately when saved
      if (key === 'baiduClientId' || key === 'baiduClientSecret' || key === 'baiduRedirectUri') {
        const clientIdRow = getSetting('baiduClientId')
        const clientSecretRow = getSetting('baiduClientSecret')
        const redirectUriRow = getSetting('baiduRedirectUri')
        const clientId = clientIdRow?.value || ''
        let clientSecret = ''
        if (clientSecretRow) {
          try {
            clientSecret = clientSecretRow.encrypted ? decryptCredential(clientSecretRow.value) : clientSecretRow.value
          } catch { /* ignore */ }
        }
        const redirectUri = redirectUriRow?.value || ''
        if (clientId && clientSecret) {
          setBaiduCredentials(clientId, clientSecret, redirectUri || undefined)
          log.info('Baidu credentials updated from settings')
        }
      }

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async () => {
    try {
      const rows = getAllSettings()
      const settings: Record<string, string> = {}
      for (const row of rows) {
        if (row.encrypted) {
          try {
            settings[row.key] = decryptCredential(row.value)
          } catch {
            settings[row.key] = ''
          }
        } else {
          settings[row.key] = row.value
        }
      }
      return { success: true, settings }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Independent AI workspace ----
  // AI imports are explicit user actions and never enqueue share/transfer tasks.
  ipcMain.handle(IPC_CHANNELS.AI_SELECT_FILES, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要导入 AI 工作台的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档、媒体与压缩包', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'srt', 'vtt', 'ass', 'ssa', 'lrc', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'zip', 'rar', '7z', 'tar', 'gz', 'tgz'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { success: true, files: [] }
    const files = result.filePaths.flatMap((localPath) => {
      try {
        const stat = fs.statSync(localPath)
        return stat.isFile() ? [{ localPath, fileName: path.basename(localPath), fileSize: stat.size }] : []
      } catch {
        return []
      }
    })
    return { success: true, files }
  })
  ipcMain.handle(IPC_CHANNELS.AI_IMPORT_FILES, async (_event, inputs: Array<{ localPath: string; fileName?: string }>) => {
    try {
      return await importAiFiles(inputs)
    } catch (error) {
      return { success: false, documents: [], taskIds: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_DOCUMENT_LIST, async () => ({ success: true, documents: listAiDocuments() }))
  ipcMain.handle(IPC_CHANNELS.AI_DOCUMENT_DELETE, async (_event, id: string) => ({ success: deleteAiDocument(String(id || '')) }))
  ipcMain.handle(IPC_CHANNELS.AI_DOCUMENT_REINDEX, async (_event, id: string) => reindexAiDocument(String(id || '')))
  ipcMain.handle(IPC_CHANNELS.AI_TASK_LIST, async () => ({ success: true, tasks: listAiTasks() }))
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_GET, async () => {
    try {
      return { success: true, config: getAiProviderConfig() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_SAVE, async (_event, input: AiProviderSaveInput) => {
    try {
      return { success: true, config: saveAiProviderConfig(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_TEST, async () => {
    try {
      return { success: true, message: await testAiProvider() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_LIST, async () => ({ success: true, profiles: listAiProviderProfiles(), active: getAiProviderConfig() }))
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_ACTIVATE, async (_event, id: string) => {
    try { return { success: true, config: activateAiProviderProfile(String(id || '')) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_DELETE, async (_event, id: string) => {
    try { return { success: deleteAiProviderProfile(String(id || '')) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_USAGE, async () => ({ success: true, usage: getAiProviderUsage() }))
  ipcMain.handle(IPC_CHANNELS.AI_LOCAL_TOOLS_GET, async () => {
    try { return { success: true, config: getAiLocalToolsConfig(), tools: await listAiLocalToolStatuses() } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_LOCAL_TOOLS_SAVE, async (_event, input: Record<string, unknown>) => {
    try {
      const config = saveAiLocalToolsConfig(input)
      return { success: true, config, tools: await listAiLocalToolStatuses() }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_LOCAL_TOOLS_SELECT, async (_event, key: string) => {
    const isModel = key === 'whisperModelPath'
    const result = await dialog.showOpenDialog({
      title: isModel ? '选择 Whisper GGML 模型文件' : '选择本地能力工具',
      properties: ['openFile'],
      filters: isModel
        ? [{ name: 'Whisper 模型', extensions: ['bin', 'gguf'] }, { name: '所有文件', extensions: ['*'] }]
        : [{ name: '可执行程序', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
    })
    return { success: true, filePath: result.canceled ? undefined : result.filePaths[0] }
  })
  ipcMain.handle(IPC_CHANNELS.AI_ASK, async (_event, input: AiAskInput) => askAiDocuments(input))
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_LIST, async () => ({ success: true, conversations: listAiConversations() }))
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_CREATE, async (_event, input: AiConversationCreateInput) => {
    try { return { success: true, conversation: createAiConversation(input || {}) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_RENAME, async (_event, id: string, title: string) => {
    try {
      const conversation = renameAiConversation(id, title)
      return conversation ? { success: true, conversation } : { success: false, error: '会话不存在' }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_DELETE, async (_event, id: string) => {
    try { return { success: deleteAiConversation(id) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_SET_DOCUMENTS, async (_event, id: string, documentIds: string[]) => {
    try {
      const conversation = setAiConversationDocumentIds(id, documentIds)
      return conversation ? { success: true, conversation } : { success: false, error: '会话不存在' }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_MESSAGES, async (_event, id: string) => {
    try { return { success: true, messages: listAiConversationMessages(id) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_SEARCH, async (_event, query: string) => {
    try { return { success: true, hits: searchAiConversations(query) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_TRUNCATE, async (_event, conversationId: string, messageId: string) => {
    try { return { success: truncateAiConversationFromMessage(conversationId, messageId) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_EXPORT, async (_event, id: string) => {
    try {
      const exported = exportAiConversationMarkdown(id)
      const safeTitle = exported.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'AI 对话'
      const selected = await dialog.showSaveDialog({
        title: '导出 AI 对话', defaultPath: `${safeTitle}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (selected.canceled || !selected.filePath) return { success: true, canceled: true }
      fs.writeFileSync(selected.filePath, exported.markdown, 'utf8')
      return { success: true, filePath: selected.filePath }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_KNOWLEDGE_EXPORT, async () => {
    try {
      const selected = await dialog.showSaveDialog({
        title: '导出完整 AI 知识库', defaultPath: `PanLite-AI-Knowledge-${new Date().toISOString().slice(0, 10)}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (selected.canceled || !selected.filePath) return { success: true, canceled: true }
      return { success: true, filePath: selected.filePath, ...writeAiKnowledgeMarkdown(selected.filePath) }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_ASK_STREAM_START, async (event, input: AiAskInput) => {
    const requestId = generateId()
    const controller = new AbortController()
    const sender = event.sender
    activeAiStreams.set(requestId, { controller, senderId: sender.id })
    const send = (payload: Omit<AiAskStreamEvent, 'requestId'>): void => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.AI_ASK_STREAM_EVENT, { requestId, ...payload } satisfies AiAskStreamEvent)
    }

    void (async () => {
      try {
        const question = String(input?.question || '').trim()
        if (question.length < 2 || question.length > 2_000) throw new Error('问题长度应为 2 到 2000 个字符')
        let history = input.history || []
        if (input.conversationId) {
          if (input.regenerate) deleteLastAiConversationAssistant(input.conversationId)
          const previous = listAiConversationMessages(input.conversationId)
          const historyMessages = input.regenerate
            ? previous.slice(0, Math.max(0, previous.map(message => message.role).lastIndexOf('user')))
            : previous
          history = historyMessages.map(message => ({ role: message.role, content: message.content })).slice(-8)
          setAiConversationDocumentIds(input.conversationId, input.documentIds || [])
          if (!input.regenerate) appendAiConversationMessage({ conversationId: input.conversationId, role: 'user', content: question })
        }
        send({ type: 'started' })
        const result = await streamAiDocuments({ ...input, question, history }, {
          signal: controller.signal,
          onDelta: delta => send({ type: 'delta', delta }),
        })
        if (controller.signal.aborted) {
          send({ type: 'cancelled', error: '已停止生成' })
        } else if (result.success && result.answer) {
          if (input.conversationId) {
            const message: AiConversationMessageAppendInput = {
              conversationId: input.conversationId,
              role: 'assistant',
              content: result.answer,
              citations: result.citations,
            }
            appendAiConversationMessage(message)
          }
          send({ type: 'completed', answer: result.answer, citations: result.citations })
        } else {
          send({ type: 'error', error: result.error || '生成失败' })
        }
      } catch (error) {
        send({ type: controller.signal.aborted ? 'cancelled' : 'error', error: controller.signal.aborted ? '已停止生成' : error instanceof Error ? error.message : String(error) })
      } finally {
        activeAiStreams.delete(requestId)
      }
    })()
    return { success: true, requestId }
  })
  ipcMain.handle(IPC_CHANNELS.AI_ASK_STREAM_CANCEL, async (event, requestId: string) => {
    const stream = activeAiStreams.get(String(requestId || ''))
    if (!stream || stream.senderId !== event.sender.id) return { success: false, error: '生成任务不存在或已经结束' }
    stream.controller.abort(new DOMException('用户停止生成', 'AbortError'))
    return { success: true }
  })

  // 启动时为已有的百度 Cookie 账号启动保活
  ;(async () => {
    try {
      const { baiduAdapter } = await import('../adapters/baidu')
      const rows = getAllAccounts()
      for (const row of rows) {
        if (row.platform === 'baidu' && row.login_type === 'cookie' && row.status === 'active') {
          const account = dbAccountToDriveAccount(row)
          baiduAdapter.startKeepalive(account)
        }
      }
    } catch (err) {
      log.warn('Failed to start Baidu keepalive:', String(err))
    }
  })()
}

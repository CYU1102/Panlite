import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../shared/constants'
import { generateId, now } from '../shared/utils'
import type { AddAccountParams, DriveAccount } from '../shared/types'
import {
  insertAccount,
  getAllAccounts,
  getAccountById,
  deleteAccountCascade,
  updateAccountStatus,
  updateAccountCredential,
  getAllTasks,
  getTaskById,
  getRecentLogs,
  getLogsByTaskId,
  getSetting,
  setSetting,
  getAllSettings,
  listShareLinks,
  listTransferRecords,
  deleteShareLink,
  deleteTransferRecord,
  insertFilesCache,
  getFilesCacheByParent,
  getFilesCacheLatestTimestamp,
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
import { createAndEnqueueTask, retryTask, cancelTask } from './task-runner'
import { listArchiveFiles, extractArchive, createArchive, getAllFilesInDir, cleanupTempDir } from './archive'
import { aggregateSearch } from './aggregate-search'
import type { DbAccount } from './db'
import log from 'electron-log'

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
      return { success: true, url }
    } catch (err) {
      return { success: false, error: String(err) }
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
      if (params.platform === 'xunlei' && params.loginType === 'token') {
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
          try {
            const account = dbAccountToDriveAccount(row)
            if (account.status !== 'active') {
              return { accountId: account.id, platform: account.platform, nickname: account.nickname, quota: null, error: '账号未登录' }
            }
            const adapter = getAdapter(account.platform)
            if (!adapter.getQuota) {
              return { accountId: account.id, platform: account.platform, nickname: account.nickname, quota: null }
            }
            const quota = await adapter.getQuota(account)
            return { accountId: account.id, platform: account.platform, nickname: account.nickname, quota }
          } catch (err) {
            return { accountId: row.id, platform: row.platform, nickname: row.nickname, quota: null, error: String(err) }
          }
        }),
      )
      return { success: true, quotas }
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

      // Try cache first if requested
      if (useCache) {
        const cached = getFilesCacheByParent(accountId, parentId)
        if (cached.length > 0) {
          const files = cached.map((f) => ({
            id: f.file_id,
            parentId: f.parent_id || '',
            name: f.filename,
            isDir: f.is_dir === 1,
            size: f.size,
            createdAt: f.created_at || 0,
            updatedAt: f.updated_at || 0,
            platform: account.platform,
            accountId,
          }))
          const cacheTime = getFilesCacheLatestTimestamp(accountId, parentId)
          return { success: true, files, parentId, hasMore: false, cached: true, cacheTime }
        }
      }

      const adapter = getAdapter(account.platform)
      const result = await adapter.listFiles(account, parentId)

      // Write results to cache
      try {
        const ts = Date.now()
        const cacheFiles = result.files.map((f) => ({
          id: `${accountId}_${f.id}`,
          account_id: accountId,
          platform: account.platform,
          file_id: f.id,
          parent_id: f.parentId || parentId,
          filename: f.name,
          is_dir: f.isDir ? 1 : 0,
          size: f.size,
          created_at: f.createdAt,
          updated_at: ts,
          raw_json: f.raw ? JSON.stringify(f.raw) : null,
        }))
        insertFilesCache(cacheFiles)
      } catch (cacheErr) {
        log.warn('Failed to write file cache:', String(cacheErr))
      }

      return { success: true, ...result, cached: false }
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
      await adapter.rename(account, fileId, newName)
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
      await adapter.move(account, fileIds, targetDirId)
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
      await adapter.delete(account, fileIds)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Task handlers ----

  ipcMain.handle(IPC_CHANNELS.TASK_LIST, async () => {
    try {
      const tasks = getAllTasks()
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

  ipcMain.handle(IPC_CHANNELS.TASK_LOGS, async (_event, taskId: string) => {
    try {
      const logs = taskId ? getLogsByTaskId(taskId) : getRecentLogs(200)
      return { success: true, logs }
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
      const title = `批量删除 ${items.length} 个文件`
      const taskId = createAndEnqueueTask(accountId, account.platform, 'delete', title, { items })
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

      // 创建临时目录
      const tempDir = path.join(os.tmpdir(), 'panlite-archive')
      fs.mkdirSync(tempDir, { recursive: true })

      // 下载压缩包到临时目录
      const result = await adapter.download(account, fileId, tempDir, { fileName })

      if (!result.success || !result.localPath) {
        return { success: false, error: result.error || '下载失败' }
      }

      // 读取压缩包内容
      const meta = await listArchiveFiles(result.localPath, password)

      // 清理临时文件
      try { fs.unlinkSync(result.localPath) } catch {}

      return { success: true, meta }
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

      // 创建临时目录
      const tempDir = path.join(os.tmpdir(), 'panlite-archive-extract')
      fs.mkdirSync(tempDir, { recursive: true })

      // 下载压缩包到临时目录
      const downloadResult = await adapter.download(account, fileId, tempDir, { fileName })

      if (!downloadResult.success || !downloadResult.localPath) {
        return { success: false, error: downloadResult.error || '下载失败' }
      }

      // 解压到用户选择的本地目录
      await extractArchive(downloadResult.localPath, options.targetDir, options.password, options.files)

      // 清理临时压缩包
      try { fs.unlinkSync(downloadResult.localPath) } catch {}

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ARCHIVE_COMPRESS, async (_event, accountId: string, fileIds: string[], options: { format?: string; targetDir: string; archiveName: string }) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return { success: false, error: '账号不存在' }

      const account = dbAccountToDriveAccount(row)
      const adapter = getAdapter(account.platform)

      if (!adapter.download) {
        return { success: false, error: `${account.platform} 暂不支持此操作` }
      }

      // 创建临时目录
      const tempDir = path.join(os.tmpdir(), 'panlite-compress')
      fs.mkdirSync(tempDir, { recursive: true })

      // 下载文件到临时目录
      const downloadDir = path.join(tempDir, 'files')
      fs.mkdirSync(downloadDir, { recursive: true })

      // 获取当前目录的文件列表，找到选中的文件
      const fileList = await adapter.listFiles(account, options.targetDir)
      const selectedFiles = fileList.files.filter(f => fileIds.includes(f.id))

      for (const file of selectedFiles) {
        try {
          // 百度网盘需要使用 fs_id（数字 ID）而不是文件路径
          const downloadId = (file.raw?.fs_id as string) || file.id
          log.info(`downloading: name="${file.name}" file.id="${file.id}" downloadId="${downloadId}"`)
          await adapter.download(account, downloadId, downloadDir, { fileName: file.name })
        } catch (err) {
          log.error(`Failed to download file ${file.name}:`, err)
        }
      }

      // 创建压缩包
      const format = options.format || 'zip'
      const ext = format === 'tar' ? '.tar.gz' : `.${format}`
      const archivePath = path.join(tempDir, options.archiveName + ext)

      const files = getAllFilesInDir(downloadDir)
      await createArchive(downloadDir, archivePath, format, files.map(f => ({
        relativePath: f.relativePath,
        fullPath: f.fullPath,
      })))

      // 上传压缩包到目标目录
      if (!adapter.upload) {
        return { success: false, error: `${account.platform} 暂不支持上传功能` }
      }
      const uploadResult = await adapter.upload(account, archivePath, options.targetDir, {
        fileName: options.archiveName + ext,
      })

      // 清理临时文件
      try { cleanupTempDir(tempDir) } catch {}

      if (uploadResult.success) {
        return { success: true, fileId: uploadResult.fileId }
      } else {
        return { success: false, error: uploadResult.error || '上传失败' }
      }
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

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_FILES, async (_event, params: {
    accountId: string
    files: Array<{ fileId: string; fileName: string; fileSize: number; isDir: boolean }>
    targetDirPath: string
  }) => {
    try {
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
        targetDirPath: params.targetDirPath,
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
      // Encrypt sensitive settings
      const encryptedKeys = ['baiduClientSecret']
      const shouldEncrypt = encryptedKeys.includes(key)

      if (shouldEncrypt && value) {
        const encrypted = encryptCredential(value)
        setSetting(key, encrypted, true)
      } else {
        setSetting(key, value, false)
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

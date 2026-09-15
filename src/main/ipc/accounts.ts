import { BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { generateId, now } from '../../shared/utils'
import type { AddAccountParams, DriveAccount } from '../../shared/types'
import { insertAccount, getAllAccounts, getAccountById, deleteAccountCascade, updateAccountStatus, updateAccountCredential, getTasksByAccount, getSetting } from '../db'
import { encryptCredential, decryptCredential } from '../crypto'
import { openQuarkLoginWindow, openBaiduLoginWindow, clearQuarkLoginSession } from '../login-window'
import { getAdapter } from '../../adapters/registry'
import { baiduAdapter, baiduExchangeCode, baiduGetAuthUrl, setBaiduCredentials } from '../../adapters/baidu'
import { ucAdapter } from '../../adapters/uc'
import { xunleiAdapter } from '../../adapters/xunlei'
import log from 'electron-log'
import { exchangeAliyunCode, setAliyunCredentialRefreshHandler } from '../../adapters/aliyun'
import { setAliyunWebCredentialRefreshHandler } from '../../adapters/aliyun-web'
import { fetchPan123AccessToken, setPan123CredentialRefreshHandler } from '../../adapters/pan123'
import type { IpcRegistrar } from './types'
import { dbAccountToDriveAccount, sanitizeAccount } from './account-mapping'

export function registerAccountsIpcHandlers(ipcMain: IpcRegistrar): void {
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

  // Wire token auto-save for Aliyun open/web and 123 open adapters.
  // Refresh-token rotation must survive an app restart; keeping it only on the
  // in-memory DriveAccount would otherwise silently revert to the old token.
  const persistRefreshedCredential = (accountId: string, newCred: DriveAccount['credential']) => {
    try {
      const row = getAccountById(accountId)
      if (!row) return
      const existingCred = JSON.parse(decryptCredential(row.encrypted_credential))
      const merged = { ...existingCred, ...newCred }
      updateAccountCredential(accountId, encryptCredential(JSON.stringify(merged)))
      log.info('Refreshed credential saved to DB for account', accountId)
    } catch (err) {
      log.error('Failed to save refreshed credential:', String(err))
    }
  }
  setAliyunCredentialRefreshHandler(persistRefreshedCredential)
  setAliyunWebCredentialRefreshHandler(persistRefreshedCredential)
  setPan123CredentialRefreshHandler(persistRefreshedCredential)

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
    const { openUcLoginWindow } = await import('../login-window')
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
    const { openXunleiLoginWindow } = await import('../login-window')
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
        const { baiduAdapter } = await import('../../adapters/baidu')
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
        const { baiduAdapter } = await import('../../adapters/baidu')
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


  // ---- AliyunDrive OAuth ----
  ipcMain.handle(IPC_CHANNELS.ALIYUN_EXCHANGE_CODE, async (_event, code: string) => {
    try {
      const tokens = await exchangeAliyunCode(String(code || ''))
      return { success: true, tokens }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ---- 123pan OAuth ----
  ipcMain.handle(IPC_CHANNELS.PAN123_FETCH_TOKEN, async (_event, input: { clientId?: string; clientSecret?: string }) => {
    try {
      const clientId = String(input?.clientId || '').trim()
      const clientSecret = String(input?.clientSecret || '').trim()
      if (!clientId || !clientSecret) throw new Error('请先在设置中填写 123云盘开放平台 Client ID 和 Secret')
      const tokens = await fetchPan123AccessToken(clientId, clientSecret)
      return { success: true, tokens }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })


  // 启动时为已有的百度 Cookie 账号启动保活
  ;(async () => {
    try {
      const { baiduAdapter } = await import('../../adapters/baidu')
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

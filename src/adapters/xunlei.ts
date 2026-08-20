import { BrowserWindow, net, session } from 'electron'
import type { DriveAdapter } from './base'
import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, TransferLinkInput, TransferResult, UploadOptions, UploadResult, DownloadOptions, DownloadResult } from '../shared/types'
import log from 'electron-log'
import { resolvePathInside, sanitizeFileName } from '../main/file-transfer'
import { normalizeMembership } from '../shared/membership'
import {
  buildXunleiSharePageUrl,
  classifyXunleiTask,
  extractXunleiSharePassword,
  getXunleiRestoreTaskId,
  isXunleiRestoreComplete,
} from '../shared/xunlei-share'

/**
 * 迅雷网盘适配器
 * 支持两种登录方式：
 * 1. 浏览器登录（从 localStorage 提取 token）
 * 2. 用户名密码登录（alist thunder_browser 逻辑）
 *
 * captcha_token 管理完全按照 alist 逻辑实现
 */

// ── 凭据配置 ──

// 浏览器登录使用的凭据（pan.xunlei.com）
const BROWSER_CLIENT_ID = 'Xqp0kJBXWhwaTpB6'
const BROWSER_DRIVE_API = 'https://api-pan.xunlei.com/drive/v1'

// alist thunder_browser 凭据（用户名密码登录）
const ALIST_CLIENT_ID = 'ZUBzD9J_XPXfn7f7'
const ALIST_CLIENT_SECRET = 'yESVmHecEe6F0aou69vl-g'
const ALIST_DRIVE_API = 'https://x-api-pan.xunlei.com/drive/v1'

// 通用配置
const XLUSER_API_URL = 'https://xluser-ssl.xunlei.com/v1'
const DEVICE_ID = '925b7631473a13716b791d7f28289cad'
const SHARE_PAGE_TIMEOUT_MS = 20_000
const SHARE_PAGE_POLL_INTERVAL_MS = 500
const RESTORE_TASK_TIMEOUT_MS = 120_000
const RESTORE_TASK_POLL_INTERVAL_MS = 1_000

// captcha_sign 硬编码值（alist 使用）
const CAPTCHA_TIMESTAMP = '1645241033384'
const CAPTCHA_SIGN = '1.fe2108ad808a74c9ac0243309242726c'

// ── 接口定义 ──

interface TokenResp {
  access_token: string
  token_type: string
  refresh_token: string
  expires_in: number
  user_id: string
}

interface CaptchaTokenResp {
  captcha_token: string
  expires_in: number
  url?: string
}

interface XunleiFileInfo {
  id: string
  parent_id: string
  name: string
  kind: string
  size?: number
  created_time: string
  modified_time: string
}

// ── 网络请求层 ──

function xunleiRequest<T>(
  url: string,
  method: string,
  accessToken: string,
  captchaToken: string,
  clientId: string,
  body?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method, url })

    // 按照 alist 标准设置请求头
    request.setHeader('user-agent', 'AndroidDownloadManager/13 (Linux; U; Android 13; M2004J7AC Build/SP1A.210812.016)')
    request.setHeader('accept', 'application/json;charset=UTF-8')
    request.setHeader('x-device-id', DEVICE_ID)
    request.setHeader('x-client-id', clientId)

    if (accessToken) {
      request.setHeader('Authorization', `Bearer ${accessToken}`)
    }
    if (captchaToken) {
      request.setHeader('X-Captcha-Token', captchaToken)
    }

    if (body) {
      request.setHeader('Content-Type', 'application/json')
      const bodyStr = JSON.stringify(body)
      request.setHeader('Content-Length', String(Buffer.byteLength(bodyStr)))
      request.write(bodyStr)
    }

    let responseData = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseData += chunk.toString() })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(responseData) as T
          // 检查错误响应
          const errResp = parsed as any
          if (errResp.error && errResp.error_code) {
            reject(new Error(`${errResp.error}: ${errResp.error_description || ''}`))
          } else {
            resolve(parsed)
          }
        } catch {
          reject(new Error(`Failed to parse response: ${responseData.substring(0, 200)}`))
        }
      })
      response.on('error', (err) => reject(err))
    })
    request.on('error', (err) => reject(err))
    request.end()
  })
}

// ── Token 管理 ──

interface TokenCache {
  access_token: string
  token_type: string
  refresh_token: string
  user_id: string
  expires_at: number
  client_id: string  // 记录是哪个 client 的 token
  is_browser_token: boolean
}

interface CaptchaCache {
  captcha_token: string
  expires_at: number
}

const tokenCache: Map<string, TokenCache> = new Map()
const captchaCache: Map<string, CaptchaCache> = new Map()
const refreshLocks: Map<string, Promise<void>> = new Map()
const captchaLocks: Map<string, Promise<string>> = new Map()

/**
 * alist: RefreshToken
 * POST /v1/auth/token
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenResp> {
  const ses = session.fromPartition('persist:xunlei')
  const res = await ses.fetch(`${XLUSER_API_URL}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': ALIST_CLIENT_ID,
      'x-device-id': DEVICE_ID,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ALIST_CLIENT_ID,
      client_secret: ALIST_CLIENT_SECRET,
    }),
  })
  return res.json() as Promise<TokenResp>
}

/**
 * 获取 captcha_token
 * 使用与登录窗口相同的参数（浏览器客户端参数）
 */
async function getCaptchaToken(action: string, userId: string, clientId: string): Promise<CaptchaTokenResp> {
  const ses = session.fromPartition('persist:xunlei')
  const res = await ses.fetch(`${XLUSER_API_URL}/shield/captcha/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-device-id': DEVICE_ID,
    },
    body: JSON.stringify({
      client_id: clientId,
      action,
      device_id: DEVICE_ID,
      meta: {
        username: '',
        phone_number: '',
        email: '',
        package_name: 'pan.xunlei.com',
        client_version: '1.45.0',
        captcha_sign: CAPTCHA_SIGN,
        timestamp: CAPTCHA_TIMESTAMP,
        user_id: userId || '0',
      },
    }),
  })
  return res.json() as Promise<CaptchaTokenResp>
}

/**
 * alist: RefreshCaptchaTokenInLogin
 * POST /v1/shield/captcha/init
 */
async function getCaptchaTokenForLogin(action: string, username: string): Promise<CaptchaTokenResp> {
  const meta: Record<string, string> = {}
  if (username.includes('@')) {
    meta.email = username
  } else if (username.length >= 11 && username.length <= 18) {
    meta.phone_number = username
  } else {
    meta.username = username
  }

  const ses = session.fromPartition('persist:xunlei')
  const res = await ses.fetch(`${XLUSER_API_URL}/shield/captcha/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': ALIST_CLIENT_ID,
      'x-device-id': DEVICE_ID,
    },
    body: JSON.stringify({
      action,
      captcha_token: '',
      client_id: ALIST_CLIENT_ID,
      device_id: DEVICE_ID,
      meta,
      redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
    }),
  })
  return res.json() as Promise<CaptchaTokenResp>
}

async function doRefreshAccessToken(account: DriveAccount, onRefreshed?: (accountId: string, credential: DriveAccount['credential']) => void): Promise<void> {
  const cached = tokenCache.get(account.id)
  log.info(`Xunlei: doRefreshAccessToken called, accountId=${account.id}, cached=${!!cached}, is_browser=${cached?.is_browser_token}`)

  // 浏览器 token 不支持刷新（没有 client_secret）
  if (cached?.is_browser_token) {
    if (cached.expires_at <= Date.now()) {
      throw new Error('浏览器登录已过期，请重新登录')
    }
    log.info('Xunlei: using cached browser token')
    return
  }

  // 没有缓存但有 accessToken（浏览器登录，从数据库恢复）
  if (!cached && account.credential.accessToken && account.credential.userId) {
    log.info('Xunlei: restoring browser token from credential')
    tokenCache.set(account.id, {
      access_token: account.credential.accessToken,
      token_type: 'Bearer',
      refresh_token: '',
      user_id: account.credential.userId,
      expires_at: Date.now() + 3600 * 1000,  // 假设 1 小时有效
      client_id: BROWSER_CLIENT_ID,
      is_browser_token: true,
    })
    return
  }

  // 没有缓存且没有 refresh_token（浏览器登录但缓存丢失）
  const refreshTokenStr = account.credential.refreshToken
  if (!refreshTokenStr) {
    throw new Error('迅雷登录已过期，请重新登录')
  }

  log.info('Xunlei: refreshing access token...')
  const result = await refreshAccessToken(refreshTokenStr)

  tokenCache.set(account.id, {
    access_token: result.access_token,
    token_type: result.token_type || 'Bearer',
    refresh_token: result.refresh_token,
    user_id: result.user_id,
    expires_at: Date.now() + (result.expires_in - 60) * 1000,
    client_id: ALIST_CLIENT_ID,
    is_browser_token: false,
  })

  if (onRefreshed && result.refresh_token && result.refresh_token !== refreshTokenStr) {
    onRefreshed(account.id, { refreshToken: result.refresh_token })
    log.info('Xunlei: new refresh_token saved to DB')
  }
}

async function doGetCaptchaToken(accountId: string, userId: string, clientId: string): Promise<string> {
  log.info(`Xunlei: refreshing captcha token (clientId=${clientId}, userId=${userId})...`)
  try {
    const result = await getCaptchaToken('get:/drive/v1/files', userId, clientId)
    log.info(`Xunlei: captcha token response received (hasToken=${!!result.captcha_token}, expiresIn=${result.expires_in || 0}, requiresVerification=${!!result.url})`)

    if (result.url) {
      throw new Error(`需要验证: ${result.url}`)
    }
    if (!result.captcha_token) {
      throw new Error('获取 captcha_token 失败')
    }

    captchaCache.set(accountId, {
      captcha_token: result.captcha_token,
      expires_at: Date.now() + (result.expires_in - 10) * 1000,
    })
    log.info(`Xunlei: captcha token cached (len=${result.captcha_token.length})`)
    return result.captcha_token
  } catch (err) {
    log.error('Xunlei: captcha token refresh failed:', String(err))
    throw err
  }
}

async function ensureTokens(account: DriveAccount, onRefreshed?: (accountId: string, credential: DriveAccount['credential']) => void): Promise<{ accessToken: string; captchaToken: string; clientId: string; driveApi: string }> {
  // 确保 access token 有效
  let tokenData = tokenCache.get(account.id)
  if (!tokenData || tokenData.expires_at <= Date.now() + 5 * 60 * 1000) {
    const existingLock = refreshLocks.get(account.id)
    if (existingLock) {
      await existingLock
    } else {
      const refreshPromise = doRefreshAccessToken(account, onRefreshed).finally(() => {
        refreshLocks.delete(account.id)
      })
      refreshLocks.set(account.id, refreshPromise)
      await refreshPromise
    }
    tokenData = tokenCache.get(account.id)
  }

  if (!tokenData) throw new Error('获取 token 失败')

  const clientId = tokenData.client_id

  // 确保 captcha token 有效
  let captchaToken = captchaCache.get(account.id)?.captcha_token || ''
  const cachedCaptcha = captchaCache.get(account.id)
  if (!cachedCaptcha || cachedCaptcha.expires_at <= Date.now() + 5 * 60 * 1000) {
    const existingCaptchaLock = captchaLocks.get(account.id)
    if (existingCaptchaLock) {
      captchaToken = await existingCaptchaLock
    } else {
      const captchaPromise = doGetCaptchaToken(account.id, tokenData.user_id, clientId).finally(() => {
        captchaLocks.delete(account.id)
      })
      captchaLocks.set(account.id, captchaPromise)
      captchaToken = await captchaPromise
    }
  }

  return {
    accessToken: tokenData.access_token,
    captchaToken,
    clientId,
    driveApi: tokenData.is_browser_token ? BROWSER_DRIVE_API : ALIST_DRIVE_API,
  }
}

// ── 工具函数 ──

function mapXunleiFile(f: XunleiFileInfo, accountId: string): FileItem {
  return {
    id: f.id,
    path: f.id,
    parentId: f.parent_id,
    name: f.name,
    isDir: f.kind === 'drive#folder' || f.kind === 'folder',
    size: f.size || 0,
    createdAt: new Date(f.created_time).getTime(),
    updatedAt: new Date(f.modified_time).getTime(),
    platform: 'xunlei',
    accountId,
  }
}

function extractShareId(url: string): string {
  const match = url.match(/pan\.xunlei\.com\/s\/([a-zA-Z0-9_-]+)/)
  if (match) return match[1]
  throw new Error('无法解析迅雷分享链接')
}

interface XunleiSharePageFile {
  fileId: string
  name: string
  isDir: boolean
  size: number
}

interface XunleiSharePageSnapshot {
  ready?: boolean
  error?: string
  title?: string
  pageText?: string
  files?: XunleiSharePageFile[]
  allFileIds?: string[]
  passCodeToken?: string
}

function sharePageFailureMessage(snapshot: XunleiSharePageSnapshot | null, hasPassword: boolean): string {
  const text = snapshot?.pageText || ''
  if (/提取码.*(?:错误|不正确)|密码.*(?:错误|不正确)/i.test(text)) return '转存失败：迅雷分享提取码错误'
  if (/分享.*(?:已失效|已过期|不存在|被取消|已删除)|链接.*(?:已失效|已过期)/i.test(text)) {
    return '转存失败：迅雷分享已失效或不存在'
  }
  if (/请输入提取码|需要提取码|访问码/i.test(text)) {
    return hasPassword ? '转存失败：迅雷分享提取码错误或页面未完成验证' : '转存失败：该迅雷分享需要提取码'
  }
  if (/请先登录|登录后查看/i.test(text)) return '转存失败：迅雷登录已失效'
  return '转存失败：等待迅雷分享页数据超时，请检查分享链接是否有效'
}

async function loadXunleiSharePage(input: TransferLinkInput, shareId: string): Promise<XunleiSharePageSnapshot> {
  const password = extractXunleiSharePassword(input.url, input.password)
  const sharePageUrl = buildXunleiSharePageUrl(shareId, input.url, input.password)
  let shareWindow: BrowserWindow | null = null
  let latestSnapshot: XunleiSharePageSnapshot | null = null

  try {
    shareWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        partition: 'persist:xunlei',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    shareWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await shareWindow.loadURL(sharePageUrl)

    const deadline = Date.now() + SHARE_PAGE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!shareWindow || shareWindow.isDestroyed()) throw new Error('迅雷分享页窗口已意外关闭')
      latestSnapshot = await shareWindow.webContents.executeJavaScript(`
        (() => {
          try {
            const nuxt = window.__NUXT__ || {};
            const candidates = [
              nuxt && nuxt.state && nuxt.state.share,
              window.$nuxt && window.$nuxt.$store && window.$nuxt.$store.state && window.$nuxt.$store.state.share,
              nuxt && nuxt.data && !Array.isArray(nuxt.data) && nuxt.data.share,
              Array.isArray(nuxt.data) && nuxt.data[0] && (nuxt.data[0].share || nuxt.data[0])
            ];
            const share = candidates.find(Boolean);
            const pageText = (document.body && document.body.innerText || '').slice(0, 1000);
            if (!share) return { ready: false, title: document.title || '', pageText };

            const files = [];
            const ids = [];
            const seenIds = new Set();
            const addFile = (value, fallbackId) => {
              const item = value && typeof value === 'object' ? value : {};
              const id = String(item.id || item.file_id || fallbackId || (typeof value === 'string' ? value : '') || '');
              if (!id || seenIds.has(id)) return;
              seenIds.add(id);
              ids.push(id);
              files.push({
                fileId: id,
                name: String(item.name || item.file_name || ''),
                isDir: item.kind === 'drive#folder' || item.kind === 'folder' || item.is_dir === true,
                size: Number(item.size || 0)
              });
            };

            const rawFiles = share.files || share.fileList || share.shareFiles || {};
            if (Array.isArray(rawFiles)) rawFiles.forEach((item) => addFile(item, ''));
            else if (rawFiles && typeof rawFiles === 'object') {
              Object.entries(rawFiles).forEach(([id, item]) => addFile(item, id));
            }

            const rawLists = [share.list, share.getAllFilesId, share.allFileIds, share.file_ids];
            rawLists.forEach((list) => {
              if (Array.isArray(list)) list.forEach((item) => addFile(item, ''));
            });

            const shareInfo = share.shareInfo || share.share_info || {};
            return {
              ready: files.length > 0,
              title: String(shareInfo.title || share.title || document.title || ''),
              pageText,
              files,
              allFileIds: ids,
              passCodeToken: String(
                shareInfo.passCodeToken || shareInfo.pass_code_token ||
                share.passCodeToken || share.pass_code_token || ''
              )
            };
          } catch (error) {
            return { ready: false, error: error && error.message ? error.message : String(error) };
          }
        })()
      `) as XunleiSharePageSnapshot

      if (latestSnapshot?.error) throw new Error(`读取迅雷分享页失败：${latestSnapshot.error}`)
      if (latestSnapshot?.ready && latestSnapshot.files?.length) return latestSnapshot
      await new Promise(resolve => setTimeout(resolve, SHARE_PAGE_POLL_INTERVAL_MS))
    }

    throw new Error(sharePageFailureMessage(latestSnapshot, !!password))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('转存失败：') || message.startsWith('读取迅雷分享页失败：')) throw err
    throw new Error(`转存失败：无法加载迅雷分享页（${message}）`)
  } finally {
    if (shareWindow && !shareWindow.isDestroyed()) shareWindow.destroy()
  }
}

// ── Adapter ──

export class XunleiAdapter implements DriveAdapter {
  private _onCredentialRefreshed?: (accountId: string, credential: DriveAccount['credential']) => void

  setCredentialRefreshHandler(handler: (accountId: string, credential: DriveAccount['credential']) => void): void {
    this._onCredentialRefreshed = handler
  }

  /**
   * 缓存浏览器登录的 token（从 localStorage 提取）
   */
  cacheBrowserToken(accountId: string, accessToken: string, userId: string): void {
    tokenCache.set(accountId, {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: '',
      user_id: userId,
      expires_at: Date.now() + 3600 * 1000,  // 假设 1 小时有效
      client_id: BROWSER_CLIENT_ID,
      is_browser_token: true,
    })
  }

  /**
   * 复制浏览器 token 缓存到新账号 ID
   */
  copyBrowserToken(fromId: string, toId: string): void {
    const cached = tokenCache.get(fromId)
    if (cached) {
      tokenCache.set(toId, { ...cached })
      log.info(`Xunlei: browser token copied from ${fromId} to ${toId}`)
    }
  }

  /**
   * alist: IsLogin - GET /v1/user/me
   */
  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      const { accessToken, captchaToken, clientId } = await ensureTokens(account, this._onCredentialRefreshed)
      await xunleiRequest(`${XLUSER_API_URL}/user/me`, 'GET', accessToken, captchaToken, clientId)
      return true
    } catch (err) {
      log.warn('Xunlei checkLogin failed:', String(err))
      return false
    }
  }

  /**
   * alist: GET /v1/user/me
   */
  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    const { accessToken, captchaToken, clientId } = await ensureTokens(account, this._onCredentialRefreshed)
    const res = await xunleiRequest<any>(`${XLUSER_API_URL}/user/me`, 'GET', accessToken, captchaToken, clientId)
    return {
      nickname: res.name || res.nickname || '迅雷用户',
      avatar: res.avatar,
    }
  }

  /**
   * alist: POST /v1/auth/signin（用户名密码登录）
   */
  async login(username: string, password: string): Promise<TokenResp> {
    const captchaRes = await getCaptchaTokenForLogin('POST:/v1/auth/signin', username)
    if (captchaRes.url) throw new Error(`需要验证: ${captchaRes.url}`)
    const captchaToken = captchaRes.captcha_token || ''

    const resp = await xunleiRequest<TokenResp>(`${XLUSER_API_URL}/auth/signin`, 'POST', '', captchaToken, ALIST_CLIENT_ID, {
      captcha_token: captchaToken,
      client_id: ALIST_CLIENT_ID,
      client_secret: ALIST_CLIENT_SECRET,
      username,
      password,
    })

    if (!resp.access_token) throw new Error('登录失败')

    // 缓存 token
    tokenCache.set('temp', {
      access_token: resp.access_token,
      token_type: resp.token_type || 'Bearer',
      refresh_token: resp.refresh_token,
      user_id: resp.user_id,
      expires_at: Date.now() + (resp.expires_in - 60) * 1000,
      client_id: ALIST_CLIENT_ID,
      is_browser_token: false,
    })

    return resp
  }

  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    const qs = new URLSearchParams({ keyword }).toString()
    const res = await xunleiRequest<any>(`${driveApi}/files?${qs}`, 'GET', accessToken, captchaToken, clientId)
    return (res.files || []).map((f: XunleiFileInfo) => mapXunleiFile(f, account.id))
  }

  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const { accessToken, captchaToken, clientId } = await ensureTokens(account, this._onCredentialRefreshed)
    const allFiles: FileItem[] = []
    let pageToken = ''

    // 浏览器客户端不使用 space 参数
    const driveApi = ALIST_DRIVE_API

    for (let page = 0; page < 100; page++) {
      const params: Record<string, string> = {
        parent_id: parentId === '0' ? '' : (parentId || ''),
        page_token: pageToken,
        filters: '{"trashed":{"eq":false}}',
        with: 'url',
        with_audit: 'true',
        thumbnail_size: 'SIZE_LARGE',
      }

      const qs = new URLSearchParams(params).toString()
      const url = `${driveApi}/files?${qs}`
      log.info(`Xunlei listFiles: ${url}`)

      try {
        const res = await xunleiRequest<any>(url, 'GET', accessToken, captchaToken, clientId)
        const items = res.files || []
        // 记录第一个文件的完整结构用于调试
        if (items.length > 0 && page === 0) {
          log.info(`Xunlei listFiles: first file: ${JSON.stringify(items[0]).substring(0, 300)}`)
        }
        allFiles.push(...items.map((f: XunleiFileInfo) => mapXunleiFile(f, account.id)))
        log.info(`Xunlei listFiles: got ${items.length} files, total=${allFiles.length}`)

        if (!res.next_page_token) break
        pageToken = res.next_page_token
      } catch (err) {
        log.error(`Xunlei listFiles error:`, String(err))
        throw err
      }
    }

    return { files: allFiles, parentId, hasMore: false }
  }

  async getQuota(account: DriveAccount): Promise<{ used: number; total: number }> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)

    // 尝试多个端点
    const endpoints = [
      `${driveApi}/about`,
      `${BROWSER_DRIVE_API}/about`,
      `${ALIST_DRIVE_API}/about`,
    ]

    for (const url of endpoints) {
      try {
        const res = await xunleiRequest<any>(url, 'GET', accessToken, captchaToken, clientId)
        log.info(`[Quota] Xunlei ${url}:`, JSON.stringify(res).substring(0, 300))

        // 迅雷 API 返回格式: { quota: { usage: "...", limit: "..." } }
        const quota = res.quota || res
        const used = Number(quota.usage) || Number(quota.used_size) || Number(quota.used) || 0
        const total = Number(quota.limit) || Number(quota.total_size) || Number(quota.total) || 0
        if (total > 0) return { used, total }
      } catch (err) {
        log.warn(`[Quota] Xunlei ${url} failed:`, String(err))
      }
    }

    throw new Error('迅雷网盘暂不支持容量查询')
  }

  async getMembership(account: DriveAccount) {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    const endpoints = [`${driveApi}/about`, `${BROWSER_DRIVE_API}/about`, `${ALIST_DRIVE_API}/about`]
    for (const url of endpoints) {
      try {
        const data = await xunleiRequest<any>(url, 'GET', accessToken, captchaToken, clientId)
        const membership = normalizeMembership(data, '迅雷')
        if (membership.known) return membership
      } catch (err) {
        log.warn(`Xunlei membership query failed for ${url}:`, String(err))
      }
    }
    return normalizeMembership(undefined, '迅雷')
  }

  async createShare(account: DriveAccount, items: Array<{ fileId: string; name?: string; isDir?: boolean }>, options?: ShareOptions): Promise<ShareInfo> {
    const { accessToken, captchaToken, clientId } = await ensureTokens(account, this._onCredentialRefreshed)
    // 浏览器客户端用 api-pan.xunlei.com
    const shareApi = clientId === BROWSER_CLIENT_ID ? BROWSER_DRIVE_API : ALIST_DRIVE_API
    // 按照迅雷网页版的实际请求格式
    const body: Record<string, unknown> = {
      title: options?.title || '云盘资源分享',
      file_ids: items.map(i => i.fileId),
      share_to: 'copy',
      expiration_days: '-1',  // 永久有效
      restore_limit: '-1',    // 不限转存次数
      params: {
        subscribe_push: 'false',
        WithPassCodeInLink: 'true',
        share_file_order: 'MODIFY_TIME_DESC',
      },
    }
    log.info(`Xunlei createShare: ${JSON.stringify(body)}`)

    const ses = session.fromPartition('persist:xunlei')
    const res = await ses.fetch(`${shareApi}/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-device-id': DEVICE_ID,
        'Authorization': `Bearer ${accessToken}`,
        'X-Captcha-Token': captchaToken,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    log.info(`Xunlei createShare response (status=${res.status}): ${text.substring(0, 500)}`)
    const data = JSON.parse(text)

    // 迅雷 API 返回格式：share_id 和 pass_code 在顶层
    const shareId = data.share_id || data.share_list?.[0]?.share_id || ''
    const shareUrl = data.share_url || (shareId ? `https://pan.xunlei.com/s/${shareId}` : '')
    const passCode = data.pass_code || data.share_list?.[0]?.pass_code || ''
    const shareTitle = body.title as string || data.title || data.share_list?.[0]?.title || ''

    if (!shareId) {
      throw new Error('迅雷分享失败：未返回 share_id')
    }

    log.info(`Xunlei createShare success: shareId=${shareId}, url=${shareUrl}, passCode=${passCode}`)

    return {
      id: shareId,
      platform: 'xunlei',
      accountId: account.id,
      fileIds: items.map(i => i.fileId),
      title: shareTitle,
      shareUrl,
      password: passCode,
      createdAt: Date.now(),
    }
  }

  async getShareDetail(account: DriveAccount, input: TransferLinkInput): Promise<ShareDetail> {
    const shareId = extractShareId(input.url)
    await ensureTokens(account, this._onCredentialRefreshed)
    log.info(`Xunlei getShareDetail: loading browser share data for shareId=${shareId}`)
    const snapshot = await loadXunleiSharePage(input, shareId)
    return {
      platform: 'xunlei',
      shareId,
      title: snapshot.title || '',
      files: (snapshot.files || []).map(file => ({
        fileId: file.fileId,
        name: file.name,
        isDir: file.isDir,
        size: file.size,
      })),
    }
  }

  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    const body = {
      kind: 'drive#folder',
      name,
      parent_id: parentId === '0' ? '' : (parentId || ''),
    }
    log.info(`Xunlei mkdir: ${JSON.stringify(body)}`)
    try {
      const ses = session.fromPartition('persist:xunlei')
      const res = await ses.fetch(`${driveApi}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-device-id': DEVICE_ID,
          'Authorization': `Bearer ${accessToken}`,
          'X-Captcha-Token': captchaToken,
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      log.info(`Xunlei mkdir response (status=${res.status}): ${text.substring(0, 300)}`)
      const data = JSON.parse(text)
      return mapXunleiFile(data, account.id)
    } catch (err) {
      log.error(`Xunlei mkdir error:`, String(err))
      throw err
    }
  }

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    log.info(`Xunlei rename: fileId=${fileId}, newName=${newName}`)
    const ses = session.fromPartition('persist:xunlei')
    const res = await ses.fetch(`${driveApi}/files/${fileId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-device-id': DEVICE_ID,
        'Authorization': `Bearer ${accessToken}`,
        'X-Captcha-Token': captchaToken,
      },
      body: JSON.stringify({ name: newName }),
    })
    log.info(`Xunlei rename response (status=${res.status})`)
  }

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    log.info(`Xunlei move: ids=${JSON.stringify(fileIds)}, target=${targetDirId}`)
    const ses = session.fromPartition('persist:xunlei')
    const res = await ses.fetch(`${driveApi}/files:batchMove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-device-id': DEVICE_ID,
        'Authorization': `Bearer ${accessToken}`,
        'X-Captcha-Token': captchaToken,
      },
      body: JSON.stringify({ ids: fileIds, to: { parent_id: targetDirId } }),
    })
    log.info(`Xunlei move response (status=${res.status})`)
  }

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    log.info(`Xunlei delete: ids=${JSON.stringify(fileIds)}`)
    try {
      const ses = session.fromPartition('persist:xunlei')
      const res = await ses.fetch(`${driveApi}/files:batchDelete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-device-id': DEVICE_ID,
          'Authorization': `Bearer ${accessToken}`,
          'X-Captcha-Token': captchaToken,
        },
        body: JSON.stringify({ ids: fileIds }),
      })
      const text = await res.text()
      log.info(`Xunlei delete response (status=${res.status}): ${text.substring(0, 300)}`)
    } catch (err) {
      log.error(`Xunlei delete error:`, String(err))
      throw err
    }
  }

  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    const url = `${driveApi}/files/${fileId}?extra=download_url`
    log.info(`Xunlei getDownloadUrl: ${url}`)
    const res = await xunleiRequest<any>(url, 'GET', accessToken, captchaToken, clientId)
    log.info(`Xunlei getDownloadUrl response: ${JSON.stringify(res).substring(0, 500)}`)
    return res.download_url || res.web_content_link || res.extra?.download_url || ''
  }

  async saveSharedFiles(account: DriveAccount, input: TransferLinkInput, targetDirId: string): Promise<TransferResult> {
    const shareId = extractShareId(input.url)
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)

    log.info(`Xunlei saveSharedFiles: shareId=${shareId}, targetDirId=${targetDirId}`)

    // Step 1: 加载分享页。提取码会拼入 URL，避免密码分享始终读不到文件。
    log.info(`Xunlei saveSharedFiles: loading browser share data`)
    const snapshot = await loadXunleiSharePage(input, shareId)
    const files = snapshot.files || []
    const passCodeToken = snapshot.passCodeToken || ''
    const fileIds = snapshot.allFileIds?.length ? snapshot.allFileIds : files.map(file => file.fileId)
    if (fileIds.length === 0) throw new Error('转存失败：迅雷分享中没有可转存文件')

    log.info(`Xunlei saveSharedFiles: found ${fileIds.length} files: ${fileIds.join(',')}`)
    log.info(`Xunlei saveSharedFiles: passCodeToken=${passCodeToken ? 'present' : 'empty'}`)

    // Step 2: 调用转存 API (POST /drive/v1/share/restore)
    const saveUrl = `${driveApi}/share/restore`
    const saveBody = {
      ancestor_ids: [],
      file_ids: fileIds,
      parent_id: targetDirId === '0' ? '' : targetDirId,
      pass_code_token: passCodeToken,
      share_id: shareId,
      specify_parent_id: true,
    }

    log.info(`Xunlei saveSharedFiles: calling ${saveUrl} with body: ${JSON.stringify(saveBody)}`)
    const ses = session.fromPartition('persist:xunlei')
    const res = await ses.fetch(saveUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-device-id': DEVICE_ID,
        'Authorization': `Bearer ${accessToken}`,
        'X-Captcha-Token': captchaToken,
        'Origin': 'https://pan.xunlei.com',
        'Referer': 'https://pan.xunlei.com/',
      },
      body: JSON.stringify(saveBody),
    })

    const text = await res.text()
    log.info(`Xunlei saveSharedFiles response (status=${res.status}): ${text.substring(0, 500)}`)

    if (res.status === 403) {
      throw new Error('转存失败：登录已失效或无权限')
    }

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`迅雷转存失败：接口返回了无效数据（HTTP ${res.status}）`)
    }

    // 检查 API 错误
    if (!res.ok || data.error || data.error_code) {
      const errMsg = data.error_description || data.error || '未知错误'
      const errCode = data.error_code || 0
      const normalizedError = String(errMsg).toLowerCase()

      if (errCode === 41001 || normalizedError.includes('login') || normalizedError.includes('token')) {
        throw new Error('转存失败：登录已失效')
      }
      if (errCode === 41014 || normalizedError.includes('share') || normalizedError.includes('expired')) {
        throw new Error('转存失败：分享已失效')
      }
      if (errCode === 41019 || errCode === 32003 || normalizedError.includes('quota') || normalizedError.includes('space')) {
        throw new Error('转存失败：容量不足')
      }
      if (errCode === 41013 || normalizedError.includes('violation') || normalizedError.includes('illegal')) {
        throw new Error('转存失败：文件违规')
      }

      throw new Error(`迅雷转存失败：${errMsg}（HTTP ${res.status}，code: ${errCode}）`)
    }

    const shareStatus = String(data.share_status || '').toUpperCase()
    if (shareStatus && shareStatus !== 'OK') {
      throw new Error(`迅雷转存失败：${data.share_status_text || shareStatus}`)
    }

    // Step 3: 轮询任务状态
    const taskId = getXunleiRestoreTaskId(data)
    if (taskId) {
      log.info(`Xunlei saveSharedFiles: task created, taskId=${taskId}, polling...`)
      const deadline = Date.now() + RESTORE_TASK_TIMEOUT_MS
      let completed = false
      let lastPhase = ''

      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, RESTORE_TASK_POLL_INTERVAL_MS))

        const taskRes = await ses.fetch(`${driveApi}/tasks/${taskId}`, {
          method: 'GET',
          headers: {
            'x-client-id': clientId,
            'x-device-id': DEVICE_ID,
            'Authorization': `Bearer ${accessToken}`,
            'X-Captcha-Token': captchaToken,
          },
        })

        const taskText = await taskRes.text()
        let taskData: any
        try {
          taskData = JSON.parse(taskText)
        } catch {
          throw new Error(`转存失败：迅雷任务状态返回了无效数据（HTTP ${taskRes.status}）`)
        }
        if (!taskRes.ok) {
          const taskError = taskData.error_description || taskData.error || taskData.message || taskRes.statusText
          throw new Error(`转存失败：无法查询迅雷任务状态（${taskError || `HTTP ${taskRes.status}`}）`)
        }

        const taskStatus = classifyXunleiTask(taskData)
        lastPhase = taskStatus.phase || lastPhase
        log.info(`Xunlei saveSharedFiles: task status=${taskStatus.phase || 'unknown'}, progress=${taskData.progress ?? taskData.data?.progress ?? ''}`)

        if (taskStatus.state === 'complete') {
          log.info(`Xunlei saveSharedFiles: task completed!`)
          completed = true
          break
        }

        if (taskStatus.state === 'failed') {
          throw new Error(`转存失败：${taskStatus.message || '迅雷任务执行失败'}`)
        }
      }

      if (!completed) {
        throw new Error(`转存超时：迅雷任务在 ${RESTORE_TASK_TIMEOUT_MS / 1000} 秒内未完成${lastPhase ? `（状态：${lastPhase}）` : ''}`)
      }
    } else if (!isXunleiRestoreComplete(data)) {
      const restoreStatus = data.restore_status || data.status || 'unknown'
      throw new Error(`迅雷转存失败：接口未返回任务 ID 或完成状态（状态：${restoreStatus}）`)
    }

    // 转存成功
    log.info(`Xunlei saveSharedFiles: success, saved ${fileIds.length} files`)

    return {
      platform: 'xunlei',
      accountId: account.id,
      sourceUrl: input.url,
      success: true,
      savedCount: fileIds.length,
      targetDirId,
      savedFileIds: fileIds,
      savedFileNames: files.map(f => f.name),
      raw: data,
    }
  }

  async upload(account: DriveAccount, localFilePath: string, targetDirId: string, options?: UploadOptions): Promise<UploadResult> {
    const fs = require('fs')
    const path = require('path')
    const crypto = require('crypto')
    options?.signal?.throwIfAborted()

    const fileName = options?.fileName || path.basename(localFilePath)
    const fileSize = fs.statSync(localFilePath).size

    // 一次性读取文件并计算所有哈希（迅雷 S3 上传需要完整 Buffer 作为 body）
    const fileBuffer = fs.readFileSync(localFilePath)
    const gcid = this.calculateGcid(fileBuffer)
    const md5Etag = crypto.createHash('md5').update(fileBuffer).digest('hex')

    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)

    // 1. 预上传 - 请求上传凭证
    const preBody = {
      kind: 'drive#file',
      parent_id: targetDirId === '0' ? '' : targetDirId,
      name: fileName,
      size: fileSize,
      hash: gcid,
      upload_type: 'UPLOAD_TYPE_RESUMABLE',
    }

    log.info(`Xunlei upload pre: ${JSON.stringify({ ...preBody, hash: gcid.substring(0, 20) + '...' })}`)

    const ses = session.fromPartition('persist:xunlei')
    const preRes = await ses.fetch(`${driveApi}/files`, {
      signal: options?.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-device-id': DEVICE_ID,
        'Authorization': `Bearer ${accessToken}`,
        'X-Captcha-Token': captchaToken,
      },
      body: JSON.stringify(preBody),
    })
    const preText = await preRes.text()
    log.info(`Xunlei upload pre response (status=${preRes.status}): ${preText.substring(0, 500)}`)

    const preData = JSON.parse(preText)

    // 检查是否秒传成功
    if (preData.file?.id) {
      log.info(`Xunlei upload: rapid upload success, fileId=${preData.file.id}`)
      return { success: true, fileId: preData.file.id, fileName, fileSize }
    }

    if (preData.upload_type !== 'UPLOAD_TYPE_RESUMABLE' || !preData.resumable?.params) {
      throw new Error('迅雷上传失败：未获取到上传凭证')
    }

    // 2. 使用 S3 兼容协议上传
    const params = preData.resumable.params
    const bucket = params.bucket
    const key = params.key
    const endpoint = params.endpoint
    const accessKeyId = params.access_key_id
    const accessKeySecret = params.access_key_secret
    const securityToken = params.security_token

    // 构建 S3 PUT 请求
    const s3Url = `https://${bucket}.${endpoint.replace(/^https?:\/\//, '')}/${key}`
    const date = new Date().toUTCString()

    // 计算签名
    const stringToPut = `PUT\n\napplication/octet-stream\n${date}\n/${bucket}/${key}`
    const signature = crypto.createHmac('sha1', accessKeySecret).update(stringToPut).digest('base64')

    log.info(`Xunlei upload: uploading to S3, size=${fileSize}`)

    const s3Res = await ses.fetch(s3Url, {
      signal: options?.signal,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Date': date,
        'Authorization': `OSS ${accessKeyId}:${signature}`,
        'x-oss-security-token': securityToken,
        'x-oss-user-agent': 'aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
      },
      body: fileBuffer,
    })

    if (!s3Res.ok) {
      const s3Text = await s3Res.text()
      throw new Error(`S3上传失败: ${s3Res.status} ${s3Text.substring(0, 200)}`)
    }

    log.info(`Xunlei upload: S3 upload success`)

    // 3. 完成上传
    const finishBody = {
      upload_type: 'UPLOAD_TYPE_RESUMABLE',
      provider: preData.resumable.provider || 'xiaomi_s3',
      bucket,
      key,
      etag: md5Etag,
    }

    const finishRes = await ses.fetch(`${driveApi}/files/upload/finish`, {
      signal: options?.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-device-id': DEVICE_ID,
        'Authorization': `Bearer ${accessToken}`,
        'X-Captcha-Token': captchaToken,
      },
      body: JSON.stringify(finishBody),
    })
    const finishText = await finishRes.text()
    log.info(`Xunlei upload finish response (status=${finishRes.status}): ${finishText.substring(0, 300)}`)

    const finishData = JSON.parse(finishText)
    const fileId = finishData.file?.id || finishData.id || ''

    return { success: true, fileId, fileName, fileSize }
  }

  private calculateGcid(buffer: Buffer): string {
    const crypto = require('crypto')
    // 迅雷 GCID 算法：分块 SHA1 哈希
    const blockSize = this.calcBlockSize(buffer.length)
    const hash1 = crypto.createHash('sha1')

    for (let i = 0; i < buffer.length; i += blockSize) {
      const chunk = buffer.slice(i, Math.min(i + blockSize, buffer.length))
      const hash2 = crypto.createHash('sha1').update(chunk).digest()
      hash1.update(hash2)
    }

    return hash1.digest('hex')
  }

  private calcBlockSize(size: number): number {
    let psize = 0x40000  // 256KB
    while (size / psize > 0x200 && psize < 0x200000) {
      psize = psize << 1
    }
    return psize
  }

  async download(account: DriveAccount, fileId: string, localDirPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    const fs = require('fs')
    options?.signal?.throwIfAborted()

    const fileName = options?.fileName || 'download'
    const localPath = resolvePathInside(localDirPath, sanitizeFileName(fileName))

    // 获取下载链接
    const downloadUrl = await this.getDownloadUrl(account, fileId)
    if (!downloadUrl) throw new Error('获取下载链接失败')

    log.info(`Xunlei download: url=${downloadUrl.substring(0, 100)}...`)

    // 下载文件
    const ses = session.fromPartition('persist:xunlei')
    const response = await ses.fetch(downloadUrl, {
      signal: options?.signal,
      headers: {
        'User-Agent': 'AndroidDownloadManager/13 (Linux; U; Android 13; M2004J7AC Build/SP1A.210812.016)',
      },
    })

    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`)
    }

    const contentLength = response.headers.get('Content-Length')
    const fileSize = contentLength ? parseInt(contentLength, 10) : 0

    const writer = fs.createWriteStream(localPath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')

    let loaded = 0
    const startTime = Date.now()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        writer.write(Buffer.from(value))
        loaded += value.length

        const elapsed = (Date.now() - startTime) / 1000
        const speed = elapsed > 0 ? loaded / elapsed : 0

        options?.onProgress?.({
          loaded,
          total: fileSize || loaded,
          percent: fileSize > 0 ? Math.round((loaded / fileSize) * 100) : 0,
          speed,
        })
      }

      writer.end()
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
      })

      log.info(`Xunlei download complete: ${localPath} (${loaded} bytes)`)
      return { success: true, localPath, fileName, fileSize: loaded }
    } catch (err) {
      reader.cancel().catch(() => {})
      writer.destroy()
      try { fs.unlinkSync(localPath) } catch {}
      throw err
    }
  }
}

export const xunleiAdapter = new XunleiAdapter()

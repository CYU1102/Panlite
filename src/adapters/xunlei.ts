import { writeDownloadResponse } from './download-response'
import { BrowserWindow, net, session } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { DriveAdapter, DriveDownloadSource } from './base'
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

async function xunleiFetchData(response: Response): Promise<any> {
  if (response.status === 204) return undefined
  let data: any
  try { data = await response.json() } catch { throw new Error(`迅雷接口响应无效 (HTTP ${response.status})`) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('迅雷接口响应无效')
  if (response.status >= 400 || data.error || (data.error_code && String(data.error_code) !== '0')) {
    throw new Error(`迅雷接口请求失败 (HTTP ${response.status}): ${data.error_description || data.message || data.error || ''}`)
  }
  return data
}

// Thunder's resumable credentials are AWS S3 credentials (Alist's
// thunder_browser driver uses region "xunlei"), not Aliyun OSS credentials.
function signXunleiS3Put(url: URL, payloadHash: string, params: Record<string, string>): Record<string, string> {
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = timestamp.slice(0, 8)
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream', host: url.host,
    'x-amz-content-sha256': payloadHash, 'x-amz-date': timestamp,
    'x-amz-security-token': params.security_token,
  }
  const names = Object.keys(headers).sort()
  const canonical = ['PUT', url.pathname, '', names.map(name => `${name}:${headers[name].trim()}\n`).join(''), names.join(';'), payloadHash].join('\n')
  const scope = `${date}/xunlei/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n')
  let signingKey: Buffer = Buffer.from(`AWS4${params.access_key_secret}`)
  for (const value of [date, 'xunlei', 's3', 'aws4_request']) signingKey = crypto.createHmac('sha256', signingKey).update(value).digest()
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${params.access_key_id}/${scope}, SignedHeaders=${names.join(';')}, Signature=${crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`
  delete headers.host // Chromium supplies Host from the URL.
  return headers
}

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
        const statusCode = response.statusCode || 0
        if (statusCode === 204 && !responseData.trim()) {
          resolve(undefined as T)
          return
        }
        let parsed: T
        try {
          parsed = JSON.parse(responseData) as T
        } catch {
          reject(new Error(statusCode >= 400
            ? `迅雷接口请求失败 (HTTP ${statusCode})`
            : `Failed to parse response: ${responseData.substring(0, 200)}`))
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('迅雷接口响应无效'))
          return
        }
        const errResp = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
        const hasErrorCode = Boolean(errResp.error_code) && String(errResp.error_code) !== '0'
        if (statusCode >= 400 || errResp.error || hasErrorCode) {
          const detail = errResp.error_description || errResp.message || ''
          const status = statusCode >= 400 ? ` (HTTP ${statusCode})` : ''
          reject(new Error(`${errResp.error || '迅雷接口请求失败'}${status}${detail ? `: ${detail}` : ''}`))
          return
        }
        resolve(parsed)
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
    const files: FileItem[] = []
    const seen = new Set<string>()
    let pageToken = ''
    for (let page = 0; page < 100; page++) {
      const qs = new URLSearchParams({ keyword, page_token: pageToken }).toString()
      const res = await xunleiRequest<any>(`${driveApi}/files?${qs}`, 'GET', accessToken, captchaToken, clientId)
      if (!Array.isArray(res.files)) throw new Error('迅雷搜索列表响应无效')
      files.push(...res.files.map((f: XunleiFileInfo) => mapXunleiFile(f, account.id)))
      if (!res.next_page_token) return files
      if (typeof res.next_page_token !== 'string' || seen.has(res.next_page_token)) throw new Error('迅雷搜索分页游标无效或重复')
      seen.add(res.next_page_token)
      pageToken = res.next_page_token
    }
    throw new Error('迅雷搜索达到分页上限，结果不完整')
  }

  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    const allFiles: FileItem[] = []
    let pageToken = ''
    const seen = new Set<string>()

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
        const items = res.files
        if (!Array.isArray(items)) throw new Error('迅雷文件列表响应无效')
        // 记录第一个文件的完整结构用于调试
        if (items.length > 0 && page === 0) {
          log.info(`Xunlei listFiles: first file: ${JSON.stringify(items[0]).substring(0, 300)}`)
        }
        allFiles.push(...items.map((f: XunleiFileInfo) => mapXunleiFile(f, account.id)))
        log.info(`Xunlei listFiles: got ${items.length} files, total=${allFiles.length}`)

        if (!res.next_page_token) return { files: allFiles, parentId, hasMore: false }
        if (typeof res.next_page_token !== 'string' || seen.has(res.next_page_token)) throw new Error('迅雷列表分页游标无效或重复')
        seen.add(res.next_page_token)
        pageToken = res.next_page_token
      } catch (err) {
        log.error(`Xunlei listFiles error:`, String(err))
        throw err
      }
    }

    throw new Error('迅雷文件列表达到分页上限，结果不完整')
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
      expiration_days: options?.expireDays && options.expireDays > 0 ? String(options.expireDays) : '-1',
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
      expiredAt: options?.expireDays && options.expireDays > 0
        ? Date.now() + options.expireDays * 24 * 60 * 60 * 1000
        : undefined,
    }
  }

  async cancelShare(account: DriveAccount, shareId: string): Promise<void> {
    if (!shareId || !/^[a-zA-Z0-9_-]+$/.test(shareId)) throw new Error('取消分享失败：分享 ID 无效')
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
    await xunleiRequest(
      `${driveApi}/share/delete`,
      'POST',
      accessToken,
      captchaToken,
      clientId,
      { space: '', share_id: shareId },
    )
    log.info(`Xunlei cancelShare success: shareId=${shareId}`)
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
      const data = await xunleiFetchData(res)
      if (typeof data?.id !== 'string' || !data.id) throw new Error('迅雷新建文件夹响应缺少 ID')
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
    await xunleiFetchData(res)
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
      body: JSON.stringify({ ids: fileIds, to: { parent_id: targetDirId === '0' ? '' : targetDirId } }),
    })
    log.info(`Xunlei move response (status=${res.status})`)
    await xunleiFetchData(res)
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
      await xunleiFetchData(res)
    } catch (err) {
      log.error(`Xunlei delete error:`, String(err))
      throw err
    }
  }

  async getDownloadSource(account: DriveAccount, fileId: string): Promise<DriveDownloadSource> {
    return {
      url: await this.getDownloadUrl!(account, fileId),
      headers: { 'User-Agent': 'AndroidDownloadManager/13 (Linux; U; Android 13; M2004J7AC Build/SP1A.210812.016)' },
      fetch: (url, init) => session.fromPartition('persist:xunlei').fetch(url, init),
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
    const allFileIds = snapshot.allFileIds?.length ? snapshot.allFileIds : files.map(file => file.fileId)
    const fileIds = input.fileIds?.length
      ? allFileIds.filter(fileId => input.fileIds!.includes(fileId))
      : allFileIds
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
      // Restore completion does not provide a verified mapping to destination
      // IDs. Source share IDs must never be used for deletion or auto-sharing.
      raw: data,
    }
  }

  async upload(account: DriveAccount, localFilePath: string, targetDirId: string, options?: UploadOptions): Promise<UploadResult> {
    options?.signal?.throwIfAborted()
    const handle = await fs.promises.open(localFilePath, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('上传路径不是普通文件')
      // This adapter implements the existing single-PUT flow. Larger objects
      // require a separate S3 multipart implementation, not a pretend success.
      if (stat.size > 5 * 1024 ** 3) throw new Error('迅雷当前单次上传仅支持不超过 5 GiB 的文件')
      const fileName = options?.fileName || path.basename(localFilePath)
      const fileSize = stat.size
      const blockSize = this.calcBlockSize(fileSize)
      const chunk = Buffer.alloc(blockSize)
      const gcidHash = crypto.createHash('sha1')
      const payloadHash = crypto.createHash('sha256')
      for (let offset = 0; offset < fileSize; offset += blockSize) {
        options?.signal?.throwIfAborted()
        const length = Math.min(blockSize, fileSize - offset)
        const { bytesRead } = await handle.read(chunk, 0, length, offset)
        if (bytesRead !== length) throw new Error('上传文件在读取过程中发生变化')
        const data = chunk.subarray(0, length)
        gcidHash.update(crypto.createHash('sha1').update(data).digest())
        payloadHash.update(data)
      }
      const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)
      options?.signal?.throwIfAborted()
      const ses = session.fromPartition('persist:xunlei')
      const preResponse = await ses.fetch(`${driveApi}/files`, {
        signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-id': clientId, 'x-device-id': DEVICE_ID, Authorization: `Bearer ${accessToken}`, 'X-Captcha-Token': captchaToken },
        body: JSON.stringify({ kind: 'drive#file', parent_id: targetDirId === '0' ? '' : targetDirId, name: fileName, size: fileSize, hash: gcidHash.digest('hex'), upload_type: 'UPLOAD_TYPE_RESUMABLE' }),
      })
      const preData = await xunleiFetchData(preResponse)
      options?.signal?.throwIfAborted()
      const fileId = preData?.file?.id
      if (typeof fileId !== 'string' || !fileId) throw new Error('迅雷上传响应缺少文件 ID')
      if (preData.upload_type !== 'UPLOAD_TYPE_RESUMABLE') {
        if (preData.file.phase !== 'PHASE_TYPE_COMPLETE') throw new Error('迅雷未确认秒传完成，请核对远端结果')
        options?.onProgress?.({ loaded: fileSize, total: fileSize, percent: 100, speed: 0 })
        return { success: true, fileId, fileName, fileSize }
      }
      const params = preData.resumable?.params
      if (!params || ['bucket', 'key', 'endpoint', 'access_key_id', 'access_key_secret', 'security_token'].some(name => typeof params[name] !== 'string' || !params[name])) {
        throw new Error('迅雷上传响应缺少有效的 S3 上传凭证')
      }
      const endpoint = new URL(/^https?:\/\//i.test(params.endpoint) ? params.endpoint : `https://${params.endpoint}`)
      if (endpoint.protocol !== 'https:' || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('迅雷 S3 上传地址无效')
      if (!endpoint.hostname.startsWith(`${params.bucket}.`)) endpoint.hostname = `${params.bucket}.${endpoint.hostname}`
      const encodedKey = params.key.split('/').map((segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
      endpoint.pathname = `/${encodedKey}`
      const headers = signXunleiS3Put(endpoint, payloadHash.digest('hex'), params)
      const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000)
      const source = Readable.from((async function* () {
        for (let offset = 0; offset < fileSize; offset += blockSize) {
          signal.throwIfAborted()
          const length = Math.min(blockSize, fileSize - offset)
          // Own each yielded buffer until the network has consumed it.
          const data = Buffer.alloc(length)
          const { bytesRead } = await handle.read(data, 0, length, offset)
          if (bytesRead !== length) throw new Error('上传文件在读取过程中发生变化')
          yield data
          options?.onProgress?.({ loaded: offset + length, total: fileSize, percent: Math.min(99, Math.round((offset + length) / fileSize * 100)), speed: 0 })
        }
      })())
      try {
        const response = await ses.fetch(endpoint.toString(), {
          method: 'PUT', signal, headers: { ...headers, 'Content-Length': String(fileSize) },
          body: Readable.toWeb(source) as unknown as BodyInit,
        })
        signal.throwIfAborted()
        if (!response.ok) throw new Error(`迅雷 S3 上传失败 (HTTP ${response.status})`)
        // A successful S3 PutObject stores the object. The reference driver
        // needs no extra /files/upload/finish endpoint.
        options?.onProgress?.({ loaded: fileSize, total: fileSize, percent: 100, speed: 0 })
        return { success: true, fileId, fileName, fileSize }
      } finally {
        source.destroy()
      }
    } finally {
      await handle.close()
    }
  }
  private calcBlockSize(size: number): number {
    let psize = 0x40000  // 256KB
    while (size / psize > 0x200 && psize < 0x200000) {
      psize = psize << 1
    }
    return psize
  }

  async download(account: DriveAccount, fileId: string, localDirPath: string, options?: DownloadOptions): Promise<DownloadResult> {
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

    const loaded = await writeDownloadResponse(response, localPath, options)
    return { success: true, localPath, fileName, fileSize: loaded }
  }
}

export const xunleiAdapter = new XunleiAdapter()

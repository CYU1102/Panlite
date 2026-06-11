import { net, session } from 'electron'
import type { DriveAdapter } from './base'
import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, ShareTaskPayload, TransferLinkInput, TransferResult, UploadOptions, UploadResult, DownloadOptions, DownloadResult } from '../shared/types'
import log from 'electron-log'

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
const ALIST_CLIENT_VERSION = '1.10.0.2633'
const ALIST_PACKAGE_NAME = 'com.xunlei.browser'
const ALIST_DRIVE_API = 'https://x-api-pan.xunlei.com/drive/v1'

// 通用配置
const XLUSER_API_URL = 'https://xluser-ssl.xunlei.com/v1'
const DEVICE_ID = '925b7631473a13716b791d7f28289cad'

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
    log.info(`Xunlei: captcha token response: ${JSON.stringify(result).substring(0, 200)}`)

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
    const res = await ses.fetch(`${BROWSER_DRIVE_API}/share`, {
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
    const { accessToken, captchaToken, clientId, driveApi } = await ensureTokens(account, this._onCredentialRefreshed)

    // 尝试多个可能的分享详情端点
    const endpoints = [
      // GET 请求
      { url: `${driveApi}/share/${shareId}`, method: 'GET' as const },
      { url: `${driveApi}/share/${shareId}/detail`, method: 'GET' as const },
      { url: `${BROWSER_DRIVE_API}/share/${shareId}`, method: 'GET' as const },
      { url: `${ALIST_DRIVE_API}/share/${shareId}`, method: 'GET' as const },
      // POST 请求（某些 API 使用 POST 获取详情）
      { url: `${driveApi}/share/detail`, method: 'POST' as const, body: { share_id: shareId } },
      { url: `${BROWSER_DRIVE_API}/share/detail`, method: 'POST' as const, body: { share_id: shareId } },
      { url: `${ALIST_DRIVE_API}/share/detail`, method: 'POST' as const, body: { share_id: shareId } },
      // 尝试 /share/list 端点
      { url: `${driveApi}/share/list`, method: 'POST' as const, body: { share_id: shareId } },
      { url: `${BROWSER_DRIVE_API}/share/list`, method: 'POST' as const, body: { share_id: shareId } },
    ]

    for (const endpoint of endpoints) {
      try {
        log.info(`Xunlei getShareDetail: trying ${endpoint.url} (${endpoint.method})`)
        const res = endpoint.method === 'POST'
          ? await xunleiRequest<any>(endpoint.url, 'POST', accessToken, captchaToken, clientId, endpoint.body)
          : await xunleiRequest<any>(endpoint.url, 'GET', accessToken, captchaToken, clientId)
        log.info(`Xunlei getShareDetail response: ${JSON.stringify(res).substring(0, 500)}`)

        // 检查是否有文件列表
        const files = res.files || res.share_list?.[0]?.files || res.data?.files || []
        if (files.length > 0 || res.title || res.data?.title) {
          return {
            platform: 'xunlei',
            shareId,
            title: res.title || res.share_list?.[0]?.title || res.data?.title || '',
            files: files.map((f: any) => ({
              fileId: f.id || f.file_id || '',
              name: f.name || f.file_name || '',
              isDir: f.kind === 'folder' || f.is_dir === true,
              size: f.size || 0,
            })),
          }
        }
      } catch (err) {
        log.warn(`Xunlei getShareDetail [${endpoint.url}] failed:`, String(err))
      }
    }

    // 所有端点都失败，返回空
    log.warn(`Xunlei getShareDetail: all endpoints failed for shareId=${shareId}`)
    return {
      platform: 'xunlei',
      shareId,
      title: '',
      files: [],
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
    const { accessToken, captchaToken, clientId } = await ensureTokens(account, this._onCredentialRefreshed)

    log.info(`Xunlei saveSharedFiles: shareId=${shareId}, targetDirId=${targetDirId}`)

    // Step 1: 使用 BrowserWindow 加载分享页面，从 __NUXT__ 中提取数据
    let files: Array<{ fileId: string; name: string }> = []
    let passCodeToken = ''
    let allFileIds: string[] = []

    try {
      log.info(`Xunlei saveSharedFiles: loading share page in BrowserWindow`)
      const { BrowserWindow } = require('electron')

      const shareWindow = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          partition: 'persist:xunlei',
          nodeIntegration: false,
          contextIsolation: true,
        },
      })

      const sharePageUrl = `https://pan.xunlei.com/s/${shareId}`
      await shareWindow.loadURL(sharePageUrl)

      // 等待页面加载和 JavaScript 执行
      await new Promise(resolve => setTimeout(resolve, 5000))

      // 从 __NUXT__ 中提取分享数据
      const nuxtData = await shareWindow.webContents.executeJavaScript(`
        (function() {
          try {
            if (window.__NUXT__ && window.__NUXT__.state && window.__NUXT__.state.share) {
              var share = window.__NUXT__.state.share;
              return {
                files: share.files || {},
                list: share.list || [],
                passCodeToken: (share.shareInfo && share.shareInfo.passCodeToken) || '',
                getAllFilesId: share.getAllFilesId || []
              };
            }
            return null;
          } catch(e) {
            return { error: e.message };
          }
        })()
      `)

      shareWindow.close()

      log.info(`Xunlei saveSharedFiles: __NUXT__ data: ${JSON.stringify(nuxtData).substring(0, 500)}`)

      if (nuxtData && !nuxtData.error) {
        // 提取文件列表
        const filesMap = nuxtData.files || {}
        for (const [fileId, fileObj] of Object.entries(filesMap)) {
          const f = fileObj as any
          files.push({
            fileId: f.id || fileId,
            name: f.name || '',
          })
        }

        // 如果 files 为空，使用 list
        if (files.length === 0 && nuxtData.list) {
          for (const fileId of nuxtData.list) {
            files.push({ fileId, name: '' })
          }
        }

        // 使用 getAllFilesId 作为备选
        if (files.length === 0 && nuxtData.getAllFilesId) {
          for (const fileId of nuxtData.getAllFilesId) {
            files.push({ fileId, name: '' })
          }
        }

        passCodeToken = nuxtData.passCodeToken || ''
        allFileIds = nuxtData.getAllFilesId || files.map(f => f.fileId)
      }
    } catch (err) {
      log.warn(`Xunlei saveSharedFiles: BrowserWindow approach failed:`, String(err))
    }

    if (files.length === 0) {
      throw new Error('转存失败：分享中没有文件或无法获取分享详情')
    }

    const fileIds = allFileIds.length > 0 ? allFileIds : files.map(f => f.fileId)
    log.info(`Xunlei saveSharedFiles: found ${fileIds.length} files: ${fileIds.join(',')}`)
    log.info(`Xunlei saveSharedFiles: passCodeToken=${passCodeToken.substring(0, 30)}...`)

    // Step 2: 调用转存 API (POST /drive/v1/share/restore)
    const saveUrl = `${BROWSER_DRIVE_API}/share/restore`
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

    const data = JSON.parse(text)

    // 检查 API 错误
    if (data.error || data.error_code) {
      const errMsg = data.error_description || data.error || '未知错误'
      const errCode = data.error_code || 0

      if (errCode === 41001 || errMsg.includes('login') || errMsg.includes('token')) {
        throw new Error('转存失败：登录已失效')
      }
      if (errCode === 41014 || errMsg.includes('share') || errMsg.includes('expired')) {
        throw new Error('转存失败：分享已失效')
      }
      if (errCode === 41019 || errCode === 32003 || errMsg.includes('quota') || errMsg.includes('space')) {
        throw new Error('转存失败：容量不足')
      }
      if (errCode === 41013 || errMsg.includes('violation') || errMsg.includes('illegal')) {
        throw new Error('转存失败：文件违规')
      }

      throw new Error(`迅雷转存失败: ${errMsg} (code: ${errCode})`)
    }

    // Step 3: 轮询任务状态
    const taskId = data.id || data.task_id
    if (taskId) {
      log.info(`Xunlei saveSharedFiles: task created, taskId=${taskId}, polling...`)

      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000))

        const taskRes = await ses.fetch(`${BROWSER_DRIVE_API}/tasks/${taskId}`, {
          method: 'GET',
          headers: {
            'x-client-id': clientId,
            'x-device-id': DEVICE_ID,
            'Authorization': `Bearer ${accessToken}`,
            'X-Captcha-Token': captchaToken,
          },
        })

        const taskText = await taskRes.text()
        const taskData = JSON.parse(taskText)
        log.info(`Xunlei saveSharedFiles: task status=${taskData.phase}, progress=${taskData.progress}`)

        if (taskData.phase === 'PHASE_TYPE_COMPLETE') {
          log.info(`Xunlei saveSharedFiles: task completed!`)
          break
        }

        if (taskData.phase === 'PHASE_TYPE_FAILED') {
          throw new Error(`转存失败：${taskData.message || '任务失败'}`)
        }
      }
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
    const path = require('path')

    const fileName = options?.fileName || 'download'
    const localPath = path.join(localDirPath, fileName)

    // 获取下载链接
    const downloadUrl = await this.getDownloadUrl(account, fileId)
    if (!downloadUrl) throw new Error('获取下载链接失败')

    log.info(`Xunlei download: url=${downloadUrl.substring(0, 100)}...`)

    // 下载文件
    const ses = session.fromPartition('persist:xunlei')
    const response = await ses.fetch(downloadUrl, {
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

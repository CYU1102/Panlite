import { net, session, BrowserWindow } from 'electron'
import type { DriveAdapter } from './base'
import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, ShareTaskPayload, TransferLinkInput, TransferResult, UploadOptions, UploadResult, DownloadOptions, DownloadResult } from '../shared/types'
import { generateId, sleep } from '../shared/utils'
import log from 'electron-log'

const BAIDU_API = 'https://pan.baidu.com/rest/2.0/xpan'
const BAIDU_BASE = 'https://pan.baidu.com'
const BAIDU_OAUTH_TOKEN = 'https://openapi.baidu.com/oauth/2.0/token'
// 参照 BaiduPanFilesTransfers constants.py 使用的 User-Agent
const BAIDU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let _clientId = process.env.BAIDU_CLIENT_ID || ''
let _clientSecret = process.env.BAIDU_CLIENT_SECRET || ''
let _redirectUri = process.env.BAIDU_REDIRECT_URI || 'https://openapi.baidu.com/qrcode/1'

export function setBaiduCredentials(clientId: string, clientSecret: string, redirectUri?: string) {
  _clientId = clientId; _clientSecret = clientSecret; if (redirectUri) _redirectUri = redirectUri
}

function ensureBaiduCredentials(): void {
  if (!_clientId || !_clientSecret) throw new Error('Baidu OAuth credentials not configured.')
}

// ── 百度错误码映射 ──

const BAIDU_ERROR_CODES: Record<number, string> = {
  [-1]: '链接错误，链接失效或缺少提取码',
  [-4]: '转存失败，无效登录。请退出账号在其他地方的登录',
  [-6]: '转存失败，请用浏览器无痕模式获取 Cookie 后再试',
  [-7]: '转存失败，转存文件夹名有非法字符',
  [-8]: '转存失败，目录中已有同名文件或文件夹存在',
  [-9]: '链接错误，提取码错误',
  [-10]: '转存失败，容量不足',
  [-12]: '链接错误，提取码错误',
  [-62]: '转存失败，链接访问次数过多，请稍后再试',
  [0]: '转存成功',
  [2]: '转存失败，目标目录不存在',
  [4]: '转存失败，目录中存在同名文件',
  [12]: '转存失败，转存文件数超过限制',
  [20]: '转存失败，容量不足',
  [105]: '链接错误，所访问的页面不存在',
  [404]: '转存失败，秒传无效',
}

function getBaiduErrorMessage(errno: number, action: string): string {
  const msg = BAIDU_ERROR_CODES[errno] || `未知错误 (errno=${errno})`
  return `${action}失败: ${msg}`
}

// ── 接口定义 ──

interface BaiduUserInfo { uk: string; baidu_name: string; netdisk_name: string; avatar_url: string; vip_type: number }
interface BaiduFileItem { fs_id: number; path: string; server_filename: string; isdir: number; size: number; local_ctime: number; local_mtime: number; server_ctime: number; server_mtime: number; category: number }
interface BaiduFileListData { list: BaiduFileItem[]; has_more: number; errno?: number }
interface BaiduSearchData { list: BaiduFileItem[]; has_more?: number; errno?: number }
interface BaiduCreateData { fs_id: number; path: string; isdir: number; create_time: number }
interface BaiduFileOperateData { errno: number; errmsg?: string; info: { path: string; newname?: string }[] }

// ── 链接标准化 ──

function normalizeBaiduLink(raw: string): string {
  let normalized = raw
  normalized = normalized.replace(/share\/init\?surl=/, 's/1')
  normalized = normalized.replace(/[?&]pwd=/g, ' ')
  normalized = normalized.replace(/提取码[：:]\s*/g, ' ')
  normalized = normalized.replace(/^.*?(https?:\/\/)/, 'https://')
  normalized = normalized.replace(/^http:\/\//, 'https://')
  normalized = normalized.replace(/\s+/g, ' ').trim()
  return normalized
}

function parseUrlAndCode(normalized: string): { url: string; password: string } {
  const parts = normalized.split(' ')
  const url = parts[0] || ''
  let password = (parts[1] || '').trim()
  if (password && !/^[a-zA-Z0-9]{4}$/.test(password)) {
    password = ''
  }
  return { url, password }
}

// ── HTML 解析 ──

const SHARE_ID_REGEX = /"shareid":(\d+?),"/
const USER_ID_REGEX = /"share_uk":"(\d+?)","/
const FS_ID_REGEX = /"fs_id":(\d+?),"/g
const SERVER_FILENAME_REGEX = /"server_filename":"(.+?)","/g
const ISDIR_REGEX = /"isdir":(\d+?),"/g

interface ParsedSharePage {
  shareid: string
  shareUk: string
  fsIds: string[]
  filenames: string[]
  isDirs: string[]
}

function parseSharePageHtml(html: string): ParsedSharePage | null {
  const shareidMatch = SHARE_ID_REGEX.exec(html)
  const userMatch = USER_ID_REGEX.exec(html)
  if (!shareidMatch || !userMatch) return null

  const fsIds: string[] = []
  const filenames: string[] = []
  const isDirs: string[] = []

  let match: RegExpExecArray | null
  while ((match = FS_ID_REGEX.exec(html)) !== null) fsIds.push(match[1])
  while ((match = SERVER_FILENAME_REGEX.exec(html)) !== null) filenames.push(match[1])
  while ((match = ISDIR_REGEX.exec(html)) !== null) isDirs.push(match[1])

  if (fsIds.length === 0) return null

  return {
    shareid: shareidMatch[1],
    shareUk: userMatch[1],
    fsIds,
    filenames: [...new Set(filenames)],
    isDirs,
  }
}

// ── Cookie 管理 ──

function updateCookieBdclnd(bdclnd: string, cookie: string): string {
  const cookiesDict: Record<string, string> = {}
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    cookiesDict[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1)
  }
  cookiesDict['BDCLND'] = bdclnd
  return Object.entries(cookiesDict).map(([k, v]) => `${k}=${v}`).join(';')
}

function generateRandomPwd(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length))
  return result
}


// ── 网络请求层 ──

const BAIDU_SESSION = 'persist:baidu'

async function injectBaiduCookies(cookieStr: string): Promise<void> {
  const ses = session.fromPartition(BAIDU_SESSION)
  const pairs = cookieStr.split(';').map((p) => p.trim()).filter(Boolean)
  // 设置 cookie 1 年后过期（参照 BaiduPanFilesTransfers 长期保存 cookie）
  const longExpires = Date.now() + 365 * 24 * 60 * 60 * 1000
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx < 1) continue
    const name = pair.substring(0, eqIdx).trim()
    const value = pair.substring(eqIdx + 1).trim()
    if (!name) continue
    try {
      await ses.cookies.set({
        url: 'https://pan.baidu.com',
        name, value,
        domain: '.baidu.com',
        path: '/',
        secure: true,
        expirationDate: longExpires,
      })
    } catch { /* ignore */ }
  }
}

/**
 * 通过内置浏览器转存百度网盘分享文件
 * 完全模拟真实浏览器操作，解决 Electron HTTP 客户端 POST 请求兼容性问题
 */
async function baiduTransferViaBrowser(
  cookies: string,
  shareUrl: string,
  password: string | undefined,
  targetDirId: string,
): Promise<{ success: boolean; savedCount: number; savedFilePaths: string[]; error?: string }> {
  // 注入 cookie 到 session
  await injectBaiduCookies(cookies)

  return new Promise((resolve) => {
    let resolved = false

    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: true,
      title: '百度网盘转存中...',
      webPreferences: {
        partition: BAIDU_SESSION,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    // 设置 User-Agent
    const ses = session.fromPartition(BAIDU_SESSION)
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['User-Agent'] = BAIDU_UA
      callback({ requestHeaders: details.requestHeaders })
    })

    // 监听转存 API 响应
    ses.webRequest.onCompleted((details) => {
      if (details.url.includes('/share/transfer') && details.method === 'POST') {
        log.info(`Baidu browser: transfer response status=${details.statusCode}`)
      }
    })

    // 超时保护（60秒）
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        win.destroy()
        resolve({ success: false, savedCount: 0, savedFilePaths: [], error: '浏览器转存超时' })
      }
    }, 60000)

    function cleanup() {
      clearTimeout(timeout)
      if (!win.isDestroyed()) win.destroy()
    }

    // 加载分享页面
    log.info(`Baidu browser: loading ${shareUrl}`)
    win.loadURL(shareUrl)

    win.webContents.on('did-finish-load', async () => {
      try {
        const currentUrl = win.webContents.getURL()
        log.info(`Baidu browser: page loaded, url=${currentUrl}`)

        // 检查是否需要输入密码
        const needPwd = await win.webContents.executeJavaScript(`
          !!(document.querySelector('.pickpw') || document.querySelector('[class*="提取码"]') || document.querySelector('input[placeholder*="提取码"]'))
        `).catch(() => false)

        if (needPwd && password) {
          log.info('Baidu browser: filling password...')
          await win.webContents.executeJavaScript(`
            var input = document.querySelector('input[placeholder*="提取码"]') || document.querySelector('.pickpw input');
            if (input) {
              input.value = ${JSON.stringify(password)};
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            var btn = document.querySelector('.pickpw-btn') || document.querySelector('button[class*="提取"]') || document.querySelector('.g-button');
            if (btn) btn.click();
          `).catch(() => {})
          // 等待密码验证完成
          await new Promise(r => setTimeout(r, 3000))
        }

        // 等待文件列表加载
        let retries = 0
        while (retries < 20) {
          const hasFiles = await win.webContents.executeJavaScript(`
            !!(document.querySelector('[class*="file-list"]') || document.querySelector('[class*="share-file"]') || document.querySelector('.module-fileList') || document.querySelector('[data-v-]') || document.querySelector('table'))
          `).catch(() => false)

          if (hasFiles) break
          await new Promise(r => setTimeout(r, 1000))
          retries++
        }

        // 获取 bdstoken
        const bdstoken = await win.webContents.executeJavaScript(`
          (function() {
            // 从 cookie 获取
            var match = document.cookie.match(/bdstoken=([^;]+)/);
            if (match) return match[1];
            // 从页面变量获取
            try { return window.locals && window.locals.bdstoken || ''; } catch(e) {}
            return '';
          })()
        `).catch(() => '')

        log.info(`Baidu browser: bdstoken=${bdstoken ? 'OK' : 'EMPTY'}`)

        // 从页面获取 shareid、uk、fs_id 列表
        const pageInfo = await win.webContents.executeJavaScript(`
          (function() {
            var result = { shareid: '', uk: '', fsIds: [], filenames: [] };
            try {
              // 从 URL 获取 shareid
              var match = location.pathname.match(/\\/s\\/([^/?]+)/);
              if (match) result.shareid = match[1];

              // 从页面 HTML 中提取参数
              var html = document.documentElement.innerHTML;
              var shareidMatch = html.match(/"shareid":(\\d+?),"/);
              if (shareidMatch) result.shareid = shareidMatch[1];
              var ukMatch = html.match(/"share_uk":"(\\d+?)","/);
              if (ukMatch) result.uk = ukMatch[1];

              // 提取 fs_id 列表
              var fsidRegex = /"fs_id":(\\d+?),"/g;
              var m;
              while ((m = fsidRegex.exec(html)) !== null) result.fsIds.push(m[1]);

              // 提取文件名
              var fnameRegex = /"server_filename":"(.+?)","/g;
              while ((m = fnameRegex.exec(html)) !== null) result.filenames.push(m[1]);
            } catch(e) {}
            return result;
          })()
        `).catch(() => ({ shareid: '', uk: '', fsIds: [], filenames: [] }))

        log.info(`Baidu browser: shareid=${pageInfo.shareid}, uk=${pageInfo.uk}, fsIds=${pageInfo.fsIds.length}`)

        if (!pageInfo.shareid || pageInfo.fsIds.length === 0) {
          cleanup()
          resolved = true
          resolve({ success: false, savedCount: 0, savedFilePaths: [], error: '解析分享页面失败，可能链接已失效或需要提取码' })
          return
        }

        // 通过浏览器 fetch 调用转存 API（在页面上下文中执行，自动携带 cookie）
        const targetPath = targetDirId === '0' ? '/' : targetDirId
        const transferResult = await win.webContents.executeJavaScript(`
          (async function() {
            var params = new URLSearchParams({
              shareid: ${JSON.stringify(pageInfo.shareid)},
              from: ${JSON.stringify(pageInfo.uk)},
              bdstoken: ${JSON.stringify(bdstoken)},
              channel: 'chunlei',
              web: '1',
              clienttype: '0'
            });
            var body = new URLSearchParams({
              fsidlist: JSON.stringify(${JSON.stringify(pageInfo.fsIds)}),
              path: ${JSON.stringify(targetPath)}
            });
            try {
              var resp = await fetch('/share/transfer?' + params.toString(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
              });
              var data = await resp.json();
              return JSON.stringify(data);
            } catch(e) {
              return JSON.stringify({ errno: -1, errmsg: e.message });
            }
          })()
        `).catch((e: Error) => JSON.stringify({ errno: -1, errmsg: e.message }))

        log.info(`Baidu browser: transfer result=${transferResult}`)

        // 先设置 resolved 再 cleanup，避免 closed 事件覆盖结果
        resolved = true
        cleanup()

        try {
          const result = JSON.parse(transferResult)
          if (result.errno === 0 || result.errno === 4) {
            // errno=0 成功，errno=4 同名文件已存在（也算成功）
            const savedFilePaths: string[] = []
            if (result.info && Array.isArray(result.info)) {
              for (const item of result.info) {
                if (item.errno === 0 && item.path) savedFilePaths.push(item.path)
              }
            }
            // 从 duplicated 中提取路径
            if (result.duplicated?.list) {
              for (const item of result.duplicated.list) {
                if (item.path) savedFilePaths.push(item.path)
              }
            }
            resolve({
              success: true,
              savedCount: pageInfo.fsIds.length,
              savedFilePaths,
            })
          } else {
            resolve({
              success: false,
              savedCount: 0,
              savedFilePaths: [],
              error: getBaiduErrorMessage(result.errno, '转存'),
            })
          }
        } catch {
          resolve({
            success: false,
            savedCount: 0,
            savedFilePaths: [],
            error: `转存响应解析失败: ${transferResult.substring(0, 200)}`,
          })
        }
      } catch (err) {
        log.error('Baidu browser: error:', String(err))
        cleanup()
        if (!resolved) {
          resolved = true
          resolve({ success: false, savedCount: 0, savedFilePaths: [], error: String(err) })
        }
      }
    })

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      log.error(`Baidu browser: load failed (${code}): ${desc}`)
      cleanup()
      if (!resolved) {
        resolved = true
        resolve({ success: false, savedCount: 0, savedFilePaths: [], error: `页面加载失败: ${desc}` })
      }
    })

    win.on('closed', () => {
      cleanup()
      if (!resolved) {
        resolved = true
        resolve({ success: false, savedCount: 0, savedFilePaths: [], error: '浏览器窗口已关闭' })
      }
    })
  })
}

/**
 * 百度 API 请求
 * 完全参照 BaiduPanFilesTransfers：headers 中直接包含 Cookie，用 net.request 发送
 * 不使用 session，不注入 cookie 到 session store
 */
async function baiduRequest<T>(
  url: string, accessToken: string,
  options: { method?: string; body?: Record<string, unknown> | string; params?: Record<string, string>; cookies?: string; formBody?: boolean; extraHeaders?: Record<string, string> } = {},
): Promise<T> {
  const method = options.method || 'GET'
  const cleanedParams: Record<string, string> = {}
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== '' && v !== undefined && v !== null) cleanedParams[k] = v
    }
  }
  let fullUrl = url
  if (Object.keys(cleanedParams).length > 0) {
    const qs = new URLSearchParams(cleanedParams).toString()
    fullUrl += (fullUrl.includes('?') ? '&' : '?') + qs
  }

  return new Promise((resolve, reject) => {
    const request = net.request({ method, url: fullUrl })

    // 完全参照 BaiduPanFilesTransfers headers：只设 User-Agent、Cookie
    request.setHeader('User-Agent', BAIDU_UA)
    if (options.cookies) request.setHeader('Cookie', options.cookies)

    // 应用额外的 headers
    if (options.extraHeaders) {
      for (const [k, v] of Object.entries(options.extraHeaders)) {
        request.setHeader(k, v)
      }
    }

    if (options.body) {
      if (options.formBody) {
        // 参照 BaiduPanFilesTransfers: data=data (form-encoded)
        const formStr = new URLSearchParams(Object.entries(options.body).map(([k, v]) => [k, String(v)])).toString()
        if (!options.extraHeaders?.['Content-Type']) {
          request.setHeader('Content-Type', 'application/x-www-form-urlencoded')
        }
        request.setHeader('Content-Length', String(Buffer.byteLength(formStr)))
        request.write(formStr)
      } else if (typeof options.body === 'string') {
        // 字符串 body 直接发送
        if (!options.extraHeaders?.['Content-Type']) {
          request.setHeader('Content-Type', 'application/x-www-form-urlencoded')
        }
        request.setHeader('Content-Length', String(Buffer.byteLength(options.body)))
        request.write(options.body)
      } else {
        const bodyStr = JSON.stringify(options.body)
        if (!options.extraHeaders?.['Content-Type']) {
          request.setHeader('Content-Type', 'application/json')
        }
        request.setHeader('Content-Length', String(Buffer.byteLength(bodyStr)))
        request.write(bodyStr)
      }
    }

    let responseData = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseData += chunk.toString() })
      response.on('end', () => {
        try { resolve(JSON.parse(responseData) as T) }
        catch { reject(new Error(`Failed to parse Baidu API response: ${responseData.substring(0, 200)}`)) }
      })
      response.on('error', (err) => reject(err))
    })
    request.on('error', (err) => reject(err))
    request.end()
  })
}

/**
 * 原始 HTTP 请求（返回文本，用于获取 HTML 页面）
 * 参照 BaiduPanFilesTransfers get_transfer_params
 */
async function baiduRawRequest(
  url: string,
  options: { method?: string; cookies?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: options.method || 'GET', url })
    request.setHeader('User-Agent', BAIDU_UA)
    if (options.cookies) request.setHeader('Cookie', options.cookies)

    let responseData = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseData += chunk.toString() })
      response.on('end', () => {
        resolve({ status: response.statusCode || 0, body: responseData })
      })
      response.on('error', (err) => reject(err))
    })
    request.on('error', (err) => reject(err))
    request.end()
  })
}

// ── 工具函数 ──

function getParentPath(filePath: string): string {
  const idx = filePath.lastIndexOf('/'); if (idx <= 0) return '/'; return filePath.substring(0, idx)
}

function mapBaiduFile(f: BaiduFileItem, accountId: string): FileItem {
  return {
    id: f.path, path: f.path, parentId: getParentPath(f.path), name: f.server_filename,
    isDir: f.isdir === 1, size: f.size || 0,
    createdAt: (f.server_ctime || f.local_ctime) * 1000, updatedAt: (f.server_mtime || f.local_mtime) * 1000,
    platform: 'baidu', accountId, raw: { fs_id: f.fs_id },
  }
}

// ── 适配器 ──

export class BaiduAdapter implements DriveAdapter {
  private _onCredentialRefreshed?: (accountId: string, credential: DriveAccount['credential']) => void
  private _bdstoken: string = ''
  private _bdstokenExpiresAt: number = 0
  private _keepaliveTimers: Map<string, ReturnType<typeof setInterval>> = new Map()

  setCredentialRefreshHandler(handler: (accountId: string, credential: DriveAccount['credential']) => void): void {
    this._onCredentialRefreshed = handler
  }

  /**
   * 启动 Cookie 保活定时器
   * 每 5 分钟发一次轻量请求，防止百度服务端 session 过期
   */
  startKeepalive(account: DriveAccount): void {
    if (!this.isCookieLogin(account)) return
    const cookies = account.credential.cookies
    if (!cookies) return

    this.stopKeepalive(account.id)
    log.info(`Baidu: starting keepalive for account ${account.id}`)

    const timer = setInterval(async () => {
      try {
        const params = { method: 'uinfo' }
        await baiduRequest<BaiduUserInfo>(`${BAIDU_API}/nas`, '', { params, cookies })
        log.info(`Baidu keepalive: session alive for ${account.nickname || account.id}`)
      } catch (err) {
        log.warn(`Baidu keepalive failed for ${account.nickname || account.id}:`, String(err))
      }
    }, 5 * 60 * 1000) // 每 5 分钟

    this._keepaliveTimers.set(account.id, timer)
  }

  /**
   * 停止 Cookie 保活定时器
   */
  stopKeepalive(accountId: string): void {
    const timer = this._keepaliveTimers.get(accountId)
    if (timer) {
      clearInterval(timer)
      this._keepaliveTimers.delete(accountId)
      log.info(`Baidu: stopped keepalive for account ${accountId}`)
    }
  }

  private isCookieLogin(account: DriveAccount): boolean {
    return !account.credential.accessToken && !!account.credential.cookies
  }

  private async ensureToken(account: DriveAccount): Promise<string> {
    const cred = account.credential
    if (!cred.accessToken) return ''
    if (!cred.expiresAt || cred.expiresAt > Date.now() + 5 * 60 * 1000) return cred.accessToken
    if (!cred.refreshToken) throw new Error('Access token expired and no refresh token available')
    log.info('Baidu: access token expired, refreshing...')
    const refreshResult = await baiduRefreshToken(cred.refreshToken)
    const newCredential: DriveAccount['credential'] = {
      accessToken: refreshResult.access_token, refreshToken: refreshResult.refresh_token,
      expiresAt: Date.now() + refreshResult.expires_in * 1000,
    }
    log.info('Baidu: token refreshed successfully')
    if (this._onCredentialRefreshed) this._onCredentialRefreshed(account.id, newCredential)
    return refreshResult.access_token
  }

  private getBaiduCookies(account: DriveAccount): string {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('百度分享/转存功能需要 Cookie 认证（BDUSS），请使用 Cookie 方式登录百度账号')
    return cookies
  }

  private async fetchBdstoken(cookies: string): Promise<string> {
    if (this._bdstoken && this._bdstokenExpiresAt > Date.now()) return this._bdstoken

    const params = {
      clienttype: '0',
      app_id: '38824127',
      web: '1',
      fields: '["bdstoken","token","uk","isdocuser","servertime"]',
    }

    const qs = new URLSearchParams(params).toString()
    const url = `${BAIDU_BASE}/api/gettemplatevariable?${qs}`

    try {
      const res = await baiduRequest<{ errno: number; result?: { bdstoken?: string } }>(
        url, '', { cookies },
      )
      if (res.errno === 0 && res.result?.bdstoken) {
        this._bdstoken = res.result.bdstoken
        // bdstoken 缓存 5 分钟（百度服务端可能随时失效）
        this._bdstokenExpiresAt = Date.now() + 5 * 60 * 1000
        log.info('Baidu: bdstoken fetched successfully')
        return this._bdstoken
      }
      if (res.errno === -6) {
        // Cookie 失效，清除 bdstoken 缓存
        this._bdstoken = ''
        this._bdstokenExpiresAt = 0
        throw new Error('百度 Cookie 已失效，请在账号管理中删除并重新添加百度账号')
      }
      throw new Error(`获取 bdstoken 失败 (errno=${res.errno})`)
    } catch (err) {
      log.warn('Baidu fetchBdstoken failed:', String(err))
      throw err
    }
  }

  private async fetchAllPages(
    token: string, method: 'list' | 'search', baseParams: Record<string, string>,
    opts: { pageSize?: number; maxPages?: number; cookies?: string } = {},
  ): Promise<BaiduFileItem[]> {
    const pageSize = opts.pageSize || 100; const maxPages = opts.maxPages || 100
    const allItems: BaiduFileItem[] = []
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { ...baseParams }
      if (method === 'list') { params.start = String(page * pageSize); params.limit = String(pageSize) }
      else { params.page = String(page + 1); params.num = String(pageSize) }
      if (!params.access_token) delete params.access_token
      const res = await baiduRequest<BaiduFileListData | BaiduSearchData>(
        `${BAIDU_API}/file`, token || '', { params, cookies: opts.cookies },
      )
      const resAny = res as any
      if (resAny.errno !== undefined && resAny.errno !== 0) {
        const errMsg = resAny.errmsg || resAny.error || `errno=${resAny.errno}`
        throw new Error(`Baidu ${method} failed: ${errMsg}`)
      }
      const list = resAny.list || []; allItems.push(...list)
      if (!resAny.has_more || list.length < pageSize) break
    }
    return allItems
  }

  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      const token = await this.ensureToken(account)
      const cookies = this.isCookieLogin(account) ? account.credential.cookies || '' : undefined
      const params: Record<string, string> = { method: 'uinfo' }
      if (token) params.access_token = token
      const res = await baiduRequest<BaiduUserInfo>(`${BAIDU_API}/nas`, token || '', { params, cookies })
      const data = res as any
      return data.errno === 0 || !!data.baidu_name || !!data.netdisk_name
    } catch (err) { log.warn('Baidu checkLogin failed:', String(err)); return false }
  }

  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies || '' : undefined
    const params: Record<string, string> = { method: 'uinfo' }
    if (token) params.access_token = token
    const res = await baiduRequest<BaiduUserInfo>(`${BAIDU_API}/nas`, token || '', { params, cookies })
    const data = res as any
    if (data.errno !== 0 && !data.baidu_name && !data.netdisk_name)
      throw new Error(`Baidu getUserInfo failed: ${data.errmsg || 'unknown error'}`)
    return { nickname: data.baidu_name || data.netdisk_name || '百度用户', avatar: data.avatar_url }
  }

  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined
    const dir = parentId === '0' ? '/' : parentId

    if (cookies) {
      const bdstoken = await this.fetchBdstoken(cookies)
      const params = {
        order: 'time', desc: '1', showempty: '0', web: '1',
        page: '1', num: '1000', dir, bdstoken,
      }
      const res = await baiduRequest<{ errno: number; list?: BaiduFileItem[]; errmsg?: string }>(
        `${BAIDU_BASE}/api/list`, '', { params, cookies },
      )
      if (res.errno !== 0) throw new Error(`Baidu list failed: errno=${res.errno}`)
      const list = res.list || []
      return { files: list.map((f) => mapBaiduFile(f, account.id)), parentId, hasMore: false }
    }

    const token = await this.ensureToken(account)
    const rawItems = await this.fetchAllPages(token, 'list', {
      method: 'list', access_token: token, dir, order: 'time', desc: '1', web: '1',
    })
    return { files: rawItems.map((f) => mapBaiduFile(f, account.id)), parentId, hasMore: false }
  }

  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined
    if (cookies) {
      const bdstoken = await this.fetchBdstoken(cookies)
      const params = { key: keyword, dir: '/', web: '1', recursion: '1', page: '1', num: '100', bdstoken }
      const res = await baiduRequest<{ errno: number; list?: BaiduFileItem[] }>(
        `${BAIDU_BASE}/api/search`, '', { params, cookies },
      )
      if (res.errno !== 0) throw new Error(`Baidu search failed: errno=${res.errno}`)
      return (res.list || []).map((f) => mapBaiduFile(f, account.id))
    }
    const token = await this.ensureToken(account)
    const rawItems = await this.fetchAllPages(token, 'search', {
      method: 'search', access_token: token, key: keyword, dir: '/', web: '1', recursion: '1',
    })
    return rawItems.map((f) => mapBaiduFile(f, account.id))
  }

  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined
    const path = parentId === '0' ? `/${name}` : `${parentId}/${name}`
    if (cookies) {
      const bdstoken = await this.fetchBdstoken(cookies)
      const res = await baiduRequest<{ errno: number; path?: string; fs_id?: number }>(
        `${BAIDU_BASE}/api/create`, '', {
          method: 'POST', params: { a: 'commit', bdstoken }, cookies,
          formBody: true, body: { path, isdir: '1', block_list: '[]' },
        },
      )
      if (res.errno !== 0) throw new Error(`Baidu mkdir failed: errno=${res.errno}`)
      return {
        id: res.path || path, path: res.path || path, parentId: parentId === '0' ? '/' : parentId, name, isDir: true, size: 0,
        createdAt: Date.now(), updatedAt: Date.now(), platform: 'baidu', accountId: account.id, raw: { fs_id: res.fs_id },
      }
    }
    const token = await this.ensureToken(account)
    const res = await baiduRequest<BaiduCreateData>(`${BAIDU_API}/file`, token, {
      params: { method: 'create', access_token: token, path, isdir: '1', size: '0', block_list: '[]', rtype: '1' },
    })
    const data = res as any
    if (data.errno !== 0) throw new Error(`Baidu mkdir failed: ${data.errmsg}`)
    return {
      id: data.path, path: data.path, parentId: parentId === '0' ? '/' : parentId, name, isDir: true, size: 0,
      createdAt: (data.create_time || Math.floor(Date.now() / 1000)) * 1000, updatedAt: Date.now(),
      platform: 'baidu', accountId: account.id, raw: { fs_id: data.fs_id },
    }
  }

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    if (!fileId || !fileId.startsWith('/')) throw new Error(`Baidu rename: invalid file path "${fileId}"`)
    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined
    const res = await baiduRequest<BaiduFileOperateData>(`${BAIDU_API}/file`, token, {
      method: 'POST', params: { method: 'filemanager', access_token: token, opera: 'rename' }, cookies,
      body: { async: 0, filelist: JSON.stringify([{ path: fileId, newname: newName }]) },
    })
    if (res.errno !== 0) throw new Error(`Baidu rename failed (errno=${res.errno}): ${res.errmsg}`)
  }

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    for (const fid of fileIds) if (!fid || !fid.startsWith('/')) throw new Error(`Baidu move: invalid file path "${fid}"`)
    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined
    const dest = targetDirId === '0' ? '/' : targetDirId
    const filelist = fileIds.map((filePath) => ({ path: filePath, dest, newname: '' }))
    const res = await baiduRequest<BaiduFileOperateData>(`${BAIDU_API}/file`, token, {
      method: 'POST', params: { method: 'filemanager', access_token: token, opera: 'move' }, cookies,
      body: { async: 0, filelist: JSON.stringify(filelist) },
    })
    if (res.errno !== 0) throw new Error(`Baidu move failed (errno=${res.errno}): ${res.errmsg}`)
  }

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    for (const fid of fileIds) if (!fid || !fid.startsWith('/')) throw new Error(`Baidu delete: invalid file path "${fid}"`)
    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined
    const res = await baiduRequest<BaiduFileOperateData>(`${BAIDU_API}/file`, token, {
      method: 'POST', params: { method: 'filemanager', access_token: token, opera: 'delete' }, cookies,
      body: { async: 0, filelist: JSON.stringify(fileIds) },
    })
    if (res.errno !== 0) throw new Error(`Baidu delete failed (errno=${res.errno}): ${res.errmsg}`)
  }

  // ── 分享 ──

  /**
   * 创建分享链接
   * 使用浏览器方案（参照 BaiduPanFilesTransfers create_share）
   * 百度 /share/set 是 POST 请求，net.request 有兼容性问题，改用浏览器内执行
   */
  async createShare(account: DriveAccount, items: ShareTaskPayload['items'], options?: ShareOptions): Promise<ShareInfo> {
    const cookies = this.getBaiduCookies(account)
    const title = options?.title || (items.length === 1 ? (items[0].name || '分享文件') : `分享 ${items.length} 个文件`)
    const pwd = options?.password || generateRandomPwd()
    const expireDays = options?.expireDays || 0

    const firstItem = items[0]
    const fsId = firstItem.raw?.fs_id != null ? Number(firstItem.raw.fs_id) : Number(firstItem.fileId)

    log.info(`Baidu createShare(browser): fs_id=${fsId}, period=${expireDays}, pwd=${pwd}`)

    // 注入 cookie 到 session
    await injectBaiduCookies(cookies)

    return new Promise((resolve, reject) => {
      let resolved = false

      const win = new BrowserWindow({
        width: 800,
        height: 600,
        show: true,
        title: '百度网盘分享中...',
        webPreferences: {
          partition: BAIDU_SESSION,
          contextIsolation: false,
          nodeIntegration: false,
          sandbox: false,
        },
      })

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          win.destroy()
          reject(new Error('分享超时'))
        }
      }, 30000)

      function cleanup() {
        clearTimeout(timeout)
        if (!win.isDestroyed()) win.destroy()
      }

      // 加载百度网盘主页
      win.loadURL('https://pan.baidu.com/disk/main')

      win.webContents.on('did-finish-load', async () => {
        const currentUrl = win.webContents.getURL()
        log.info(`Baidu createShare(browser): page loaded, url=${currentUrl}`)

        // 等待页面加载完成
        await new Promise(r => setTimeout(r, 2000))

        try {
          // 获取 bdstoken（从 cookie 或页面变量）
          const bdstoken = await win.webContents.executeJavaScript(`
            (function() {
              // 方法1：从 cookie 获取
              var match = document.cookie.match(/bdstoken=([^;]+)/);
              if (match) return match[1];
              // 方法2：从页面隐藏元素获取
              try {
                var el = document.querySelector('input[name="bdstoken"]');
                if (el) return el.value;
              } catch(e) {}
              // 方法3：从 window 变量获取
              try { if (window.locals && window.locals.bdstoken) return window.locals.bdstoken; } catch(e) {}
              return '';
            })()
          `).catch(() => '')

          log.info(`Baidu createShare(browser): bdstoken=${bdstoken ? 'OK' : 'EMPTY'}`)

          // 如果没有 bdstoken，尝试从 API 获取
          let finalBdstoken = bdstoken
          if (!finalBdstoken) {
            try {
              const apiRes = await win.webContents.executeJavaScript(`
                (async function() {
                  var resp = await fetch('/api/gettemplatevariable?clienttype=0&app_id=38824127&web=1&fields=%5B%22bdstoken%22%5D');
                  var data = await resp.json();
                  return data.result && data.result.bdstoken ? data.result.bdstoken : '';
                })()
              `)
              if (apiRes) {
                finalBdstoken = apiRes
                log.info(`Baidu createShare(browser): got bdstoken from API: ${finalBdstoken}`)
              }
            } catch { /* ignore */ }
          }

          // 调用 /share/set 创建分享（在浏览器上下文中，自动携带 cookie）
          const shareResult = await win.webContents.executeJavaScript(`
            (async function() {
              var params = new URLSearchParams({
                channel: 'chunlei',
                bdstoken: ${JSON.stringify(finalBdstoken)},
                clienttype: '0',
                app_id: '250528',
                web: '1'
              });
              var body = new URLSearchParams({
                period: ${JSON.stringify(String(expireDays))},
                pwd: ${JSON.stringify(pwd)},
                eflag_disable: 'true',
                channel_list: '[]',
                schannel: '4',
                fid_list: JSON.stringify([${JSON.stringify(fsId)}])
              });
              try {
                var resp = await fetch('/share/set?' + params.toString(), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: body.toString()
                });
                var text = await resp.text();
                try {
                  return JSON.parse(text);
                } catch(e) {
                  return { errno: -1, errmsg: 'Not JSON: ' + text.substring(0, 200) };
                }
              } catch(e) {
                return { errno: -1, errmsg: e.message };
              }
            })()
          `).catch((e: Error) => ({ errno: -1, errmsg: e.message }))

          log.info(`Baidu createShare(browser): share/set result=${JSON.stringify(shareResult || {}).substring(0, 500)}`)

          if (!shareResult || shareResult.errno !== 0) {
            cleanup()
            resolved = true
            reject(new Error(getBaiduErrorMessage(shareResult?.errno || -1, '创建分享')))
            return
          }

          const shareId = shareResult.shareid
          if (!shareId) {
            cleanup()
            resolved = true
            reject(new Error('分享失败：未返回 shareid'))
            return
          }

          // 获取分享链接（/share/password）
          const pwdResult = await win.webContents.executeJavaScript(`
            (async function() {
              var params = new URLSearchParams({
                channel: 'chunlei',
                bdstoken: ${JSON.stringify(finalBdstoken)},
                clienttype: '0',
                app_id: '250528',
                web: '1'
              });
              try {
                var resp = await fetch('/share/password?' + params.toString(), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({ share_id: ${JSON.stringify(shareId)} }).toString()
                });
                var text = await resp.text();
                try {
                  return JSON.parse(text);
                } catch(e) {
                  return { errno: -1, errmsg: 'Not JSON: ' + text.substring(0, 200) };
                }
              } catch(e) {
                return { errno: -1, errmsg: e.message };
              }
            })()
          `).catch((e: Error) => ({ errno: -1, errmsg: e.message }))

          log.info(`Baidu createShare(browser): share/password result=${JSON.stringify(pwdResult || {}).substring(0, 300)}`)

          cleanup()
          resolved = true

          // 构建分享链接（参照 BaiduPanFilesTransfers create_share 返回格式）
          // /share/set 返回的 link 或 short_url 就是正确的分享链接
          let shareUrl = ''
          if (shareResult.link) {
            shareUrl = shareResult.link
            log.info(`Baidu createShare(browser): got link from share/set`)
          } else if (shareResult.short_url) {
            shareUrl = shareResult.short_url
            log.info(`Baidu createShare(browser): got short_url from share/set`)
          } else if (pwdResult?.errno === 0 && pwdResult?.share_url) {
            shareUrl = pwdResult.share_url
            log.info(`Baidu createShare(browser): got share_url from share/password`)
          } else {
            // 最后才用构造的 URL（这个格式不对，百度不用纯数字 ID）
            shareUrl = `https://pan.baidu.com/s/${shareId}`
            log.warn(`Baidu createShare(browser): no URL from API, using constructed URL (may not work)`)
          }

          // 如果有密码，拼接到 URL 后面（参照 BaiduPanFilesTransfers）
          if (pwd) {
            shareUrl = shareUrl.includes('?') ? `${shareUrl}&pwd=${pwd}` : `${shareUrl}?pwd=${pwd}`
          }

          log.info(`Baidu createShare(browser): final url=${shareUrl}`)
          cleanup()
          resolved = true
          resolve({
            id: String(shareId),
            platform: 'baidu',
            accountId: account.id,
            fileIds: [String(fsId)],
            title: firstItem.name || title,
            shareUrl,
            password: pwd,
            createdAt: Date.now(),
            raw: pwdResult,
          })
        } catch (err) {
          log.error('Baidu createShare(browser) error:', String(err))
          cleanup()
          if (!resolved) {
            resolved = true
            reject(err)
          }
        }
      })

      win.webContents.on('did-fail-load', (_e, code, desc) => {
        log.error(`Baidu createShare(browser): load failed (${code}): ${desc}`)
        cleanup()
        if (!resolved) {
          resolved = true
          reject(new Error(`页面加载失败: ${desc}`))
        }
      })
    })
  }

  async parseShareLink(url: string, password?: string): Promise<{ shareId: string; password?: string; raw?: unknown }> {
    const normalized = normalizeBaiduLink(url)
    const { url: cleanUrl, password: extractedPwd } = parseUrlAndCode(normalized + (password ? ` ${password}` : ''))

    let match = cleanUrl.match(/pan\.baidu\.com\/s\/([a-zA-Z0-9_-]+)/)
    if (match) return { shareId: match[1], password: password || extractedPwd || undefined, raw: undefined }
    match = cleanUrl.match(/pan\.baidu\.com\/share\/init\?.*surl=([a-zA-Z0-9_-]+)/)
    if (match) return { shareId: match[1], password: password || extractedPwd || undefined, raw: undefined }
    throw new Error('无法解析百度分享链接，请确认链接格式正确')
  }

  async getShareDetail(account: DriveAccount, input: TransferLinkInput): Promise<ShareDetail> {
    const cookies = this.getBaiduCookies(account)
    const parsed = await this.parseShareLink(input.url, input.password)

    // 跳过 verify 步骤，直接获取分享页面
    const augmentedCookies = cookies

    const sharePageUrl = `https://pan.baidu.com/s/${parsed.shareId}`
    const pageRes = await baiduRawRequest(sharePageUrl, { cookies: augmentedCookies })

    const parsed_page = parseSharePageHtml(pageRes.body)
    if (!parsed_page) throw new Error('解析分享页面失败，可能链接已失效或需要提取码')

    const files: ShareDetail['files'] = []
    for (let i = 0; i < parsed_page.fsIds.length; i++) {
      files.push({
        fileId: parsed_page.fsIds[i],
        name: parsed_page.filenames[i] || `file_${parsed_page.fsIds[i]}`,
        isDir: parsed_page.isDirs[i] === '1',
        raw: { fs_id: parsed_page.fsIds[i] },
      })
    }
    return { platform: 'baidu', shareId: parsed_page.shareid, title: parsed_page.filenames[0] || '', files, raw: parsed_page }
  }

  /**
   * 转存分享文件
   * 使用内置浏览器方案，解决 Electron HTTP 客户端 POST 请求兼容性问题
   */
  async saveSharedFiles(account: DriveAccount, input: TransferLinkInput, targetDirId: string): Promise<TransferResult> {
    const cookies = this.getBaiduCookies(account)
    log.info(`Baidu saveSharedFiles(browser): url=${input.url}, targetDirId=${targetDirId}`)

    const result = await baiduTransferViaBrowser(cookies, input.url, input.password, targetDirId)

    if (!result.success) {
      throw new Error(result.error || '转存失败')
    }

    return {
      platform: 'baidu',
      accountId: account.id,
      sourceUrl: input.url,
      success: true,
      savedCount: result.savedCount,
      targetDirId,
      savedFilePaths: result.savedFilePaths.length > 0 ? result.savedFilePaths : undefined,
    }
  }

  /**
   * 上传文件
   */
  async upload(
    account: DriveAccount,
    localFilePath: string,
    targetDirId: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    const fs = require('fs')
    const path = require('path')
    const crypto = require('crypto')

    const token = await this.ensureToken(account)
    const fileName = options?.fileName || path.basename(localFilePath)
    const fileSize = fs.statSync(localFilePath).size

    if (fileSize === 0) {
      throw new Error('百度网盘不支持上传空文件')
    }

    // 流式计算文件 MD5（避免将整个文件读入内存）
    const fileMd5 = await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('md5')
      const stream = fs.createReadStream(localFilePath)
      stream.on('data', (chunk: Buffer) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })

    // 计算分片 MD5（每 4MB 一个分片）
    const sliceSize = 4 * 1024 * 1024
    const sliceMd5List: string[] = []
    const totalSlices = Math.ceil(fileSize / sliceSize)
    const fd = fs.openSync(localFilePath, 'r')
    const sliceBuf = Buffer.alloc(sliceSize)
    try {
      for (let i = 0; i < totalSlices; i++) {
        const start = i * sliceSize
        const end = Math.min(start + sliceSize, fileSize)
        const chunkSize = end - start
        const bytesRead = fs.readSync(fd, sliceBuf, 0, chunkSize, start)
        const sliceMd5 = crypto.createHash('md5').update(sliceBuf.subarray(0, bytesRead)).digest('hex')
        sliceMd5List.push(sliceMd5)
      }
    } finally {
      fs.closeSync(fd)
    }

    const targetPath = targetDirId === '0' ? `/${fileName}` : `${targetDirId}/${fileName}`

    // 1. 尝试秒传
    try {
      const rapidRes = await baiduRequest<any>(
        `${BAIDU_API}/file`, token, {
          params: {
            method: 'rapidupload',
            access_token: token,
          },
          method: 'POST',
          body: `path=${encodeURIComponent(targetPath)}&size=${fileSize}&block_list=${encodeURIComponent(JSON.stringify([fileMd5]))}`,
          extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      )

      if (rapidRes.errno === 0 && rapidRes.fs_id) {
        log.info(`Baidu: rapid upload success for ${fileName}`)
        return {
          success: true,
          fileId: String(rapidRes.fs_id),
          fileName,
          fileSize,
        }
      }
    } catch (err) {
      log.warn('Baidu: rapid upload failed, falling back to normal upload:', String(err))
    }

    // 2. 预创建
    const precreateRes = await baiduRequest<any>(
      `${BAIDU_API}/file`, token, {
        params: {
          method: 'precreate',
          access_token: token,
        },
        method: 'POST',
        body: `path=${encodeURIComponent(targetPath)}&size=${fileSize}&isdir=0&autoinit=1&rtype=1&block_list=${encodeURIComponent(JSON.stringify(sliceMd5List))}&content-md5=${fileMd5}`,
        extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    )

    if (precreateRes.errno !== 0) {
      throw new Error(`预创建失败: ${getBaiduErrorMessage(precreateRes.errno, '上传')}`)
    }

    // 如果 return_type=2，表示秒传成功
    if (precreateRes.return_type === 2) {
      log.info(`Baidu: rapid upload success (return_type=2) for ${fileName}`)
      return {
        success: true,
        fileId: String(precreateRes.fs_id || ''),
        fileName,
        fileSize,
      }
    }

    const uploadId = precreateRes.uploadid
    const blockList = precreateRes.block_list || []

    // 3. 上传分片（按需读取，避免将整个文件加载到内存）
    const uploadFd = fs.openSync(localFilePath, 'r')
    const uploadBuf = Buffer.alloc(sliceSize)
    try {
    for (let i = 0; i < totalSlices; i++) {
      if (!blockList.includes(i)) continue // 跳过已上传的分片

      const start = i * sliceSize
      const end = Math.min(start + sliceSize, fileSize)
      const chunkSize = end - start
      const bytesRead = fs.readSync(uploadFd, uploadBuf, 0, chunkSize, start)
      const slice = uploadBuf.subarray(0, bytesRead)

      // 获取上传 URL
      const locateRes = await baiduRequest<any>(
        `https://d.pcs.baidu.com/rest/2.0/pcs/file`, token, {
          params: {
            method: 'locateupload',
            access_token: token,
          },
        },
      )

      const uploadHost = locateRes.host || 'd.pcs.baidu.com'

      // 上传分片
      await new Promise<void>((resolve, reject) => {
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2)
        const bodyParts: Buffer[] = []

        bodyParts.push(Buffer.from(`--${boundary}\r\n`))
        bodyParts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="blob"\r\n`))
        bodyParts.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`))
        bodyParts.push(slice)
        bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

        const body = Buffer.concat(bodyParts)

        const request = net.request({
          method: 'POST',
          url: `https://${uploadHost}/rest/2.0/pcs/superfile2?method=upload&access_token=${token}&type=tmpfile&path=${encodeURIComponent(targetPath)}&uploadid=${uploadId}&partseq=${i}`,
        })
        request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
        request.setHeader('Content-Length', String(body.length))
        request.write(body)
        request.on('response', (response) => {
          let responseData = ''
          response.on('data', (chunk) => { responseData += chunk.toString() })
          response.on('end', () => {
            try {
              const result = JSON.parse(responseData)
              if (result.error_code || result.errno) {
                reject(new Error(`Upload slice ${i + 1} failed: ${result.error_msg || result.errmsg || 'unknown'}`))
              } else {
                resolve()
              }
            } catch {
              resolve() // 解析失败也继续
            }
          })
          response.on('error', (err) => reject(err))
        })
        request.on('error', (err) => reject(err))
        request.end()
      })

      // 报告进度
      options?.onProgress?.({
        loaded: end,
        total: fileSize,
        percent: Math.round((end / fileSize) * 100),
        speed: 0,
      })
    }
    } finally {
      fs.closeSync(uploadFd)
    }

    // 4. 创建文件
    const createRes = await baiduRequest<any>(
      `${BAIDU_API}/file`, token, {
        params: {
          method: 'create',
          access_token: token,
        },
        method: 'POST',
        body: `path=${encodeURIComponent(targetPath)}&size=${fileSize}&isdir=0&rtype=1&uploadid=${uploadId}&block_list=${encodeURIComponent(JSON.stringify(sliceMd5List))}`,
        extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    )

    if (createRes.errno !== 0) {
      throw new Error(`创建文件失败: ${getBaiduErrorMessage(createRes.errno, '上传')}`)
    }

    log.info(`Baidu: upload success for ${fileName} -> ${createRes.fs_id}`)

    return {
      success: true,
      fileId: String(createRes.fs_id || ''),
      fileName: createRes.path || fileName,
      fileSize: createRes.size || fileSize,
    }
  }

  /**
   * 复制文件
   */
  async copy(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined

    const body = fileIds.map(fid => ({
      path: fid,
      dest: targetDirId === '0' ? '/' : targetDirId,
      newname: '',
    }))

    if (cookies) {
      const bdstoken = await this.fetchBdstoken(cookies)
      await baiduRequest(`${BAIDU_BASE}/api/filemanager`, '', {
        params: {
          opera: 'copy',
          bdstoken,
        },
        method: 'POST',
        body: { filelist: body },
        cookies,
      })
    } else {
      await baiduRequest(`${BAIDU_API}/file`, token || '', {
        params: { method: 'filemanager', opera: 'copy', async: '0', access_token: token || '' },
        method: 'POST',
        body: { filelist: body },
        formBody: true,
      })
    }
  }

  /**
   * 获取下载链接
   */
  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined

    // 获取文件信息
    const params: Record<string, string> = {
      method: 'filemetas',
      access_token: token || '',
      fsids: `[${fileId}]`,
      dlink: '1',
    }

    const res = await baiduRequest<{ list?: Array<{ dlink: string; filename: string; size: number }> }>(
      `${BAIDU_API}/file`, token || '', { params, cookies },
    )

    if (!res.list || res.list.length === 0 || !res.list[0].dlink) {
      // 如果是 Cookie 登录模式，尝试使用 Web API
      if (cookies) {
        const bdstoken = await this.fetchBdstoken(cookies)
        const webParams = {
          fid_list: `[${fileId}]`,
          type: 'dlink',
          vip: '2',
          bdstoken,
        }
        const webRes = await baiduRequest<{ errno: number; dlink?: Array<{ dlink: string }> }>(
          `${BAIDU_BASE}/api/download`, '', { params: webParams, cookies },
        )
        if (webRes.errno === 0 && webRes.dlink && webRes.dlink.length > 0) {
          return webRes.dlink[0].dlink
        }
      }
      throw new Error('获取下载链接失败')
    }

    return res.list[0].dlink
  }

  /**
   * 下载文件到本地
   */
  async download(
    account: DriveAccount,
    fileId: string,
    localDirPath: string,
    options?: DownloadOptions,
  ): Promise<DownloadResult> {
    const fs = require('fs')
    const path = require('path')

    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies : undefined

    // 获取文件信息
    const params: Record<string, string> = {
      method: 'filemetas',
      access_token: token || '',
      fsids: `[${fileId}]`,
      dlink: '1',
    }

    const res = await baiduRequest<{ list?: Array<{ dlink: string; filename: string; size: number }> }>(
      `${BAIDU_API}/file`, token || '', { params, cookies },
    )

    if (!res.list || res.list.length === 0 || !res.list[0].dlink) {
      // 如果是 Cookie 登录模式，尝试使用 Web API
      if (cookies) {
        const bdstoken = await this.fetchBdstoken(cookies)
        const webParams = {
          fid_list: `[${fileId}]`,
          type: 'dlink',
          vip: '2',
          bdstoken,
        }
        const webRes = await baiduRequest<{ errno: number; dlink?: Array<{ dlink: string; filename: string; size: number }> }>(
          `${BAIDU_BASE}/api/download`, '', { params: webParams, cookies },
        )
        if (webRes.errno === 0 && webRes.dlink && webRes.dlink.length > 0) {
          const fileInfo = webRes.dlink[0]
          const fileName = options?.fileName || fileInfo.filename || `file_${fileId}`
          const fileSize = fileInfo.size || 0
          const downloadUrl = fileInfo.dlink

          // 下载文件
          const response = await fetch(downloadUrl, {
            headers: {
              'User-Agent': BAIDU_UA,
              'Cookie': cookies,
            },
          })

          if (!response.ok) {
            throw new Error(`下载失败: ${response.statusText}`)
          }

          const localPath = path.join(localDirPath, fileName)
          const writer = fs.createWriteStream(localPath)
          const reader = response.body?.getReader()
          if (!reader) {
            throw new Error('无法读取响应流')
          }

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
                total: fileSize,
                percent: Math.round((loaded / fileSize) * 100),
                speed,
              })
            }

            writer.end()

            await new Promise<void>((resolve, reject) => {
              writer.on('finish', resolve)
              writer.on('error', reject)
            })

            return {
              success: true,
              localPath,
              fileName,
              fileSize,
            }
          } catch (err) {
            reader.cancel().catch(() => {})
            writer.destroy()
            try { fs.unlinkSync(localPath) } catch {}
            throw err
          }
        }
      }
      throw new Error('获取下载链接失败')
    }

    const fileInfo = res.list[0]
    const fileName = options?.fileName || fileInfo.filename
    const fileSize = fileInfo.size
    const downloadUrl = fileInfo.dlink
    const localPath = path.join(localDirPath, fileName)

    // 下载文件（需要添加 User-Agent）
    const response = await fetch(downloadUrl, {
      headers: {
        'User-Agent': BAIDU_UA,
      },
    })

    if (!response.ok) {
      throw new Error(`下载失败: ${response.statusText}`)
    }

    const writer = fs.createWriteStream(localPath)
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('无法读取响应流')
    }

    let loaded = 0
    const startTime = Date.now()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        writer.write(Buffer.from(value))
        loaded += value.length

        // 报告进度
        const elapsed = (Date.now() - startTime) / 1000
        const speed = elapsed > 0 ? loaded / elapsed : 0

        options?.onProgress?.({
          loaded,
          total: fileSize,
          percent: Math.round((loaded / fileSize) * 100),
          speed,
        })
      }

      writer.end()

      // 等待写入完成
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
      })

      return {
        success: true,
        localPath,
        fileName,
        fileSize,
      }
    } catch (err) {
      reader.cancel().catch(() => {})
      writer.destroy()
      try { fs.unlinkSync(localPath) } catch {}
      throw err
    }
  }

  async getQuota(account: DriveAccount): Promise<{ used: number; total: number }> {
    const token = await this.ensureToken(account)
    const cookies = this.isCookieLogin(account) ? account.credential.cookies || '' : undefined

    if (cookies) {
      // Cookie 模式
      const bdstoken = await this.fetchBdstoken(cookies)
      const params: Record<string, string> = { checkfree: '1', checkexpire: '1' }
      if (bdstoken) params.bdstoken = bdstoken
      const data = await baiduRequest<any>('https://pan.baidu.com/api/quota', '', { params, cookies })
      return {
        used: data.used || 0,
        total: data.total || 0,
      }
    } else {
      // OAuth 模式
      const params: Record<string, string> = { method: 'info' }
      if (token) params.access_token = token
      const data = await baiduRequest<any>(`${BAIDU_API}/quota`, token || '', { params })
      return {
        used: data.used || 0,
        total: data.total || 0,
      }
    }
  }
}

export const baiduAdapter = new BaiduAdapter()

export async function baiduExchangeCode(code: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  ensureBaiduCredentials()
  const url = `${BAIDU_OAUTH_TOKEN}?grant_type=authorization_code&code=${code}&client_id=${_clientId}&client_secret=${_clientSecret}&redirect_uri=${encodeURIComponent(_redirectUri)}`
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url })
    let responseData = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseData += chunk.toString() })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(responseData)
          if (parsed.error) reject(new Error(`Baidu OAuth error: ${parsed.error_description || parsed.error}`))
          else resolve(parsed)
        } catch { reject(new Error(`Failed to parse: ${responseData.substring(0, 200)}`)) }
      })
      response.on('error', (err) => reject(err))
    })
    request.on('error', (err) => reject(err)); request.end()
  })
}

export async function baiduRefreshToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  ensureBaiduCredentials()
  const url = `${BAIDU_OAUTH_TOKEN}?grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${_clientId}&client_secret=${_clientSecret}`
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url })
    let responseData = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseData += chunk.toString() })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(responseData)
          if (parsed.error) reject(new Error(`Baidu refresh error: ${parsed.error_description || parsed.error}`))
          else resolve(parsed)
        } catch { reject(new Error(`Failed to parse: ${responseData.substring(0, 200)}`)) }
      })
      response.on('error', (err) => reject(err))
    })
    request.on('error', (err) => reject(err)); request.end()
  })
}

export function baiduGetAuthUrl(): string {
  ensureBaiduCredentials()
  return `https://openapi.baidu.com/oauth/2.0/authorize?client_id=${_clientId}&response_type=code&redirect_uri=${encodeURIComponent(_redirectUri)}&scope=basic,netdisk&display=page`
}

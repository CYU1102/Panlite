import { writeDownloadResponse } from './download-response'
import { parseQuarkUcResponse } from './quark-uc-response'
import { QuarkCookieStore } from './quark-cookie'
import { session } from 'electron'
import type { DriveAdapter, DriveDownloadSource } from './base'
import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, ShareTaskPayload, TransferLinkInput, TransferResult, UploadOptions, UploadResult, DownloadOptions, DownloadResult } from '../shared/types'
import type { SharedDirectoryOptions, SharedDirectoryResult, SharedSaveOptions } from '../shared/subscription-types'
import { SharedDirectoryPages, sharedEntry } from './shared-directory'
import { sleep, randomInt } from '../shared/utils'
import log from 'electron-log'
import { resolvePathInside, sanitizeFileName } from '../main/file-transfer'
import { getRequestSettings } from '../main/request-settings'
import { normalizeMembership } from '../shared/membership'

// ── 常量（完全参照 QuarkPanTool） ──

const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko)' +
  ' Chrome/94.0.4606.71 Safari/537.36 Core/1.94.225.400 QQBrowser/12.2.5544.400'

// ── 错误码映射 ──

const QUARK_ERROR_CODES: Record<number, string> = {
  [41001]: '登录已失效，请重新登录',
  [41010]: '目标目录不存在',
  [41012]: '提取码错误',
  [41013]: '文件违规或不可分享/转存',
  [41014]: '分享已失效',
  [41019]: '容量不足',
  [41020]: '请求过于频繁，请稍后再试',
  [23008]: '文件夹同名冲突',
  [23018]: 'User-Agent 校验失败',
  [32003]: '容量不足',
  [41026]: '没有可分享的文件（分享可能已失效、被限制保存或提取码不匹配）',
}

function getQuarkErrorMessage(code: number, action: string): string {
  const msg = QUARK_ERROR_CODES[code] || `未知错误 (code=${code})`
  return `${action}失败: ${msg}`
}

// ── 工具函数（完全参照 QuarkPanTool） ──

function getTimestamp(digits: number): number {
  const now = Date.now()
  return digits === 13 ? now : Math.floor(now / 1000)
}

/**
 * 构建夸克 API 通用查询参数（完全参照 QuarkPanTool）
 */
function buildQuarkParams(extra?: Record<string, string>): Record<string, string> {
  return {
    pr: 'ucpro',
    fr: 'pc',
    uc_param_str: '',
    __dt: String(randomInt(100, 9999)),
    __t: String(getTimestamp(13)),
    ...extra,
  }
}

const QUARK_SESSION = 'persist:quark'
const quarkCookies = new QuarkCookieStore()

/**
 * 夸克 API 请求（使用 session.fetch + Cookie header）
 * 完全参照 QuarkPanTool 的 httpx 方式
 */
async function quarkRequest<T>(
  url: string,
  account: DriveAccount,
  options: { method?: string; body?: unknown; params?: Record<string, string>; onResponseCookies?: (cookies: string) => void } = {},
): Promise<T> {
  const cookieRequest = quarkCookies.begin(account)
  const method = options.method || 'GET'
  const urlObj = new URL(url)

  // 添加通用参数（参照 QuarkPanTool 每个请求都带的 params）
  const defaultParams = buildQuarkParams(options.params)
  for (const [key, value] of Object.entries(defaultParams)) {
    if (!urlObj.searchParams.has(key)) {
      urlObj.searchParams.set(key, value)
    }
  }
  const finalUrl = urlObj.toString()

  // 完全参照 QuarkPanTool 的 self.headers
  const headers: Record<string, string> = {
    'user-agent': QUARK_UA,
    'origin': 'https://pan.quark.cn',
    'referer': 'https://pan.quark.cn/',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cookie': cookieRequest.cookie,
    'Accept': 'application/json, text/plain, */*',
  }

  const fetchOptions: RequestInit = { method, headers }

  if (options.body) {
    headers['Content-Type'] = 'application/json'
    fetchOptions.body = JSON.stringify(options.body)
  }

  const ses = session.fromPartition(QUARK_SESSION)
  const response = await ses.fetch(finalUrl, fetchOptions)
  const responseCookies = quarkCookies.receive(cookieRequest, response.headers, response.url || finalUrl)
  options.onResponseCookies?.(responseCookies)
  const text = await response.text()
  return parseQuarkUcResponse(text, response.status, urlObj, method, 'quark') as T
}

// ── 接口定义 ──

interface QuarkApiResponse {
  status: number
  code: number
  message: string
  data: any
  metadata?: { _total: number; _count: number; _page: number; _size: number }
  [key: string]: any
}

interface QuarkFileItem {
  file?: boolean
  fid: string
  pdir_fid: string
  file_name: string
  file_type: number
  size: number
  created_at: number
  updated_at: number
  dir: boolean
}

function mapQuarkFile(f: QuarkFileItem, accountId: string): FileItem {
  return {
    id: f.fid,
    path: f.fid,
    parentId: f.pdir_fid,
    name: f.file_name,
    isDir: typeof f.file === 'boolean' ? !f.file : f.file_type === 0 || f.dir === true,
    size: f.size || 0,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    platform: 'quark',
    accountId,
  }
}

// ── Stoken 缓存 ──

interface StokenCache {
  stoken: string
  expiresAt: number
}
const stokenCache: Map<string, StokenCache> = new Map()
const STOKEN_CACHE_TTL_MS = 5 * 60 * 1000

function getCachedStoken(shareId: string): string | null {
  const cached = stokenCache.get(shareId)
  if (cached && cached.expiresAt > Date.now()) return cached.stoken
  if (cached) stokenCache.delete(shareId)
  return null
}

function setCachedStoken(shareId: string, stoken: string): void {
  stokenCache.set(shareId, { stoken, expiresAt: Date.now() + STOKEN_CACHE_TTL_MS })
}

// ── 适配器 ──

export class QuarkAdapter implements DriveAdapter {

  /**
   * 检查登录状态（参照 QuarkPanTool get_user_info）
   * 使用 pan.quark.cn/account/info 接口
   */
  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      const cookies = account.credential.cookies
      if (!cookies) return false

      // 完全参照 QuarkPanTool get_user_info
      const res = await quarkRequest<any>(
        'https://pan.quark.cn/account/info?fr=pc&platform=pc',
        account,
      )
      return !!(res.data && res.data.nickname)
    } catch (err) {
      log.warn('Quark checkLogin failed:', String(err))
      return false
    }
  }

  /**
   * 获取用户信息（参照 QuarkPanTool get_user_info）
   */
  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const res = await quarkRequest<any>(
      'https://pan.quark.cn/account/info?fr=pc&platform=pc',
      account,
    )
    if (!res.data) throw new Error('获取用户信息失败')
    return { nickname: res.data.nickname || '夸克用户', avatar: res.data.avatar }
  }

  /**
   * 获取文件列表（参照 QuarkPanTool get_sorted_file_list）
   */
  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const { quarkPageSize: pageSize, requestDelayMs } = getRequestSettings()
    const maxPages = 100
    const allFiles: FileItem[] = []
    let complete = false

    for (let page = 1; page <= maxPages; page++) {
      // 完全参照 QuarkPanTool get_sorted_file_list 的参数
      const params: Record<string, string> = {
        pdir_fid: parentId,
        _page: String(page),
        _size: String(pageSize),
        _fetch_total: 'true',
        _fetch_sub_dirs: '1',
        _sort: 'file_type:asc,file_name:asc',
      }

      const res = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/file/sort',
        account,
        { params },
      )

      if (res.code !== 0) throw new Error(`获取文件列表失败: ${res.message}`)

      const items = res.data?.list
      if (!Array.isArray(items)) throw new Error('夸克文件列表响应无效')

      allFiles.push(...items.map((f: QuarkFileItem) => mapQuarkFile(f, account.id)))

      // The live provider can return _total=0 for non-empty directories.
      // Treat that sentinel as unknown and continue until a short page.
      const total = res.metadata?._total
      const hasTotal = typeof total === 'number' && Number.isSafeInteger(total) && total > 0
      if (hasTotal ? allFiles.length >= total : items.length < pageSize) {
        complete = true
        break
      }
      if (items.length === 0) throw new Error('夸克文件列表不完整：平台总数与分页响应不一致')

      if (requestDelayMs > 0) await sleep(requestDelayMs)
    }

    if (!complete) throw new Error('夸克文件列表达到分页上限，结果不完整')
    return { files: allFiles, parentId, hasMore: false }
  }

  /**
   * 搜索文件（参照 QuarkPanTool search 逻辑）
   */
  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const { quarkPageSize: pageSize, requestDelayMs } = getRequestSettings()
    const maxPages = 100
    const allFiles: FileItem[] = []
    let complete = false

    for (let page = 1; page <= maxPages; page++) {
      const res = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/file/search',
        account,
        { params: { q: keyword, _page: String(page), _size: String(pageSize), _fetch_total: 'true', _sort: '' } },
      )

      if (res.code !== 0) throw new Error(`搜索失败: ${res.message}`)

      const items = res.data?.list
      if (!Array.isArray(items)) throw new Error('夸克搜索列表响应无效')

      allFiles.push(...items.map((f: QuarkFileItem) => mapQuarkFile(f, account.id)))

      const total = res.metadata?._total
      const hasTotal = typeof total === 'number' && Number.isSafeInteger(total) && total > 0
      if (hasTotal ? allFiles.length >= total : items.length < pageSize) { complete = true; break }
      if (items.length === 0) throw new Error('夸克搜索结果不完整：平台总数与分页响应不一致')
      if (requestDelayMs > 0) await sleep(requestDelayMs)
    }

    if (!complete) throw new Error('夸克搜索达到分页上限，结果不完整')
    return allFiles
  }

  /**
   * 创建文件夹（参照 QuarkPanTool create_dir）
   */
  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    // 完全参照 QuarkPanTool create_dir
    const res = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/file',
      account,
      {
        method: 'POST',
        body: {
          pdir_fid: parentId,
          file_name: name,
          dir_path: '',
          dir_init_lock: false,
        },
      },
    )

    if (res.code !== 0) {
      if (res.code === 23008) throw new Error('文件夹同名冲突，请更换名称后重试')
      throw new Error(`创建文件夹失败: ${res.message}`)
    }
    if (typeof res.data?.fid !== 'string' || !res.data.fid) throw new Error('夸克新建文件夹响应缺少 ID')

    return {
      id: res.data.fid,
      path: res.data.fid,
      parentId: res.data.pdir_fid,
      name: res.data.file_name,
      isDir: true,
      size: 0,
      createdAt: res.data.created_at,
      updatedAt: res.data.updated_at,
      platform: 'quark',
      accountId: account.id,
    }
  }

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/file/rename',
      account,
      { method: 'POST', body: { fid: fileId, file_name: newName } },
    )
    if (res.code !== 0) throw new Error(`重命名失败: ${res.message}`)
  }

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/file/move',
      account,
      { method: 'POST', body: { action_type: 1, exclude_fids: [], filelist: fileIds, to_pdir_fid: targetDirId } },
    )
    if (res.code !== 0) throw new Error(`移动失败: ${res.message}`)
  }

  async cancelShare(account: DriveAccount, shareId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/share/delete',
      account,
      { method: 'POST', body: { share_ids: [shareId] } },
    )
    if (res.code !== 0) throw new Error(`取消分享失败: ${res.message}`)
  }

  async copy(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await quarkRequest<QuarkApiResponse & { task_id?: string }>(
      'https://drive-pc.quark.cn/1/clouddrive/file/copy',
      account,
      {
        method: 'POST',
        body: {
          action_type: 1,
          filelist: fileIds.map((fid) => ({ fid, share_f_id: '' })),
          to_pdir_fid: targetDirId === '0' ? '0' : targetDirId,
        },
      },
    )
    if (res.code !== 0) throw new Error(`复制失败: ${res.message}`)
    const taskId = res.data?.task_id
    if (!taskId) return
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(randomInt(500, 1000))
      const taskRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/task',
        account,
        { params: { task_id: taskId, retry_index: String(retryIndex) } },
      )
      if (taskRes.code !== 0) throw new Error(getQuarkErrorMessage(taskRes.code, '复制'))
      if (taskRes.data?.status === 2) return
    }
    throw new Error('复制超时')
  }

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/file/delete',
      account,
      { method: 'POST', body: { action_type: 2, exclude_fids: [], filelist: fileIds } },
    )
    if (res.code !== 0) throw new Error(`删除失败: ${res.message}`)
  }

  // ── 分享（完全参照 QuarkPanTool share 流程） ──

  /**
   * expired_type 映射（参照 QuarkPanTool share_run）
   * 1=永久, 2=1天, 3=7天, 4=30天
   */
  private mapExpireDays(days?: number): number {
    if (!days || days <= 0) return 1 // 永久
    if (days <= 1) return 2  // 1天
    if (days <= 7) return 3  // 7天
    return 4  // 30天
  }

  /**
   * 创建分享（参照 QuarkPanTool 三步流程）
   * Step 1: get_share_task_id -> POST /share
   * Step 2: get_share_id -> GET /task
   * Step 3: submit_share -> POST /share/password
   */
  async createShare(account: DriveAccount, items: ShareTaskPayload['items'], options?: ShareOptions): Promise<ShareInfo> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileIds = items.map((item) => item.fileId)
    const title = options?.title || (items.length === 1 ? (items[0].name || '分享文件') : `分享 ${items.length} 个文件`)

    // ── Step 1: get_share_task_id（参照 QuarkPanTool line 507-536） ──
    const urlType = options?.password ? 2 : 1
    const body: Record<string, unknown> = {
      fid_list: fileIds,
      title,
      url_type: urlType,
      expired_type: this.mapExpireDays(options?.expireDays),
    }
    if (urlType === 2) {
      body.passcode = options?.password || this.generateRandomCode()
    }

    const shareRes = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/share',
      account,
      { method: 'POST', body },
    )

    if (shareRes.code !== 0) throw new Error(getQuarkErrorMessage(shareRes.code, '分享'))
    const taskId = shareRes.data?.task_id
    if (!taskId) throw new Error('分享失败：未返回任务 ID')

    // ── Step 2: get_share_id（参照 QuarkPanTool line 538-551） ──
    // 轮询任务状态直到完成
    let shareId = ''
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(randomInt(500, 1000))

      const taskRes = await quarkRequest<QuarkApiResponse>(
        `https://drive-pc.quark.cn/1/clouddrive/task`,
        account,
        { params: { task_id: taskId, retry_index: String(retryIndex) } },
      )

      // 非 0 业务码即为夸克侧终态失败，直接抛出而不是空转到超时
      if (taskRes.code !== 0) throw new Error(getQuarkErrorMessage(taskRes.code, '分享'))

      if (taskRes.data?.status === 2) {
        shareId = taskRes.data.share_id || ''
        break
      }
    }

    if (!shareId) throw new Error('分享超时，请稍后在分享链接页面查看')

    // ── Step 3: submit_share（参照 QuarkPanTool line 553-572） ──
    const pwdRes = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/share/password',
      account,
      { method: 'POST', body: { share_id: shareId } },
    )

    if (pwdRes.code !== 0) throw new Error(`获取分享链接失败: ${pwdRes.message}`)

    const shareUrl = pwdRes.data?.share_url || ''
    const sharePwd = pwdRes.data?.share_pwd || pwdRes.data?.passcode || undefined

    // 参照 QuarkPanTool: 如果有 passcode，拼接到 URL 后面
    const finalUrl = sharePwd ? `${shareUrl}?pwd=${sharePwd}` : shareUrl

    return {
      id: shareId,
      platform: 'quark',
      accountId: account.id,
      fileIds,
      title,
      shareUrl: finalUrl,
      password: sharePwd,
      createdAt: Date.now(),
      expiredAt: options?.expireDays && options.expireDays > 0
        ? Date.now() + options.expireDays * 86_400_000
        : undefined,
      raw: pwdRes.data,
    }
  }

  private generateRandomCode(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length))
    return result
  }

  async parseShareLink(url: string, password?: string): Promise<{ shareId: string; password?: string; raw?: unknown }> {
    // 参照 QuarkPanTool get_pwd_id: share_url.split('?')[0].split('/s/')[-1]
    const match = url.match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/)
    if (!match) throw new Error('无法解析夸克分享链接，请确认链接格式正确')
    const pwdMatch = url.match(/pwd=([a-zA-Z0-9]+)/)
    return { shareId: match[1], password: password || (pwdMatch ? pwdMatch[1] : undefined), raw: undefined }
  }

  /**
   * 获取分享详情（参照 QuarkPanTool get_stoken + get_detail）
   */
  async getShareDetail(account: DriveAccount, input: TransferLinkInput): Promise<ShareDetail> {
    const directory = await this.listSharedDirectory(account, input)
    return { platform: 'quark', shareId: directory.shareId, title: directory.title, files: directory.entries }
  }

  async listSharedDirectory(account: DriveAccount, input: TransferLinkInput, options: SharedDirectoryOptions = {}): Promise<SharedDirectoryResult> {
    options.signal?.throwIfAborted()
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const parsed = await this.parseShareLink(input.url, input.password)
    const pwd = input.password || parsed.password || ''

    // Step 1: get_stoken（参照 QuarkPanTool line 50-69）
    let stoken = getCachedStoken(parsed.shareId) || ''

    if (!stoken) {
      const tokenRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token',
        account,
        { method: 'POST', body: { pwd_id: parsed.shareId, passcode: pwd } },
      )

      if (tokenRes.code !== 0) {
        if (tokenRes.code === 41012) throw new Error('提取码错误')
        if (tokenRes.code === 41014) throw new Error('分享已失效')
        throw new Error(`获取分享 token 失败: ${tokenRes.message}`)
      }
      stoken = tokenRes.data?.stoken || ''
      if (stoken) setCachedStoken(parsed.shareId, stoken)
    }

    // Step 2: get_detail（参照 QuarkPanTool line 71-122）
    const allFiles: SharedDirectoryResult['entries'] = []
    let shareTitle: string | undefined
    let page = 1
    const pageSize = 50
    const pages = new SharedDirectoryPages()

    while (true) {
      options.signal?.throwIfAborted()
      const params: Record<string, string> = {
        pwd_id: parsed.shareId,
        stoken,
        pdir_fid: options.parentId || '0',
        force: '0',
        _page: String(page),
        _size: String(pageSize),
        _sort: 'file_type:asc,updated_at:desc',
      }

      const detailRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail',
        account,
        { params },
      )

      if (detailRes.code !== 0) {
        if (detailRes.code === 41001) throw new Error('登录已失效')
        if (detailRes.code === 41012) throw new Error('提取码错误')
        if (detailRes.code === 41014) throw new Error('分享已失效')
        throw new Error(`获取分享详情失败: ${detailRes.message}`)
      }

      if (!shareTitle && detailRes.data?.title) shareTitle = detailRes.data.title

      if (!Array.isArray(detailRes.data?.list)) throw new Error('分享目录列表无效，无法确认完整性')
      const list = detailRes.data.list
      options.signal?.throwIfAborted()
      for (const f of list) allFiles.push(sharedEntry(f, 'pan'))
      if (!pages.accept(list.map((f: { fid: string }) => String(f.fid || '')), pageSize, detailRes.metadata)) break
      page++
    }

    return { shareId: parsed.shareId, title: shareTitle, entries: allFiles, complete: true }
  }

  /**
   * 转存分享文件（完全参照 QuarkPanTool run 流程）
   * Step 1: get_stoken
   * Step 2: get_detail -> 获取 fid_list + share_fid_token_list
   * Step 3: get_share_save_task_id -> POST /share/sharepage/save
   * Step 4: submit_task -> 轮询 /task
   */
  async saveSharedFiles(account: DriveAccount, input: TransferLinkInput, targetDirId: string, options: SharedSaveOptions = {}): Promise<TransferResult> {
    options.signal?.throwIfAborted()
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const parsed = await this.parseShareLink(input.url, input.password)
    const pwd = input.password || parsed.password || ''

    // ── Step 1: get_stoken（参照 QuarkPanTool line 50-69） ──
    let stoken = getCachedStoken(parsed.shareId) || ''

    if (!stoken) {
      const tokenRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token',
        account,
        { method: 'POST', body: { pwd_id: parsed.shareId, passcode: pwd } },
      )

      if (tokenRes.code !== 0) {
        if (tokenRes.code === 41012) throw new Error('转存失败：提取码错误')
        if (tokenRes.code === 41014) throw new Error('转存失败：分享已失效')
        throw new Error(`获取分享 token 失败: ${tokenRes.message}`)
      }
      stoken = tokenRes.data?.stoken || ''
      if (stoken) setCachedStoken(parsed.shareId, stoken)
    }

    // ── Step 2: get_detail（参照 QuarkPanTool line 71-122, 213-243） ──
    const allFids: string[] = []
    const allFidTokens: string[] = []
    let isOwner = 0
    let page = 1
    const pageSize = 50
    const pages = new SharedDirectoryPages()

    while (true) {
      options.signal?.throwIfAborted()
      const params: Record<string, string> = {
        pwd_id: parsed.shareId,
        stoken,
        pdir_fid: options.sourceParentId || '0',
        force: '0',
        _page: String(page),
        _size: String(pageSize),
        _sort: 'file_type:asc,updated_at:desc',
      }

      const detailRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail',
        account,
        { params },
      )

      if (detailRes.code !== 0) {
        if (detailRes.code === 41001) throw new Error('转存失败：登录已失效')
        if (detailRes.code === 41012) throw new Error('转存失败：提取码错误')
        if (detailRes.code === 41014) throw new Error('转存失败：分享已失效')
        throw new Error(`获取分享文件列表失败: ${detailRes.message}`)
      }

      // 参照 QuarkPanTool: is_owner 检查
      if (page === 1 && detailRes.data?.is_owner !== undefined) {
        isOwner = detailRes.data.is_owner
      }

      if (!Array.isArray(detailRes.data?.list)) throw new Error('分享目录列表无效，无法确认完整性')
      const list = detailRes.data.list
      for (const f of list) {
        allFids.push(f.fid)
        allFidTokens.push(f.share_fid_token || '')
      }

      if (!pages.accept(list.map((f: { fid: string }) => String(f.fid || '')), pageSize, detailRes.metadata)) break
      page++
    }

    if (input.fileIds?.length) {
      const selected = new Set(input.fileIds)
      const keep = allFids.map((fid, index) => selected.has(fid) ? index : -1).filter(index => index >= 0)
      const fids = keep.map(index => allFids[index])
      const fidTokens = keep.map(index => allFidTokens[index])
      allFids.splice(0, allFids.length, ...fids)
      allFidTokens.splice(0, allFidTokens.length, ...fidTokens)
      if (allFids.length !== selected.size) throw new Error('分享文件在扫描后发生变化，请重新检查')
    }

    if (allFids.length === 0) throw new Error('转存失败：分享中没有文件')

    // 参照 QuarkPanTool line 293: is_owner 检查
    if (isOwner === 1) {
      return {
        platform: 'quark',
        accountId: account.id,
        sourceUrl: input.url,
        success: true,
        savedCount: 0,
        targetDirId,
        raw: { message: '网盘中已经存在该文件，无需再次转存' },
      }
    }

    // ── Step 3: get_share_save_task_id（参照 QuarkPanTool line 301-322） ──
    // 注意：使用 drive.quark.cn 而非 drive-pc.quark.cn（参照 QuarkPanTool line 303）
    options.signal?.throwIfAborted()
    const saveRes = await quarkRequest<QuarkApiResponse>(
      'https://drive.quark.cn/1/clouddrive/share/sharepage/save',
      account,
      {
        method: 'POST',
        body: {
          fid_list: allFids,
          fid_token_list: allFidTokens,
          to_pdir_fid: targetDirId === '0' ? '' : targetDirId,
          pwd_id: parsed.shareId,
          stoken,
          pdir_fid: options.sourceParentId || '0',
          scene: 'link',
        },
      },
    )

    if (saveRes.code !== 0) throw new Error(getQuarkErrorMessage(saveRes.code, '转存'))

    const taskId = saveRes.data?.task_id
    if (!taskId) throw new Error('转存失败：未返回任务 ID')

    // ── Step 4: submit_task（参照 QuarkPanTool line 417-448） ──
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(randomInt(500, 1000))

      const taskRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/task',
        account,
        { params: { task_id: taskId, retry_index: String(retryIndex) } },
      )

      // 参照 QuarkPanTool: message == 'ok' 且 status == 2 表示完成
      // 非 0 业务码即为夸克侧终态失败，直接抛出而不是空转到超时
      if (taskRes.code !== 0) throw new Error(getQuarkErrorMessage(taskRes.code, '转存'))

      if (taskRes.data?.status === 2) {
        const folderName = taskRes.data.save_as?.to_pdir_name || '根目录'
        // Only the save response identifies files in the receiving account.
        // Share-page IDs and names cannot establish destination IDs or order.
        const destinationIds = taskRes.data.save_as?.save_as_top_fids
        const savedFileIds = Array.isArray(destinationIds)
          ? destinationIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
          : undefined
        return {
          platform: 'quark',
          accountId: account.id,
          sourceUrl: input.url,
          success: true,
          savedCount: allFids.length,
          targetDirId,
          savedFileIds,
          raw: { ...taskRes.data, folder_name: folderName },
        }
      }
    }

    throw new Error('转存超时，请稍后重试')
  }

  async upload(
    account: DriveAccount,
    localFilePath: string,
    targetDirId: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    const fs = require('fs')
    const path = require('path')
    const crypto = require('crypto')
    options?.signal?.throwIfAborted()

    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileName = options?.fileName || path.basename(localFilePath)
    const fileSize = fs.statSync(localFilePath).size
    const completedUpload = (fileId: unknown): UploadResult => {
      options?.signal?.throwIfAborted()
      options?.onProgress?.({ loaded: fileSize, total: fileSize, percent: 100, speed: 0 })
      return { success: true, fileId: typeof fileId === 'string' && fileId ? fileId : undefined, fileName, fileSize }
    }

    // 流式计算文件哈希（避免将整个文件读入内存）
    const { md5: md5Hash, sha1: sha1Hash } = await new Promise<{ md5: string; sha1: string }>((resolve, reject) => {
      const md5 = crypto.createHash('md5')
      const sha1 = crypto.createHash('sha1')
      const stream = fs.createReadStream(localFilePath)
      stream.on('data', (chunk: Buffer) => { md5.update(chunk); sha1.update(chunk) })
      stream.on('end', () => resolve({ md5: md5.digest('hex'), sha1: sha1.digest('hex') }))
      stream.on('error', reject)
    })

    // 1. 预上传（alist upPre）
    const now = Date.now()
    const preRes = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/upload/pre',
      account,
      {
        method: 'POST',
        body: {
          ccp_hash_update: true,
          dir_name: '',
          file_name: fileName,
          format_type: 'application/octet-stream',
          l_created_at: now,
          l_updated_at: now,
          pdir_fid: targetDirId || '0',
          size: fileSize,
        },
      },
    )

    if (preRes.code !== 0) {
      throw new Error(`预上传失败: ${preRes.message}`)
    }

    options?.signal?.throwIfAborted()

    const preData = preRes.data
    const taskId = preData?.task_id
    const uploadId = preData?.upload_id
    const bucket = preData?.bucket
    const objKey = preData?.obj_key
    const uploadUrl = preData?.upload_url
    const authInfo = preData?.auth_info
    const callback = preData?.callback
    const partSize = preRes.metadata?.part_size || 4 * 1024 * 1024

    // 如果预上传直接返回 finish（秒传）
    if (preData?.finish === true) {
      log.info(`Quark: rapid upload success (pre finish) for ${fileName}`)
      return completedUpload(preData.fid)
    }

    if (!taskId) {
      throw new Error('预上传响应缺少 task_id')
    }

    // 2. Hash 检查（alist upHash）
    const hashRes = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/update/hash',
      account,
      {
        method: 'POST',
        body: { md5: md5Hash, sha1: sha1Hash, task_id: taskId },
      },
    )

    options?.signal?.throwIfAborted()
    if (hashRes.code !== 0) throw new Error(`上传哈希检查失败: ${hashRes.message}`)
    if (hashRes.data?.finish === true) {
      log.info(`Quark: rapid upload success (hash finish) for ${fileName}`)
      return completedUpload(hashRes.data?.fid || preData.fid)
    }

    // 3. 分片上传（alist upPart + upCommit + upFinish）
    const totalParts = Math.ceil(fileSize / partSize)
    if (!Number.isSafeInteger(partSize) || partSize <= 0 || partSize > 256 * 1024 * 1024 || totalParts > 10000) throw new Error('上传分片大小或数量超出当前支持范围')
    if ([uploadUrl, bucket, objKey, uploadId, authInfo].some(value => typeof value !== 'string' || !value)) throw new Error('预上传响应缺少有效上传参数')
    let uploadedBytes = 0
    const etags: string[] = []

    // alist: u := fmt.Sprintf("https://%s.%s/%s", pre.Data.Bucket, pre.Data.UploadUrl[7:], pre.Data.ObjKey)
    const uploadHost = uploadUrl.replace(/^https?:\/\//, '')
    const ossBaseUrl = `https://${bucket}.${uploadHost}/${objKey}`

    // 打开文件描述符，按分片读取（避免将整个文件读入内存）
    const fd = fs.openSync(localFilePath, 'r')
    const chunkBuf = Buffer.alloc(partSize)

    try {
    for (let i = 0; i < totalParts; i++) {
      options?.signal?.throwIfAborted()
      const start = i * partSize
      const end = Math.min(start + partSize, fileSize)
      const chunkSize = end - start
      const bytesRead = fs.readSync(fd, chunkBuf, 0, chunkSize, start)
      if (bytesRead !== chunkSize) throw new Error('上传文件在读取过程中发生变化')
      const chunk = chunkBuf.subarray(0, bytesRead)
      const partNumber = i + 1

      // alist upPart: auth_meta 格式
      const timeStr = new Date().toUTCString()
      const mimeType = 'application/octet-stream'
      const authMeta = [
        'PUT',
        '', // Content-MD5 is empty; this newline is part of the signed bytes.
        mimeType,
        timeStr,
        `x-oss-date:${timeStr}`,
        'x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
        `/${bucket}/${objKey}?partNumber=${partNumber}&uploadId=${uploadId}`,
      ].join('\n')

      const partAuthRes = await quarkRequest<any>(
        'https://drive-pc.quark.cn/1/clouddrive/file/upload/auth',
        account,
        {
          method: 'POST',
          body: { auth_info: authInfo, auth_meta: authMeta, task_id: taskId },
        },
      )

      if (partAuthRes.code !== 0) {
        throw new Error(`获取分片授权失败: ${partAuthRes.message}`)
      }

      const authKey = partAuthRes.data?.auth_key
      options?.signal?.throwIfAborted()
      if (typeof authKey !== 'string' || !authKey) throw new Error('分片授权响应缺少有效 auth_key')

      // alist: SetQueryParams + SetBody(bytes).Put(u)
      const ossUrl = `${ossBaseUrl}?partNumber=${partNumber}&uploadId=${uploadId}`
      const ossRes = await fetch(ossUrl, {
        signal: options?.signal,
        method: 'PUT',
        headers: {
          'Authorization': authKey,
          'Content-Type': mimeType,
          'Referer': 'https://pan.quark.cn/',
          'x-oss-date': timeStr,
          'x-oss-user-agent': 'aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
        },
        body: chunk,
      })

      if (!ossRes.ok) {
        const errText = await ossRes.text()
        throw new Error(`上传分片 ${partNumber} 失败: status=${ossRes.status}, ${errText}`)
      }

      const etag = ossRes.headers.get('etag') || ''
      if (!etag) throw new Error('上传分片响应缺少 ETag，无法确认分片完成')
      etags.push(etag)
      uploadedBytes += chunk.length

      options?.onProgress?.({
        loaded: uploadedBytes,
        total: fileSize,
        percent: fileSize > 0 ? Math.min(99, Math.round((uploadedBytes / fileSize) * 100)) : 0,
        speed: 0,
      })
    }
    } finally {
      fs.closeSync(fd)
    }

    // 4. 提交分片（alist upCommit）
    let xmlBody = '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n'
    for (let i = 0; i < etags.length; i++) {
      xmlBody += `<Part>\n<PartNumber>${i + 1}</PartNumber>\n<ETag>${etags[i]}</ETag>\n</Part>\n`
    }
    xmlBody += '</CompleteMultipartUpload>'

    const contentMd5 = crypto.createHash('md5').update(xmlBody).digest('base64')
    const callbackBase64 = Buffer.from(JSON.stringify(callback)).toString('base64')

    const commitTimeStr = new Date().toUTCString()
    const commitAuthMeta = [
      'POST',
      contentMd5,
      'application/xml',
      commitTimeStr,
      `x-oss-callback:${callbackBase64}`,
      `x-oss-date:${commitTimeStr}`,
      'x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
      `/${bucket}/${objKey}?uploadId=${uploadId}`,
    ].join('\n')

    const commitAuthRes = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/upload/auth',
      account,
      {
        method: 'POST',
        body: { auth_info: authInfo, auth_meta: commitAuthMeta, task_id: taskId },
      },
    )

    if (commitAuthRes.code !== 0) {
      throw new Error(`获取提交授权失败: ${commitAuthRes.message}`)
    }

    const commitUrl = `${ossBaseUrl}?uploadId=${uploadId}`
    options?.signal?.throwIfAborted()
    const commitRes = await fetch(commitUrl, {
      signal: options?.signal,
      method: 'POST',
      headers: {
        'Authorization': commitAuthRes.data?.auth_key,
        'Content-MD5': contentMd5,
        'Content-Type': 'application/xml',
        'Referer': 'https://pan.quark.cn/',
        'x-oss-callback': callbackBase64,
        'x-oss-date': commitTimeStr,
        'x-oss-user-agent': 'aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
      },
      body: xmlBody,
    })

    if (!commitRes.ok) {
      const errText = await commitRes.text()
      throw new Error(`提交分片失败: status=${commitRes.status}, ${errText}`)
    }

    // 5. 完成上传（alist upFinish）
    await new Promise(resolve => setTimeout(resolve, 1000))
    options?.signal?.throwIfAborted()

    const finishRes = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/upload/finish',
      account,
      {
        method: 'POST',
        body: { obj_key: objKey, task_id: taskId },
      },
    )

    if (finishRes.code !== 0) {
      throw new Error(`完成上传失败: ${finishRes.message}`)
    }

    log.info(`Quark: upload success for ${fileName}`)

    return completedUpload(finishRes.data?.fid || preData.fid)
  }

  /**
   * 获取原文件下载链接。转码播放流不能用于文件下载或迁移。
   */
  async getDownloadSource(account: DriveAccount, fileId: string): Promise<DriveDownloadSource> {
    let cookies = account.credential.cookies || ''
    const url = await this.getDownloadUrl(account, fileId, value => { cookies = value })
    return {
      url,
      headers: { Cookie: cookies, Referer: 'https://pan.quark.cn/', 'User-Agent': QUARK_UA },
    }
  }

  async getDownloadUrl(account: DriveAccount, fileId: string, onResponseCookies?: (cookies: string) => void): Promise<string> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    let downloadRes: { code: number; message?: string; data?: Array<{ download_url?: string }> }
    try {
      downloadRes = await quarkRequest<typeof downloadRes>(
        'https://drive-pc.quark.cn/1/clouddrive/file/download',
        account,
        {
          method: 'POST',
          body: { fids: [fileId] },
          onResponseCookies,
        },
      )
    } catch (error) {
      throw new Error(`获取原文件下载链接失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (downloadRes.code === 0 && downloadRes.data?.[0]?.download_url) {
      return downloadRes.data[0].download_url
    }
    throw new Error(`获取原文件下载链接失败: code=${downloadRes.code}, message=${downloadRes.message || '平台未返回原文件下载地址'}`)
  }

  /**
   * 获取转码链接（alist getTranscodingLink，视频文件备选）
   */
  async getTranscodingLink(account: DriveAccount, fileId: string): Promise<string> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const res = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/v2/play/project',
      account,
      {
        method: 'POST',
        body: {
          fid: fileId,
          resolutions: 'low,normal,high,super,2k,4k',
          supports: 'fmp4_av,m3u8,dolby_vision',
        },
      },
    )

    if (res.code !== 0) {
      throw new Error(`获取转码链接失败: code=${res.code}, message=${res.message || 'unknown'}`)
    }

    const videoList = res.data?.video_list || []
    for (const info of videoList) {
      if (info.video_info?.url) {
        return info.video_info.url
      }
    }

    throw new Error('没有可用的转码链接')
  }

  /**
   * 下载原文件到本地；无法获取原文件地址时明确失败。
   */
  async download(
    account: DriveAccount,
    fileId: string,
    localDirPath: string,
    options?: DownloadOptions,
  ): Promise<DownloadResult> {
    options?.signal?.throwIfAborted()

    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileName = options?.fileName || 'download'
    const localPath = resolvePathInside(localDirPath, sanitizeFileName(fileName))

    // 获取下载链接
    let downloadCookies = cookies
    const downloadUrl = await this.getDownloadUrl(account, fileId, value => { downloadCookies = value })

    // 下载文件（alist: 带 Cookie/Referer/User-Agent）
    const response = await fetch(downloadUrl, {
      signal: options?.signal,
      headers: {
        'Cookie': downloadCookies,
        'Referer': 'https://pan.quark.cn/',
        'User-Agent': QUARK_UA,
      },
    })
    if (!response.ok) {
      throw new Error(`下载失败: ${response.statusText}`)
    }

    // 从 Content-Length 获取文件大小
    const loaded = await writeDownloadResponse(response, localPath, options)
    return { success: true, localPath, fileName, fileSize: loaded }
  }

  async getQuota(account: DriveAccount): Promise<{ used: number; total: number }> {
    const cookies = account.credential.cookies || ''
    if (!cookies) throw new Error('未登录')

    const data = await quarkRequest<any>('https://drive-pc.quark.cn/1/clouddrive/member', account)
    const quota = data.data || data
    const used = Number(quota.use_capacity ?? quota.secret_use_capacity ?? quota.used_capacity ?? quota.used ?? 0)
    const total = Number(quota.total_capacity ?? quota.secret_total_capacity ?? quota.capacity ?? quota.total ?? 0)
    if (!Number.isFinite(total) || total <= 0) throw new Error('夸克网盘容量数据不可用')
    return { used: Number.isFinite(used) ? used : 0, total }
  }

  async getMembership(account: DriveAccount) {
    const cookies = account.credential.cookies || ''
    if (!cookies) throw new Error('未登录')
    const data = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/member',
      account,
      { params: { pr: 'ucpro', fr: 'pc' } },
    )
    return normalizeMembership(data, '夸克')
  }
}

export const quarkAdapter = new QuarkAdapter()

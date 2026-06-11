import { session, net } from 'electron'
import type { DriveAdapter } from './base'
import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, ShareTaskPayload, TransferLinkInput, TransferResult, UploadOptions, UploadResult, DownloadOptions, DownloadResult } from '../shared/types'
import { generateId, sleep, randomInt } from '../shared/utils'
import log from 'electron-log'

// ── 常量（完全参照 QuarkPanTool） ──

const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko)' +
  ' Chrome/94.0.4606.71 Safari/537.36 Core/1.94.225.400 QQBrowser/12.2.5544.400'

const QUARK_HEADERS: Record<string, string> = {
  'user-agent': QUARK_UA,
  'origin': 'https://pan.quark.cn',
  'referer': 'https://pan.quark.cn/',
  'accept-language': 'zh-CN,zh;q=0.9',
}

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

/**
 * 夸克 API 请求（完全参照 QuarkPanTool 的 headers + cookie 方式）
 * 不使用 session.fetch，直接用 net.request + Cookie header
 */
const QUARK_SESSION = 'persist:quark'

/**
 * 夸克 API 请求（使用 session.fetch + Cookie header）
 * 完全参照 QuarkPanTool 的 httpx 方式
 */
async function quarkRequest<T>(
  url: string,
  cookies: string,
  options: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
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
    'cookie': cookies,
    'Accept': 'application/json, text/plain, */*',
  }

  const fetchOptions: RequestInit = { method, headers }

  if (options.body) {
    headers['Content-Type'] = 'application/json'
    fetchOptions.body = JSON.stringify(options.body)
  }

  const ses = session.fromPartition(QUARK_SESSION)
  const response = await ses.fetch(finalUrl, fetchOptions)
  const text = await response.text()

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Failed to parse Quark API response: ${text.substring(0, 200)}`)
  }
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
    isDir: f.file_type === 0 || f.dir === true,
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
        cookies,
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
      cookies,
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

    const pageSize = 200
    const maxPages = 100
    const allFiles: FileItem[] = []

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
        cookies,
        { params },
      )

      if (res.code !== 0) throw new Error(`获取文件列表失败: ${res.message}`)

      const items = res.data?.list
      if (!Array.isArray(items)) break

      allFiles.push(...items.map((f: QuarkFileItem) => mapQuarkFile(f, account.id)))

      // 参照 QuarkPanTool 的分页逻辑
      const metadata = res.metadata
      if (metadata) {
        if (metadata._total <= metadata._size || metadata._count < metadata._size) break
      } else {
        if (items.length < pageSize) break
      }

      await sleep(200)
    }

    return { files: allFiles, parentId, hasMore: false }
  }

  /**
   * 搜索文件（参照 QuarkPanTool search 逻辑）
   */
  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const pageSize = 50
    const maxPages = 100
    const allFiles: FileItem[] = []

    for (let page = 1; page <= maxPages; page++) {
      const res = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/file/search',
        cookies,
        { method: 'POST', body: { keyword, _page: page, _size: pageSize, _sort: '' } },
      )

      if (res.code !== 0) throw new Error(`搜索失败: ${res.message}`)

      const items = res.data?.list
      if (!Array.isArray(items)) break

      allFiles.push(...items.map((f: QuarkFileItem) => mapQuarkFile(f, account.id)))

      if (items.length < pageSize) break
      await sleep(200)
    }

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
      cookies,
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
      'https://drive-pc.quark.cn/1/clouddrive/rename',
      cookies,
      { method: 'POST', body: { fid: fileId, file_name: newName } },
    )
    if (res.code !== 0) throw new Error(`重命名失败: ${res.message}`)
  }

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/move',
      cookies,
      { method: 'POST', body: { file_fids: fileIds, to_pdir_fid: targetDirId } },
    )
    if (res.code !== 0) throw new Error(`移动失败: ${res.message}`)
  }

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/file/delete',
      cookies,
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

    const fid = items[0].fileId
    const title = options?.title || (items[0].name || '分享文件')

    // ── Step 1: get_share_task_id（参照 QuarkPanTool line 507-536） ──
    const urlType = options?.password ? 2 : 1
    const body: Record<string, unknown> = {
      fid_list: [fid],
      title,
      url_type: urlType,
      expired_type: this.mapExpireDays(options?.expireDays),
    }
    if (urlType === 2) {
      body.passcode = options?.password || this.generateRandomCode()
    }

    const shareRes = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/share',
      cookies,
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
        cookies,
        { params: { task_id: taskId, retry_index: String(retryIndex) } },
      )

      if (taskRes.code !== 0) {
        if (taskRes.code === 32003) throw new Error('分享失败：容量不足')
        if (taskRes.code === 41013) throw new Error('分享失败：文件违规或不可分享')
        continue
      }

      if (taskRes.data?.status === 2) {
        shareId = taskRes.data.share_id || ''
        break
      }
    }

    if (!shareId) throw new Error('分享超时，请稍后在分享链接页面查看')

    // ── Step 3: submit_share（参照 QuarkPanTool line 553-572） ──
    const pwdRes = await quarkRequest<QuarkApiResponse>(
      'https://drive-pc.quark.cn/1/clouddrive/share/password',
      cookies,
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
      fileIds: [fid],
      title,
      shareUrl: finalUrl,
      password: sharePwd,
      createdAt: Date.now(),
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
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const parsed = await this.parseShareLink(input.url, input.password)
    const pwd = input.password || parsed.password || ''

    // Step 1: get_stoken（参照 QuarkPanTool line 50-69）
    let stoken = getCachedStoken(parsed.shareId) || ''

    if (!stoken) {
      const tokenRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token',
        cookies,
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
    const allFiles: ShareDetail['files'] = []
    let shareTitle: string | undefined
    let page = 1
    const pageSize = 50

    while (true) {
      const params: Record<string, string> = {
        pwd_id: parsed.shareId,
        stoken,
        pdir_fid: '0',
        force: '0',
        _page: String(page),
        _size: String(pageSize),
        _sort: 'file_type:asc,updated_at:desc',
      }

      const detailRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail',
        cookies,
        { params },
      )

      if (detailRes.code !== 0) {
        if (detailRes.code === 41001) throw new Error('登录已失效')
        if (detailRes.code === 41012) throw new Error('提取码错误')
        if (detailRes.code === 41014) throw new Error('分享已失效')
        throw new Error(`获取分享详情失败: ${detailRes.message}`)
      }

      if (!shareTitle && detailRes.data?.title) shareTitle = detailRes.data.title

      const list = detailRes.data?.list || []
      for (const f of list) {
        allFiles.push({
          fileId: f.fid,
          name: f.file_name,
          isDir: f.dir === 1 || f.is_dir === 1,
          size: f.size,
          raw: f,
        })
      }

      // 参照 QuarkPanTool 的分页逻辑
      const metadata = detailRes.metadata
      if (metadata) {
        if (metadata._total <= metadata._size || metadata._count < metadata._size) break
      } else {
        if (list.length < pageSize) break
      }
      page++
    }

    return { platform: 'quark', shareId: parsed.shareId, title: shareTitle, files: allFiles }
  }

  /**
   * 转存分享文件（完全参照 QuarkPanTool run 流程）
   * Step 1: get_stoken
   * Step 2: get_detail -> 获取 fid_list + share_fid_token_list
   * Step 3: get_share_save_task_id -> POST /share/sharepage/save
   * Step 4: submit_task -> 轮询 /task
   */
  async saveSharedFiles(account: DriveAccount, input: TransferLinkInput, targetDirId: string): Promise<TransferResult> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const parsed = await this.parseShareLink(input.url, input.password)
    const pwd = input.password || parsed.password || ''

    // ── Step 1: get_stoken（参照 QuarkPanTool line 50-69） ──
    let stoken = getCachedStoken(parsed.shareId) || ''

    if (!stoken) {
      const tokenRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token',
        cookies,
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
    const allFileNames: string[] = []
    let isOwner = 0
    let page = 1
    const pageSize = 50

    while (true) {
      const params: Record<string, string> = {
        pwd_id: parsed.shareId,
        stoken,
        pdir_fid: '0',
        force: '0',
        _page: String(page),
        _size: String(pageSize),
        _sort: 'file_type:asc,updated_at:desc',
      }

      const detailRes = await quarkRequest<QuarkApiResponse>(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail',
        cookies,
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

      const list = detailRes.data?.list || []
      for (const f of list) {
        allFids.push(f.fid)
        allFidTokens.push(f.share_fid_token || '')
        allFileNames.push(f.file_name || '')
      }

      const metadata = detailRes.metadata
      if (metadata) {
        if (metadata._total <= metadata._size || metadata._count < metadata._size) break
      } else {
        if (list.length < pageSize) break
      }
      page++
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
    const saveRes = await quarkRequest<QuarkApiResponse>(
      'https://drive.quark.cn/1/clouddrive/share/sharepage/save',
      cookies,
      {
        method: 'POST',
        body: {
          fid_list: allFids,
          fid_token_list: allFidTokens,
          to_pdir_fid: targetDirId === '0' ? '' : targetDirId,
          pwd_id: parsed.shareId,
          stoken,
          pdir_fid: '0',
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
        cookies,
        { params: { task_id: taskId, retry_index: String(retryIndex) } },
      )

      // 参照 QuarkPanTool: message == 'ok' 且 status == 2 表示完成
      if (taskRes.code !== 0) {
        if (taskRes.code === 32003) throw new Error('转存失败：容量不足')
        if (taskRes.code === 41013) throw new Error('转存失败：目标文件夹不存在')
        continue
      }

      if (taskRes.data?.status === 2) {
        const folderName = taskRes.data.save_as?.to_pdir_name || '根目录'
        const savedFileIds = taskRes.data.save_as?.save_as_top_fids || allFids
        return {
          platform: 'quark',
          accountId: account.id,
          sourceUrl: input.url,
          success: true,
          savedCount: allFids.length,
          targetDirId,
          savedFileIds,
          savedFileNames: allFileNames,
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

    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileName = options?.fileName || path.basename(localFilePath)
    const fileSize = fs.statSync(localFilePath).size

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
      cookies,
      {
        method: 'POST',
        body: {
          ccp_hash_update: true,
          dir_name: '',
          file_name: fileName,
          format_type: 'application/octet-stream',
          l_created_at: now,
          l_updated_at: now,
          pdir_fid: targetDirId === '0' ? '' : targetDirId,
          size: fileSize,
        },
      },
    )

    if (preRes.code !== 0) {
      throw new Error(`预上传失败: ${preRes.message}`)
    }

    log.info('Quark pre-upload response:', JSON.stringify(preRes, null, 2))

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
    if (preData?.finish) {
      log.info(`Quark: rapid upload success (pre finish) for ${fileName}`)
      return { success: true, fileId: preData.fid || taskId, fileName, fileSize }
    }

    if (!taskId) {
      throw new Error('预上传响应缺少 task_id')
    }

    // 2. Hash 检查（alist upHash）
    const hashRes = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/update/hash',
      cookies,
      {
        method: 'POST',
        body: { md5: md5Hash, sha1: sha1Hash, task_id: taskId },
      },
    )

    if (hashRes.code === 0 && hashRes.data?.finish) {
      log.info(`Quark: rapid upload success (hash finish) for ${fileName}`)
      return { success: true, fileId: hashRes.data?.fid || taskId, fileName, fileSize }
    }

    // 3. 分片上传（alist upPart + upCommit + upFinish）
    const totalParts = Math.ceil(fileSize / partSize)
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
      const start = i * partSize
      const end = Math.min(start + partSize, fileSize)
      const chunkSize = end - start
      const bytesRead = fs.readSync(fd, chunkBuf, 0, chunkSize, start)
      const chunk = chunkBuf.subarray(0, bytesRead)
      const partNumber = i + 1

      // alist upPart: auth_meta 格式
      const timeStr = new Date().toUTCString()
      const mimeType = 'application/octet-stream'
      const authMeta = [
        'PUT',
        '',
        mimeType,
        timeStr,
        `x-oss-date:${timeStr}`,
        'x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
        `/${bucket}/${objKey}?partNumber=${partNumber}&uploadId=${uploadId}`,
      ].join('\n')

      const partAuthRes = await quarkRequest<any>(
        'https://drive-pc.quark.cn/1/clouddrive/file/upload/auth',
        cookies,
        {
          method: 'POST',
          body: { auth_info: authInfo, auth_meta: authMeta, task_id: taskId },
        },
      )

      if (partAuthRes.code !== 0) {
        throw new Error(`获取分片授权失败: ${partAuthRes.message}`)
      }

      const authKey = partAuthRes.data?.auth_key

      // alist: SetQueryParams + SetBody(bytes).Put(u)
      const ossUrl = `${ossBaseUrl}?partNumber=${partNumber}&uploadId=${uploadId}`
      const ossRes = await fetch(ossUrl, {
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
      etags.push(etag)
      uploadedBytes += chunk.length

      options?.onProgress?.({
        loaded: uploadedBytes,
        total: fileSize,
        percent: Math.round((uploadedBytes / fileSize) * 100),
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
      cookies,
      {
        method: 'POST',
        body: { auth_info: authInfo, auth_meta: commitAuthMeta, task_id: taskId },
      },
    )

    if (commitAuthRes.code !== 0) {
      throw new Error(`获取提交授权失败: ${commitAuthRes.message}`)
    }

    const commitUrl = `${ossBaseUrl}?uploadId=${uploadId}`
    const commitRes = await fetch(commitUrl, {
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

    const finishRes = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/upload/finish',
      cookies,
      {
        method: 'POST',
        body: { obj_key: objKey, task_id: taskId },
      },
    )

    if (finishRes.code !== 0) {
      throw new Error(`完成上传失败: ${finishRes.message}`)
    }

    log.info(`Quark: upload success for ${fileName}`)

    return {
      success: true,
      fileId: finishRes.data?.fid || taskId,
      fileName,
      fileSize,
    }
  }

  /**
   * 获取下载链接（alist Link 逻辑：先尝试下载链接，失败后尝试转码链接）
   */
  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    // 1. 尝试常规下载（alist getDownloadLink）
    let downloadRes: any
    try {
      downloadRes = await quarkRequest<any>(
        'https://drive-pc.quark.cn/1/clouddrive/file/download',
        cookies,
        {
          method: 'POST',
          body: { fids: [fileId] },
        },
      )

      if (downloadRes.code === 0 && downloadRes.data?.[0]?.download_url) {
        return downloadRes.data[0].download_url
      }
    } catch (err: any) {
      downloadRes = { code: -1, message: err.message }
    }

    // 2. 下载链接失败，尝试转码链接（alist: UseTransCodingAddress → getTranscodingLink）
    log.info(`Quark: download link failed (code=${downloadRes.code}), trying transcoding link...`)
    try {
      return await this.getTranscodingLink(account, fileId)
    } catch (transcodeErr: any) {
      // 3. 转码也失败（如 plf_invalid），抛出原始下载错误
      throw new Error(`获取下载链接失败: code=${downloadRes.code}, message=${downloadRes.message || 'unknown'}`)
    }
  }

  /**
   * 获取转码链接（alist getTranscodingLink，视频文件备选）
   */
  async getTranscodingLink(account: DriveAccount, fileId: string): Promise<string> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const res = await quarkRequest<any>(
      'https://drive-pc.quark.cn/1/clouddrive/file/v2/play/project',
      cookies,
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
   * 下载文件到本地（alist Link 逻辑：先尝试下载链接，失败后尝试转码链接）
   */
  async download(
    account: DriveAccount,
    fileId: string,
    localDirPath: string,
    options?: DownloadOptions,
  ): Promise<DownloadResult> {
    const fs = require('fs')
    const path = require('path')

    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileName = options?.fileName || 'download'
    const localPath = path.join(localDirPath, fileName)

    // 获取下载链接
    const downloadUrl = await this.getDownloadUrl(account, fileId)

    // 下载文件（alist: 带 Cookie/Referer/User-Agent）
    const response = await fetch(downloadUrl, {
      headers: {
        'Cookie': cookies,
        'Referer': 'https://pan.quark.cn/',
        'User-Agent': QUARK_UA,
      },
    })
    if (!response.ok) {
      throw new Error(`下载失败: ${response.statusText}`)
    }

    // 从 Content-Length 获取文件大小
    const contentLength = response.headers.get('Content-Length')
    const fileSize = contentLength ? parseInt(contentLength, 10) : 0

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
          total: fileSize || loaded,
          percent: fileSize > 0 ? Math.round((loaded / fileSize) * 100) : 0,
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
        fileSize: loaded, // 使用实际下载的字节数
      }
    } catch (err) {
      reader.cancel().catch(() => {})
      writer.destroy()
      try { fs.unlinkSync(localPath) } catch {}
      throw err
    }
  }

  async getQuota(account: DriveAccount): Promise<{ used: number; total: number }> {
    const cookies = account.credential.cookies || ''
    if (!cookies) throw new Error('未登录')

    // 尝试多个端点
    const endpoints = [
      'https://drive-pc.quark.cn/1/clouddrive/capacity?pr=ucpro&fr=pc',
      'https://drive-pc.quark.cn/1/clouddrive/account/capacity?pr=ucpro&fr=pc',
      'https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc',
    ]

    for (const url of endpoints) {
      try {
        const data = await new Promise<any>((resolve, reject) => {
          const request = net.request({ method: 'GET', url })
          request.setHeader('User-Agent', QUARK_UA)
          request.setHeader('Cookie', cookies)
          request.setHeader('Accept', 'application/json')
          request.setHeader('Referer', 'https://pan.quark.cn/')
          request.setHeader('Origin', 'https://pan.quark.cn')

          let responseData = ''
          request.on('response', (response) => {
            response.on('data', (chunk) => { responseData += chunk.toString() })
            response.on('end', () => {
              try { resolve(JSON.parse(responseData)) } catch { reject(new Error('parse error')) }
            })
            response.on('error', (err) => reject(err))
          })
          request.on('error', (err) => reject(err))
          request.end()
        })

        log.info(`[Quota] Quark ${url.split('?')[0]}:`, JSON.stringify(data).substring(0, 300))

        // 检查各种可能的数据结构
        const d = data.data || data
        const used = d.use_capacity || d.used_capacity || d.used || 0
        const total = d.total_capacity || d.capacity || d.total || 0
        if (total > 0) return { used, total }
      } catch {}
    }

    throw new Error('夸克网盘暂不支持容量查询')
  }
}

export const quarkAdapter = new QuarkAdapter()

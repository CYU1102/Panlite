import { writeDownloadResponse } from './download-response'
import { parseQuarkUcResponse } from './quark-uc-response'
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

/**
 * UC浏览器网盘适配器
 * API 与夸克几乎一致，base URL 改为 pc-api.uc.cn
 * 参考 xinyue-search UcPan.php
 */

const UC_API = 'https://pc-api.uc.cn/1/clouddrive'
const UC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── 接口定义（与夸克一致） ──

interface UcApiResponse<T = unknown> {
  status: number
  code: number
  message: string
  data: T
  metadata?: Record<string, unknown>
}

interface UcUserInfo {
  nickname: string
  avatar: string
  member_type: number
}

interface UcFileListData {
  list: UcFileItem[]
  metadata: { _total: number; _count: number; _page: number; _size: number }
}

interface UcFileItem {
  file?: boolean
  fid: string
  pdir_fid: string
  file_name: string
  file_type: number
  size: number
  created_at: number
  updated_at: number
  status: number
  share: number
  tags: string[]
}

interface UcMkdirData {
  fid: string
  pdir_fid: string
  file_name: string
  file_type: number
  created_at: number
  updated_at: number
}

interface UcSearchData {
  list: UcFileItem[]
  metadata: { _total: number }
}

// ── Low-level request ──

const UC_SESSION = 'persist:uc'

async function injectCookies(cookieStr: string): Promise<void> {
  const ses = session.fromPartition(UC_SESSION)
  const pairs = cookieStr.split(';').map((p) => p.trim()).filter(Boolean)
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx < 1) continue
    const name = pair.substring(0, eqIdx).trim()
    const value = pair.substring(eqIdx + 1).trim()
    if (!name) continue
    try {
      await ses.cookies.set({
        url: 'https://pc-api.uc.cn',
        name,
        value,
        domain: '.uc.cn',
        path: '/',
        secure: true,
      })
    } catch {
      // ignore
    }
  }
}

async function ucRequest<T>(
  url: string,
  cookies: string,
  options: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<UcApiResponse<T>> {
  const method = options.method || 'GET'
  const urlObj = new URL(url)

  // UC 通用参数：pr=UCBrowser, fr=pc
  if (!urlObj.searchParams.has('pr')) {
    urlObj.searchParams.set('pr', 'UCBrowser')
    urlObj.searchParams.set('fr', 'pc')
  }

  const finalUrl = urlObj.toString()
  log.info(`UC ${method} ${urlObj.pathname}`)

  await injectCookies(cookies)

  const headers: Record<string, string> = {
    'User-Agent': UC_UA,
    'Origin': 'https://drive.uc.cn',
    'Referer': 'https://drive.uc.cn/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cookie': cookies,
  }

  const fetchOptions: RequestInit = { method, headers }

  if (options.body) {
    headers['Content-Type'] = 'application/json'
    fetchOptions.body = JSON.stringify(options.body)
  }

  const ses = session.fromPartition(UC_SESSION)
  const response = await ses.fetch(finalUrl, fetchOptions)
  const text = await response.text()
  log.info(`UC ${method} ${urlObj.pathname} -> status=${response.status}`)
  return parseQuarkUcResponse(text, response.status, urlObj, method, 'uc') as unknown as UcApiResponse<T>
}

function mapUcFile(f: UcFileItem, accountId: string): FileItem {
  return {
    id: f.fid,
    path: f.fid,
    parentId: f.pdir_fid,
    name: f.file_name,
    isDir: typeof f.file === 'boolean' ? !f.file : f.file_type === 0,
    size: f.size || 0,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    platform: 'uc',
    accountId,
  }
}

// ── 错误码 ──

const UC_ERROR_CODES: Record<number, string> = {
  [41001]: '登录已失效，请重新登录',
  [41010]: '目标目录不存在',
  [41012]: '提取码错误',
  [41013]: '文件违规或不可分享/转存',
  [41014]: '分享已失效',
  [41019]: '容量不足',
  [41020]: '请求过于频繁',
  [41026]: '没有可分享的文件（分享可能已失效、被限制保存或提取码不匹配）',
  [32003]: '容量不足',
}

function getUcErrorMessage(code: number, action: string): string {
  const msg = UC_ERROR_CODES[code] || `未知错误 (code=${code})`
  return `${action}失败: ${msg}`
}

// ── Adapter ──

export class UcAdapter implements DriveAdapter {
  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      const cookies = account.credential.cookies
      if (!cookies) {
        log.warn('UC checkLogin: no cookies')
        return false
      }
      log.info(`UC checkLogin: cookie length=${cookies.length}`)
      const res = await ucRequest<UcUserInfo>(`${UC_API}/member`, cookies)
      log.info(`UC checkLogin: response code=${res.code}, message=${res.message || 'ok'}`)
      return res.code === 0
    } catch (err) {
      log.warn('UC checkLogin failed:', String(err))
      return false
    }
  }

  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    // drive.uc.cn/account/info 返回 { success: true, data: { nickname, avatarUri, uid, ... } }
    try {
      const url = 'https://drive.uc.cn/account/info?fr=pc&platform=pc'
      const ses = session.fromPartition(UC_SESSION)
      await injectCookies(cookies)
      const response = await ses.fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': UC_UA,
          'Cookie': cookies,
          'Referer': 'https://drive.uc.cn/',
          'Accept': 'application/json, text/plain, */*',
        },
      })
      const res = await response.json() as { success?: boolean; data?: { nickname?: string; avatarUri?: string; uid?: number } }
      log.info(`UC getUserInfo: success=${res.success}, nickname=${res.data?.nickname}`)
      if (res.data?.nickname) {
        return { nickname: res.data.nickname, avatar: res.data.avatarUri }
      }
    } catch (err) {
      log.warn('UC getUserInfo from drive.uc.cn failed:', String(err))
    }

    return { nickname: 'UC用户' }
  }

  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    // UC exposes the same pagination contract as Quark and intentionally uses
    // the shared Quark/UC setting from the settings page.
    const { quarkPageSize: pageSize, requestDelayMs } = getRequestSettings()
    const maxPages = 100
    const allFiles: FileItem[] = []
    let complete = false

    for (let page = 1; page <= maxPages; page++) {
      const url = `${UC_API}/file/sort?pdir_fid=${parentId}&_page=${page}&_size=${pageSize}&_sort=file_type:asc,updated_at:desc&_fetch_total=1&_fetch_sub_dirs=1`
      const res = await ucRequest<UcFileListData>(url, cookies)
      if (res.code !== 0) throw new Error(`UC listFiles failed: ${res.message}`)
      const items = res.data?.list
      if (!Array.isArray(items)) throw new Error('UC 文件列表响应无效')
      allFiles.push(...items.map((f) => mapUcFile(f, account.id)))
      if (items.length < pageSize) { complete = true; break }
      if (requestDelayMs > 0) await sleep(requestDelayMs)
    }
    if (!complete) throw new Error('UC 文件列表达到分页上限，结果不完整')
    return { files: allFiles, parentId, hasMore: false }
  }

  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const { quarkPageSize: pageSize, requestDelayMs } = getRequestSettings()
    const maxPages = 100
    const allFiles: FileItem[] = []
    let complete = false

    for (let page = 1; page <= maxPages; page++) {
      const res = await ucRequest<UcSearchData>(`${UC_API}/file/search`, cookies, {
        method: 'POST',
        body: { keyword, _page: page, _size: pageSize, _sort: '' },
      })
      if (res.code !== 0) throw new Error(`UC searchFiles failed: ${res.message}`)
      const items = res.data?.list
      if (!Array.isArray(items)) throw new Error('UC 搜索列表响应无效')
      allFiles.push(...items.map((f) => mapUcFile(f, account.id)))
      if (items.length < pageSize) { complete = true; break }
      if (requestDelayMs > 0) await sleep(requestDelayMs)
    }
    if (!complete) throw new Error('UC 搜索达到分页上限，结果不完整')
    return allFiles
  }

  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest<UcMkdirData>(`${UC_API}/file`, cookies, {
      method: 'POST',
      body: { pdir_fid: parentId, file_name: name, dir_path: '', dir_init_lock: false, file_type: 0 },
    })
    if (res.code !== 0) throw new Error(`UC mkdir failed: ${res.message}`)
    if (typeof res.data?.fid !== 'string' || !res.data.fid) throw new Error('UC 新建文件夹响应缺少 ID')
    return {
      id: res.data.fid, path: res.data.fid, parentId: res.data.pdir_fid, name: res.data.file_name,
      isDir: true, size: 0, createdAt: res.data.created_at, updatedAt: res.data.updated_at,
      platform: 'uc', accountId: account.id,
    }
  }

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest(`${UC_API}/file/rename`, cookies, { method: 'POST', body: { fid: fileId, file_name: newName } })
    if (res.code !== 0) throw new Error(`UC rename failed: ${res.message}`)
  }

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest(`${UC_API}/file/move`, cookies, { method: 'POST', body: { action_type: 1, exclude_fids: [], filelist: fileIds, to_pdir_fid: targetDirId } })
    if (res.code !== 0) throw new Error(`UC move failed: ${res.message}`)
  }

  async cancelShare(account: DriveAccount, shareId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest<{ task_id?: string }>(`${UC_API}/share/delete`, cookies, {
      method: 'POST',
      body: { share_ids: [shareId] },
    })
    if (res.code !== 0) throw new Error(getUcErrorMessage(res.code, '取消分享'))
  }

  async copy(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest<{ task_id?: string }>(`${UC_API}/file/copy`, cookies, {
      method: 'POST',
      body: {
        action_type: 1,
        filelist: fileIds.map((fid) => ({ fid, share_f_id: '' })),
        to_pdir_fid: targetDirId === '0' ? '0' : targetDirId,
      },
    })
    if (res.code !== 0) throw new Error(getUcErrorMessage(res.code, '复制'))
    const taskId = res.data?.task_id
    if (!taskId) return
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(1000)
      const taskRes = await ucRequest<{ status: number }>(
        `${UC_API}/task?task_id=${taskId}&retry_index=${retryIndex}`, cookies,
      )
      if (taskRes.code !== 0) throw new Error(getUcErrorMessage(taskRes.code, '复制'))
      if (taskRes.data?.status === 2) return
    }
    throw new Error('复制超时')
  }

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest(`${UC_API}/file/delete`, cookies, { method: 'POST', body: { action_type: 2, exclude_fids: [], filelist: fileIds } })
    if (res.code !== 0) throw new Error(`UC delete failed: ${res.message}`)
  }

  // ── Share ──

  private mapExpireDays(days?: number): number {
    if (!days || days <= 0) return 1
    if (days <= 1) return 2
    if (days <= 7) return 3
    return 4
  }

  private generateRandomCode(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length))
    return result
  }

  async createShare(account: DriveAccount, items: ShareTaskPayload['items'], options?: ShareOptions): Promise<ShareInfo> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileIds = items.map((i) => i.fileId)
    const title = options?.title || (items.length === 1 ? (items[0].name || '分享文件') : `分享 ${items.length} 个文件`)

    const urlType = options?.password ? 2 : 1
    const body: Record<string, unknown> = {
      fid_list: fileIds, title,
      url_type: urlType,
      expired_type: this.mapExpireDays(options?.expireDays),
      public_search: 1,
    }
    if (urlType === 2) {
      body.passcode = options?.password || this.generateRandomCode()
    }

    log.info(`UC share: body=${JSON.stringify(body)}, cookies_len=${cookies.length}`)
    const resData = await ucRequest<{ task_id: string }>(`${UC_API}/share`, cookies, { method: 'POST', body })
    log.info(`UC share response: code=${resData.code}, data=${JSON.stringify(resData.data || {}).substring(0, 200)}`)
    if (resData.code !== 0) throw new Error(getUcErrorMessage(resData.code, '分享'))

    const taskId = resData.data?.task_id
    if (!taskId) throw new Error('分享失败：未返回任务 ID')

    let shareId = ''
    // Poll task；非 0 业务码即为 UC 侧终态失败，直接抛出而不是空转到超时
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(1000)
      const taskRes = await ucRequest<{ status: number; share_id?: string }>(
        `${UC_API}/task?task_id=${taskId}&retry_index=${retryIndex}`, cookies,
      )
      if (taskRes.code !== 0) throw new Error(getUcErrorMessage(taskRes.code, '分享'))
      if (taskRes.data?.status === 2) {
        shareId = taskRes.data.share_id || ''
        break
      }
    }
    if (!shareId) throw new Error('分享超时')

    const pwdRes = await ucRequest<{ share_id: string; share_url: string; share_pwd: string; passcode?: string }>(
      `${UC_API}/share/password`, cookies, { method: 'POST', body: { share_id: shareId } },
    )
    if (pwdRes.code !== 0) throw new Error(`获取分享链接失败: ${pwdRes.message}`)

    const shareUrl = pwdRes.data?.share_url || ''
    const sharePwd = pwdRes.data?.share_pwd || pwdRes.data?.passcode || undefined
    const finalUrl = sharePwd ? `${shareUrl}?pwd=${sharePwd}` : shareUrl

    return {
      id: pwdRes.data?.share_id || shareId, platform: 'uc', accountId: account.id,
      fileIds, title, shareUrl: finalUrl,
      password: sharePwd,
      createdAt: Date.now(),
      expiredAt: options?.expireDays && options.expireDays > 0
        ? Date.now() + options.expireDays * 86_400_000
        : undefined,
      raw: pwdRes.data,
    }
  }

  async parseShareLink(url: string, password?: string): Promise<{ shareId: string; password?: string; raw?: unknown }> {
    const match = url.match(/drive\.uc\.cn\/s\/([a-zA-Z0-9]+)/)
    if (!match) throw new Error('无法解析UC分享链接')
    const pwdMatch = url.match(/pwd=([a-zA-Z0-9]+)/)
    return { shareId: match[1], password: password || (pwdMatch ? pwdMatch[1] : undefined), raw: undefined }
  }

  async getShareDetail(account: DriveAccount, input: TransferLinkInput): Promise<ShareDetail> {
    const directory = await this.listSharedDirectory(account, input)
    return { platform: 'uc', shareId: directory.shareId, title: directory.title, files: directory.entries }
  }

  async listSharedDirectory(account: DriveAccount, input: TransferLinkInput, options: SharedDirectoryOptions = {}): Promise<SharedDirectoryResult> {
    options.signal?.throwIfAborted()
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const parsed = await this.parseShareLink(input.url, input.password)
    const pwd = input.password || parsed.password || ''

    // Get stoken
    const tokenRes = await ucRequest<{ token_info?: { stoken?: string }; data?: { stoken?: string } }>(
      `${UC_API}/share/sharepage/v2/detail`, cookies,
      { method: 'POST', body: { pwd_id: parsed.shareId, passcode: pwd } },
    )
    let stoken = ''
    if (tokenRes.data?.token_info?.stoken) stoken = tokenRes.data.token_info.stoken
    else if (tokenRes.data?.data?.stoken) stoken = tokenRes.data.data.stoken
    // Fix: stoken may contain spaces that need to be replaced with +
    stoken = stoken.replace(/ /g, '+')

    const allFiles: SharedDirectoryResult['entries'] = []
    let shareTitle: string | undefined
    let page = 1
    const pageSize = 50
    const pages = new SharedDirectoryPages()

    while (true) {
      options.signal?.throwIfAborted()
      const detailUrl = `${UC_API}/share/sharepage/detail?pwd_id=${encodeURIComponent(parsed.shareId)}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${encodeURIComponent(options.parentId || '0')}&force=0&_page=${page}&_size=${pageSize}&_sort=file_type:asc,updated_at:desc`
      const detailRes = await ucRequest<{
        list: Array<{ fid: string; file_name: string; is_dir: number; dir: number; size: number; share_fid_token: string }>
        title?: string
        share_name?: string
      }>(detailUrl, cookies)

      if (detailRes.code !== 0) throw new Error(`获取分享详情失败: ${detailRes.message}`)

      // 提取分享标题
      if (!shareTitle && page === 1) {
        shareTitle = detailRes.data?.title || detailRes.data?.share_name || undefined
      }

      if (!Array.isArray(detailRes.data?.list)) throw new Error('分享目录列表无效，无法确认完整性')
      const list = detailRes.data.list
      options.signal?.throwIfAborted()
      for (const f of list) allFiles.push(sharedEntry(f, 'pan'))
      const metadata = detailRes.metadata as { _total?: number; _size?: number; _count?: number } | undefined
      if (!pages.accept(list.map(f => String(f.fid || '')), pageSize, metadata)) break
      page++
    }

    return { shareId: parsed.shareId, title: shareTitle || '', entries: allFiles, complete: true }
  }

  async saveSharedFiles(account: DriveAccount, input: TransferLinkInput, targetDirId: string, options: SharedSaveOptions = {}): Promise<TransferResult> {
    options.signal?.throwIfAborted()
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const parsed = await this.parseShareLink(input.url, input.password)
    const pwd = input.password || parsed.password || ''

    // Get stoken
    const tokenRes = await ucRequest<{ token_info?: { stoken?: string }; data?: { stoken?: string } }>(
      `${UC_API}/share/sharepage/v2/detail`, cookies,
      { method: 'POST', body: { pwd_id: parsed.shareId, passcode: pwd } },
    )
    let stoken = ''
    if (tokenRes.data?.token_info?.stoken) stoken = tokenRes.data.token_info.stoken
    else if (tokenRes.data?.data?.stoken) stoken = tokenRes.data.data.stoken
    stoken = stoken.replace(/ /g, '+')

    // Get file list（参考 QuarkPanTool get_detail + is_owner 检查）
    const allFids: string[] = []
    const allFidTokens: string[] = []
    let isOwner = 0
    let page = 1
    const pageSize = 50
    const pages = new SharedDirectoryPages()

    while (true) {
      options.signal?.throwIfAborted()
      const detailUrl = `${UC_API}/share/sharepage/detail?pwd_id=${encodeURIComponent(parsed.shareId)}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${encodeURIComponent(options.sourceParentId || '0')}&force=0&_page=${page}&_size=${pageSize}&_sort=file_type:asc,updated_at:desc`
      log.info(`UC saveSharedFiles: fetching detail, page=${page}, url=${detailUrl.substring(0, 150)}...`)
      const detailRes = await ucRequest<{
        list: Array<{ fid: string; share_fid_token: string }>
        is_owner?: number
      }>(detailUrl, cookies)
      log.info(`UC saveSharedFiles detail response: code=${detailRes.code}, list_count=${detailRes.data?.list?.length || 0}, is_owner=${detailRes.data?.is_owner}`)
      if (detailRes.code !== 0) throw new Error(`获取分享文件列表失败: ${detailRes.message}`)

      // 检查 is_owner（参考 QuarkPanTool line 97）
      if (page === 1 && detailRes.data?.is_owner !== undefined) {
        isOwner = detailRes.data.is_owner
      }

      if (!Array.isArray(detailRes.data?.list)) throw new Error('分享目录列表无效，无法确认完整性')
      const list = detailRes.data.list
      for (const f of list) {
        allFids.push(f.fid)
        allFidTokens.push(f.share_fid_token || '')
      }
      const metadata = detailRes.metadata as { _total?: number; _size?: number; _count?: number } | undefined
      if (!pages.accept(list.map(f => String(f.fid || '')), pageSize, metadata)) break
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

    // 如果用户已经是文件所有者，无需转存（参考 QuarkPanTool line 293）
    if (isOwner === 1) {
      return {
        platform: 'uc',
        accountId: account.id,
        sourceUrl: input.url,
        success: true,
        savedCount: 0,
        targetDirId,
        raw: { message: '网盘中已经存在该文件，无需再次转存' },
      }
    }

    if (allFids.length === 0) throw new Error('转存失败：分享中没有文件')

    // Save to own drive
    options.signal?.throwIfAborted()
    const saveRes = await ucRequest<{ task_id: string }>(`${UC_API}/share/sharepage/save`, cookies, {
      method: 'POST',
      body: {
        fid_list: allFids, fid_token_list: allFidTokens,
        to_pdir_fid: targetDirId === '0' ? '' : targetDirId,
        pwd_id: parsed.shareId, stoken, pdir_fid: options.sourceParentId || '0', scene: 'link',
      },
    })
    if (saveRes.code !== 0) throw new Error(getUcErrorMessage(saveRes.code, '转存'))

    const taskId = saveRes.data?.task_id
    if (!taskId) throw new Error('转存失败：未返回任务 ID')

    // Poll task；非 0 业务码即为 UC 侧终态失败，直接抛出而不是空转到超时
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(randomInt(500, 1000))
      const taskRes = await ucRequest<{ status: number; save_as?: { save_as_top_fids?: string[] } }>(
        `${UC_API}/task?task_id=${taskId}&retry_index=${retryIndex}`, cookies,
      )
      if (taskRes.code !== 0) throw new Error(getUcErrorMessage(taskRes.code, '转存'))
      if (taskRes.data?.status === 2) {
        // Missing destination IDs must not fall back to IDs from the sharer.
        const destinationIds = taskRes.data.save_as?.save_as_top_fids
        const savedFileIds = Array.isArray(destinationIds)
          ? destinationIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
          : undefined
        return {
          platform: 'uc', accountId: account.id, sourceUrl: input.url,
          success: true, savedCount: allFids.length, targetDirId,
          savedFileIds,
        }
      }
    }
    throw new Error('转存超时')
  }

  // ── Download（与 Quark 一致，alist quark_uc getDownloadLink） ──

  async getDownloadSource(account: DriveAccount, fileId: string): Promise<DriveDownloadSource> {
    return {
      url: await this.getDownloadUrl!(account, fileId),
      headers: { Cookie: account.credential.cookies || '', Referer: 'https://drive.uc.cn/', 'User-Agent': UC_UA },
      fetch: (url, init) => session.fromPartition(UC_SESSION).fetch(url, init),
    }
  }

  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const res = await ucRequest<any>(`${UC_API}/file/download`, cookies, {
      method: 'POST',
      body: { fids: [fileId] },
    })

    if (res.code !== 0 || !res.data?.[0]?.download_url) {
      throw new Error(`获取下载链接失败: ${res.message}`)
    }

    return res.data[0].download_url
  }

  async download(account: DriveAccount, fileId: string, localDirPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    options?.signal?.throwIfAborted()

    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileName = options?.fileName || 'download'
    const localPath = resolvePathInside(localDirPath, sanitizeFileName(fileName))

    const downloadUrl = await this.getDownloadUrl(account, fileId)

    const ses = session.fromPartition(UC_SESSION)
    const response = await ses.fetch(downloadUrl, {
      signal: options?.signal,
      headers: {
        'User-Agent': UC_UA,
        'Cookie': cookies,
        'Referer': 'https://drive.uc.cn/',
      },
    })

    if (!response.ok) {
      throw new Error(`下载失败: ${response.statusText}`)
    }

    const loaded = await writeDownloadResponse(response, localPath, options)
    return { success: true, localPath, fileName, fileSize: loaded }
  }

  // ── Upload（完全参照 alist quark_uc upPre/upHash/upPart/upCommit/upFinish） ──

  async upload(account: DriveAccount, localFilePath: string, targetDirId: string, options?: UploadOptions): Promise<UploadResult> {
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
    const preRes = await ucRequest<any>(`${UC_API}/file/upload/pre`, cookies, {
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
    })

    if (preRes.code !== 0) throw new Error(`预上传失败: ${preRes.message}`)
    options?.signal?.throwIfAborted()

    const preData = preRes.data
    const taskId = preData?.task_id
    const uploadId = preData?.upload_id
    const bucket = preData?.bucket
    const objKey = preData?.obj_key
    const uploadUrl = preData?.upload_url
    const authInfo = preData?.auth_info
    const callback = preData?.callback
    const partSize = (preRes.metadata?.part_size as number) || 4 * 1024 * 1024

    if (preData?.finish === true) {
      return completedUpload(preData.fid)
    }
    if (!taskId) throw new Error('预上传响应缺少 task_id')

    // 2. Hash 检查（alist upHash）
    const hashRes = await ucRequest<any>(`${UC_API}/file/update/hash`, cookies, {
      method: 'POST',
      body: { md5: md5Hash, sha1: sha1Hash, task_id: taskId },
    })
    options?.signal?.throwIfAborted()
    if (hashRes.code !== 0) throw new Error(`上传哈希检查失败: ${hashRes.message}`)
    if (hashRes.data?.finish === true) {
      return completedUpload(hashRes.data?.fid || preData.fid)
    }

    // 3. 分片上传（alist upPart）
    const totalParts = Math.ceil(fileSize / partSize)
    if (!Number.isSafeInteger(partSize) || partSize <= 0 || partSize > 256 * 1024 * 1024 || totalParts > 10000) throw new Error('上传分片大小或数量超出当前支持范围')
    if ([uploadUrl, bucket, objKey, uploadId, authInfo].some(value => typeof value !== 'string' || !value)) throw new Error('预上传响应缺少有效上传参数')
    let uploadedBytes = 0
    const etags: string[] = []

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

      const timeStr = new Date().toUTCString()
      const mimeType = 'application/octet-stream'
      const authMeta = [
        'PUT', '', mimeType, timeStr,
        `x-oss-date:${timeStr}`,
        'x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
        `/${bucket}/${objKey}?partNumber=${partNumber}&uploadId=${uploadId}`,
      ].join('\n')

      const partAuthRes = await ucRequest<any>(`${UC_API}/file/upload/auth`, cookies, {
        method: 'POST',
        body: { auth_info: authInfo, auth_meta: authMeta, task_id: taskId },
      })
      if (partAuthRes.code !== 0) throw new Error(`获取分片授权失败: ${partAuthRes.message}`)

      const authKey = partAuthRes.data?.auth_key
      options?.signal?.throwIfAborted()
      if (typeof authKey !== 'string' || !authKey) throw new Error('分片授权响应缺少有效 auth_key')
      const ossUrl = `${ossBaseUrl}?partNumber=${partNumber}&uploadId=${uploadId}`

      const ses = session.fromPartition(UC_SESSION)
      const ossRes = await ses.fetch(ossUrl, {
        signal: options?.signal,
        method: 'PUT',
        headers: {
          'Authorization': authKey,
          'Content-Type': mimeType,
          'Referer': 'https://drive.uc.cn/',
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
        loaded: uploadedBytes, total: fileSize,
        percent: fileSize > 0 ? Math.min(99, Math.round((uploadedBytes / fileSize) * 100)) : 0, speed: 0,
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
      'POST', contentMd5, 'application/xml', commitTimeStr,
      `x-oss-callback:${callbackBase64}`,
      `x-oss-date:${commitTimeStr}`,
      'x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit',
      `/${bucket}/${objKey}?uploadId=${uploadId}`,
    ].join('\n')

    const commitAuthRes = await ucRequest<any>(`${UC_API}/file/upload/auth`, cookies, {
      method: 'POST',
      body: { auth_info: authInfo, auth_meta: commitAuthMeta, task_id: taskId },
    })
    if (commitAuthRes.code !== 0) throw new Error(`获取提交授权失败: ${commitAuthRes.message}`)

    const commitUrl = `${ossBaseUrl}?uploadId=${uploadId}`
    options?.signal?.throwIfAborted()
    const ses2 = session.fromPartition(UC_SESSION)
    const commitRes = await ses2.fetch(commitUrl, {
      signal: options?.signal,
      method: 'POST',
      headers: {
        'Authorization': commitAuthRes.data?.auth_key,
        'Content-MD5': contentMd5,
        'Content-Type': 'application/xml',
        'Referer': 'https://drive.uc.cn/',
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

    const finishRes = await ucRequest<any>(`${UC_API}/file/upload/finish`, cookies, {
      method: 'POST',
      body: { obj_key: objKey, task_id: taskId },
    })
    if (finishRes.code !== 0) throw new Error(`完成上传失败: ${finishRes.message}`)

    return completedUpload(finishRes.data?.fid || preData.fid)
  }

  async getQuota(account: DriveAccount): Promise<{ used: number; total: number }> {
    const cookies = account.credential.cookies || ''
    if (!cookies) throw new Error('未登录')

    const data = await ucRequest<any>(`${UC_API}/member`, cookies)
    const quota = data.data || data
    const used = Number(quota.use_capacity ?? quota.secret_use_capacity ?? quota.used_capacity ?? quota.used ?? 0)
    const total = Number(quota.total_capacity ?? quota.secret_total_capacity ?? quota.capacity ?? quota.total ?? 0)
    if (!Number.isFinite(total) || total <= 0) throw new Error('UC网盘容量数据不可用')
    return { used: Number.isFinite(used) ? used : 0, total }
  }

  async getMembership(account: DriveAccount) {
    const cookies = account.credential.cookies || ''
    if (!cookies) throw new Error('未登录')
    const data = await ucRequest<any>(`${UC_API}/member`, cookies)
    return normalizeMembership(data, 'UC')
  }
}

export const ucAdapter = new UcAdapter()

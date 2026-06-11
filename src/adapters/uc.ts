import { session, net } from 'electron'
import type { DriveAdapter } from './base'
import type { DriveAccount, FileItem, FileListResult, ShareInfo, ShareOptions, ShareDetail, ShareTaskPayload, TransferLinkInput, TransferResult, UploadOptions, UploadResult, DownloadOptions, DownloadResult } from '../shared/types'
import { sleep, randomInt } from '../shared/utils'
import log from 'electron-log'

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
  log.info(`UC ${method} ${finalUrl}`)

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

  log.info(`UC ${method} ${finalUrl} -> status=${response.status}, body=${text.substring(0, 300)}`)

  try {
    return JSON.parse(text) as UcApiResponse<T>
  } catch {
    throw new Error(`Failed to parse UC API response (status=${response.status}): ${text.substring(0, 200)}`)
  }
}

function mapUcFile(f: UcFileItem, accountId: string): FileItem {
  return {
    id: f.fid,
    path: f.fid,
    parentId: f.pdir_fid,
    name: f.file_name,
    isDir: f.file_type === 0,
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
    const pageSize = 200
    const maxPages = 100
    const allFiles: FileItem[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `${UC_API}/file/sort?pdir_fid=${parentId}&_page=${page}&_size=${pageSize}&_sort=file_type:asc,updated_at:desc&_fetch_total=1&_fetch_sub_dirs=1`
      const res = await ucRequest<UcFileListData>(url, cookies)
      if (res.code !== 0) throw new Error(`UC listFiles failed: ${res.message}`)
      const items = res.data?.list
      if (!Array.isArray(items)) break
      allFiles.push(...items.map((f) => mapUcFile(f, account.id)))
      if (items.length < pageSize) break
      await sleep(200)
    }
    return { files: allFiles, parentId, hasMore: false }
  }

  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const pageSize = 50
    const maxPages = 100
    const allFiles: FileItem[] = []

    for (let page = 1; page <= maxPages; page++) {
      const res = await ucRequest<UcSearchData>(`${UC_API}/file/search`, cookies, {
        method: 'POST',
        body: { keyword, _page: page, _size: pageSize, _sort: '' },
      })
      if (res.code !== 0) throw new Error(`UC searchFiles failed: ${res.message}`)
      const items = res.data?.list
      if (!Array.isArray(items)) break
      allFiles.push(...items.map((f) => mapUcFile(f, account.id)))
      if (items.length < pageSize) break
      await sleep(200)
    }
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
    return {
      id: res.data.fid, path: res.data.fid, parentId: res.data.pdir_fid, name: res.data.file_name,
      isDir: true, size: 0, createdAt: res.data.created_at, updatedAt: res.data.updated_at,
      platform: 'uc', accountId: account.id,
    }
  }

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest(`${UC_API}/rename`, cookies, { method: 'POST', body: { fid: fileId, file_name: newName } })
    if (res.code !== 0) throw new Error(`UC rename failed: ${res.message}`)
  }

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')
    const res = await ucRequest(`${UC_API}/move`, cookies, { method: 'POST', body: { file_fids: fileIds, to_pdir_fid: targetDirId } })
    if (res.code !== 0) throw new Error(`UC move failed: ${res.message}`)
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
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(1000)
      const taskRes = await ucRequest<{ status: number; share_id?: string }>(
        `${UC_API}/task?task_id=${taskId}&retry_index=${retryIndex}`, cookies,
      )
      if (taskRes.code !== 0) continue
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
      createdAt: Date.now(), raw: pwdRes.data,
    }
  }

  async parseShareLink(url: string, password?: string): Promise<{ shareId: string; password?: string; raw?: unknown }> {
    const match = url.match(/drive\.uc\.cn\/s\/([a-zA-Z0-9]+)/)
    if (!match) throw new Error('无法解析UC分享链接')
    const pwdMatch = url.match(/pwd=([a-zA-Z0-9]+)/)
    return { shareId: match[1], password: password || (pwdMatch ? pwdMatch[1] : undefined), raw: undefined }
  }

  async getShareDetail(account: DriveAccount, input: TransferLinkInput): Promise<ShareDetail> {
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

    const allFiles: ShareDetail['files'] = []
    let shareTitle: string | undefined
    let page = 1
    const pageSize = 50

    while (true) {
      const detailUrl = `${UC_API}/share/sharepage/detail?pwd_id=${encodeURIComponent(parsed.shareId)}&stoken=${encodeURIComponent(stoken)}&pdir_fid=0&force=0&_page=${page}&_size=${pageSize}&_sort=file_type:asc,updated_at:desc`
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

      const list = detailRes.data?.list || []
      for (const f of list) {
        allFiles.push({
          fileId: f.fid, name: f.file_name,
          isDir: f.dir === 1 || f.is_dir === 1, size: f.size, raw: f,
        })
      }
      const metadata = detailRes.metadata as { _total?: number; _size?: number; _count?: number } | undefined
      if (metadata) {
        if ((metadata._total || 0) <= (metadata._size || pageSize) || (metadata._count || list.length) < pageSize) break
      } else {
        if (list.length < pageSize) break
      }
      page++
    }

    return { platform: 'uc', shareId: parsed.shareId, title: shareTitle || '', files: allFiles }
  }

  async saveSharedFiles(account: DriveAccount, input: TransferLinkInput, targetDirId: string): Promise<TransferResult> {
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

    while (true) {
      const detailUrl = `${UC_API}/share/sharepage/detail?pwd_id=${encodeURIComponent(parsed.shareId)}&stoken=${encodeURIComponent(stoken)}&pdir_fid=0&force=0&_page=${page}&_size=${pageSize}&_sort=file_type:asc,updated_at:desc`
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

      const list = detailRes.data?.list || []
      for (const f of list) {
        allFids.push(f.fid)
        allFidTokens.push(f.share_fid_token || '')
      }
      const metadata = detailRes.metadata as { _total?: number; _size?: number; _count?: number } | undefined
      if (metadata) {
        if ((metadata._total || 0) <= (metadata._size || pageSize) || (metadata._count || list.length) < pageSize) break
      } else {
        if (list.length < pageSize) break
      }
      page++
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
    const saveRes = await ucRequest<{ task_id: string }>(`${UC_API}/share/sharepage/save`, cookies, {
      method: 'POST',
      body: {
        fid_list: allFids, fid_token_list: allFidTokens,
        to_pdir_fid: targetDirId === '0' ? '' : targetDirId,
        pwd_id: parsed.shareId, stoken, pdir_fid: '0', scene: 'link',
      },
    })
    if (saveRes.code !== 0) throw new Error(getUcErrorMessage(saveRes.code, '转存'))

    const taskId = saveRes.data?.task_id
    if (!taskId) throw new Error('转存失败：未返回任务 ID')

    // Poll task
    for (let retryIndex = 0; retryIndex < 50; retryIndex++) {
      await sleep(randomInt(500, 1000))
      const taskRes = await ucRequest<{ status: number; save_as?: { save_as_top_fids?: string[] } }>(
        `${UC_API}/task?task_id=${taskId}&retry_index=${retryIndex}`, cookies,
      )
      if (taskRes.code !== 0) {
        if (taskRes.code === 32003) throw new Error('转存失败：容量不足')
        continue
      }
      if (taskRes.data?.status === 2) {
        const savedFileIds = taskRes.data.save_as?.save_as_top_fids || allFids
        return {
          platform: 'uc', accountId: account.id, sourceUrl: input.url,
          success: true, savedCount: allFids.length, targetDirId,
          savedFileIds, savedFileNames: [],
        }
      }
    }
    throw new Error('转存超时')
  }

  // ── Download（与 Quark 一致，alist quark_uc getDownloadLink） ──

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
    const fs = require('fs')
    const path = require('path')

    const cookies = account.credential.cookies
    if (!cookies) throw new Error('No cookies available')

    const fileName = options?.fileName || 'download'
    const localPath = path.join(localDirPath, fileName)

    const downloadUrl = await this.getDownloadUrl(account, fileId)

    const ses = session.fromPartition(UC_SESSION)
    const response = await ses.fetch(downloadUrl, {
      headers: {
        'User-Agent': UC_UA,
        'Cookie': cookies,
        'Referer': 'https://drive.uc.cn/',
      },
    })

    if (!response.ok) {
      throw new Error(`下载失败: ${response.statusText}`)
    }

    const writer = fs.createWriteStream(localPath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')

    let loaded = 0
    const startTime = Date.now()
    const contentLength = response.headers.get('Content-Length')
    const totalSize = contentLength ? parseInt(contentLength, 10) : 0

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
          total: totalSize || loaded,
          percent: totalSize ? Math.round((loaded / totalSize) * 100) : 0,
          speed,
        })
      }

      writer.end()
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
      })

      return { success: true, fileName, localPath, fileSize: loaded }
    } catch (err) {
      reader.cancel().catch(() => {})
      writer.destroy()
      try { fs.unlinkSync(localPath) } catch {}
      throw err
    }
  }

  // ── Upload（完全参照 alist quark_uc upPre/upHash/upPart/upCommit/upFinish） ──

  async upload(account: DriveAccount, localFilePath: string, targetDirId: string, options?: UploadOptions): Promise<UploadResult> {
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
    const preRes = await ucRequest<any>(`${UC_API}/file/upload/pre`, cookies, {
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
    })

    if (preRes.code !== 0) throw new Error(`预上传失败: ${preRes.message}`)

    const preData = preRes.data
    const taskId = preData?.task_id
    const uploadId = preData?.upload_id
    const bucket = preData?.bucket
    const objKey = preData?.obj_key
    const uploadUrl = preData?.upload_url
    const authInfo = preData?.auth_info
    const callback = preData?.callback
    const partSize = (preRes.metadata?.part_size as number) || 4 * 1024 * 1024

    if (preData?.finish) {
      return { success: true, fileId: preData.fid || taskId, fileName, fileSize }
    }
    if (!taskId) throw new Error('预上传响应缺少 task_id')

    // 2. Hash 检查（alist upHash）
    const hashRes = await ucRequest<any>(`${UC_API}/file/update/hash`, cookies, {
      method: 'POST',
      body: { md5: md5Hash, sha1: sha1Hash, task_id: taskId },
    })
    if (hashRes.code === 0 && hashRes.data?.finish) {
      return { success: true, fileId: hashRes.data?.fid || taskId, fileName, fileSize }
    }

    // 3. 分片上传（alist upPart）
    const totalParts = Math.ceil(fileSize / partSize)
    let uploadedBytes = 0
    const etags: string[] = []

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
      const ossUrl = `${ossBaseUrl}?partNumber=${partNumber}&uploadId=${uploadId}`

      const ses = session.fromPartition(UC_SESSION)
      const ossRes = await ses.fetch(ossUrl, {
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
      etags.push(etag)
      uploadedBytes += chunk.length

      options?.onProgress?.({
        loaded: uploadedBytes, total: fileSize,
        percent: Math.round((uploadedBytes / fileSize) * 100), speed: 0,
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
    const ses2 = session.fromPartition(UC_SESSION)
    const commitRes = await ses2.fetch(commitUrl, {
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

    const finishRes = await ucRequest<any>(`${UC_API}/file/upload/finish`, cookies, {
      method: 'POST',
      body: { obj_key: objKey, task_id: taskId },
    })
    if (finishRes.code !== 0) throw new Error(`完成上传失败: ${finishRes.message}`)

    return { success: true, fileId: finishRes.data?.fid || taskId, fileName, fileSize }
  }

  async getQuota(account: DriveAccount): Promise<{ used: number; total: number }> {
    const cookies = account.credential.cookies || ''
    if (!cookies) throw new Error('未登录')

    // 尝试多个端点
    const endpoints = [
      `${UC_API}/quota`,
      `${UC_API}/capacity`,
      `${UC_API}/account/capacity`,
      `${UC_API}/member`,
    ]

    for (const url of endpoints) {
      try {
        const data = await ucRequest<any>(url, cookies)
        log.info(`[Quota] UC ${url}:`, JSON.stringify(data).substring(0, 300))

        const d = data.data || data
        const used = d.used_capacity || d.use_capacity || d.used || 0
        const total = d.total_capacity || d.capacity || d.total || 0
        if (total > 0) return { used, total }
      } catch (err) {
        log.warn(`[Quota] UC ${url} failed:`, String(err))
      }
    }

    throw new Error('UC网盘暂不支持容量查询')
  }
}

export const ucAdapter = new UcAdapter()

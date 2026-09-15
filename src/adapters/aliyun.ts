import { net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import log from 'electron-log'
import type { DriveAdapter, DriveDownloadSource } from './base'
import type { DriveAccount, DownloadOptions, DownloadResult, FileItem, FileListResult, QuotaInfo, UploadOptions, UploadResult } from '../shared/types'
import { getSetting } from '../main/db'
import { decryptCredential } from '../main/crypto'
import { sleep } from '../shared/utils'

// Native OpenAPI contracts: AlistGo/alist drivers/aliyundrive_open/{meta,driver,util}.go.
// Successful responses contain fields at the JSON root, without a `data` envelope.
const API_BASE = 'https://openapi.alipan.com'
export const ALIYUN_AUTHORIZE_URL = 'https://open.aliyundrive.com/onsite/auth'
/**
 * AList 生态公共授权工具。其令牌绑定签发应用；直接调用官方续期接口仍需
 * 对应应用的 Client ID/Secret，本适配器不将凭据转发给公共续期代理。
 */
export const ALIYUN_AUTH_TOOL_URL = 'https://alistgo.com/zh/tool/aliyundrive/request'
const REQUEST_TIMEOUT_MS = 30_000
const UPLOAD_PART_TIMEOUT_MS = 10 * 60_000
const UPLOAD_PART_SIZE = 16 * 1024 * 1024
const LIST_PAGE_SIZE = 100

interface AliyunErrorPayload {
  code?: string | number
  message?: string
}

interface AliyunDriveInfo {
  default_drive_id?: string
  name?: string
  nick_name?: string
  user_name?: string
  avatar?: string
}

interface AliyunTokenPayload extends AliyunErrorPayload {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

let onCredentialRefreshed: ((accountId: string, credential: DriveAccount['credential']) => void) | undefined

/** Register the main-process persistence hook used when tokens rotate. */
export function setAliyunCredentialRefreshHandler(handler: (accountId: string, credential: DriveAccount['credential']) => void): void {
  onCredentialRefreshed = handler
}

function aliyunClientCredentials(): { clientId: string; clientSecret: string } {
  const read = (key: string): string => {
    const row = getSetting(key)
    if (!row) return ''
    if (!row.encrypted) return row.value
    try { return decryptCredential(row.value) } catch { return '' }
  }
  return { clientId: read('aliyunClientId').trim(), clientSecret: read('aliyunClientSecret').trim() }
}

// ── Token 管理 ──

function requestSignal(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readTokenResponse(response: Response, action: string, signal?: AbortSignal): Promise<AliyunTokenPayload & { access_token: string }> {
  const payload: unknown = await response.json().catch(() => null)
  signal?.throwIfAborted()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${action}：令牌接口返回了无效的 JSON 对象（HTTP ${response.status}）`)
  }
  const data = payload as AliyunTokenPayload
  const code = data.code === undefined ? '' : String(data.code)
  if (!response.ok || (code && code !== '0')) {
    throw new Error(`${action}：${typeof data.message === 'string' && data.message ? data.message : code || `HTTP ${response.status}`}`)
  }
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) {
    throw new Error(`${action}：令牌接口未返回有效的 Access Token`)
  }
  if (data.refresh_token !== undefined && typeof data.refresh_token !== 'string') {
    throw new Error(`${action}：令牌接口返回了无效的 Refresh Token`)
  }
  return data as AliyunTokenPayload & { access_token: string }
}

export async function exchangeAliyunCode(code: string): Promise<AliyunTokenPayload> {
  const { clientId, clientSecret } = aliyunClientCredentials()
  if (!clientId || !clientSecret) throw new Error('请先在设置中填写阿里云盘开放平台 Client ID 和 Secret')
  const response = await net.fetch(`${API_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: code.trim(), client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return readTokenResponse(response, '阿里云盘授权失败，请重新通过同一应用授权')
}

/** accessToken 过期时用 refreshToken 静默续期；新 token 回写到账号凭据 */
export async function refreshAliyunToken(account: DriveAccount, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const credential = account.credential
  const refreshToken = credential.refreshToken
  if (!refreshToken) throw new Error('阿里云盘账号缺少 Refresh Token，请重新通过同一应用授权后更新账号')
  const { clientId, clientSecret } = aliyunClientCredentials()
  if (!clientId || !clientSecret) {
    throw new Error('阿里云盘开放授权续期需要签发该令牌的应用 Client ID 和 Secret；公共授权工具的 Refresh Token 不能在缺少对应应用配置时直接续期')
  }
  const response = await net.fetch(`${API_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    signal: requestSignal(signal),
  })
  const data = await readTokenResponse(response, '阿里云盘授权续期失败，请重新通过同一应用授权', signal)
  if (data.refresh_token) credential.refreshToken = data.refresh_token
  credential.accessToken = data.access_token
  if (Number.isFinite(data.expires_in)) credential.expiresAt = Date.now() + Number(data.expires_in) * 1000
  onCredentialRefreshed?.(account.id, credential)
  log.info('AliyunDrive token refreshed')
  return data.access_token
}

async function aliyunRequest<T = Record<string, unknown>>(
  account: DriveAccount,
  pathname: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
  attempt = 0,
): Promise<T> {
  signal?.throwIfAborted()
  const credential = account.credential
  if (!credential.accessToken) {
    await refreshAliyunToken(account, signal)
    attempt = 1
  }
  const token = credential.accessToken
  if (!token) throw new Error('阿里云盘账号缺少 Access Token，请重新授权')
  const response = await net.fetch(`${API_BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: requestSignal(signal),
  })
  const payload: unknown = response.status === 204 ? {} : await response.json().catch(() => null)
  signal?.throwIfAborted()
  const validObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
  const error = (validObject ? payload : {}) as AliyunErrorPayload
  const code = error.code === undefined ? '' : String(error.code)
  if ((response.status === 401 || ['AccessTokenInvalid', 'AccessTokenExpired', 'I400JD', '401'].includes(code)) && attempt === 0) {
    await refreshAliyunToken(account, signal)
    return aliyunRequest<T>(account, pathname, body, signal, attempt + 1)
  }
  if (!response.ok || (code && code !== '0')) {
    throw new Error(`阿里云盘接口错误：${error.message || code || `HTTP ${response.status}`}`)
  }
  if (!validObject) throw new Error('阿里云盘接口返回了无效的 JSON 对象')
  return payload as T
}

async function aliyunDriveId(account: DriveAccount, signal?: AbortSignal): Promise<string> {
  // user_id identifies an account, not a drive. Do not reuse credential.userId here.
  const info = await aliyunRequest<AliyunDriveInfo>(account, '/adrive/v1.0/user/getDriveInfo', undefined, signal)
  const driveId = info.default_drive_id
  if (!driveId) throw new Error('无法获取阿里云盘 drive_id')
  return driveId
}

async function listAliyunFiles(account: DriveAccount, driveId: string, parentId: string, budget?: { remaining: number }): Promise<FileItem[]> {
  const files: FileItem[] = []
  const markers = new Set<string>()
  let marker = ''
  do {
    if (budget && budget.remaining-- <= 0) throw new Error('阿里云盘搜索目录过多，已达到 1000 页上限，无法返回完整结果')
    const page = await aliyunRequest<{ items?: Array<Record<string, unknown>>; next_marker?: string }>(account, '/adrive/v1.0/openFile/list', {
      drive_id: driveId,
      parent_file_id: parentId === '0' ? 'root' : parentId,
      limit: LIST_PAGE_SIZE,
      marker,
      order_by: 'name',
      order_direction: 'ASC',
    })
    if (!Array.isArray(page.items)) throw new Error('阿里云盘文件列表响应缺少 items')
    for (const item of page.items) files.push(toFileItem(account, item, parentId))
    marker = page.next_marker || ''
    if (marker && markers.has(marker)) throw new Error('阿里云盘文件列表返回重复分页标记')
    markers.add(marker)
  } while (marker)
  return files
}

function toFileItem(account: DriveAccount, item: Record<string, unknown>, parentId: string): FileItem {
  return {
    id: String(item.file_id || ''),
    parentId,
    name: String(item.name || ''),
    isDir: item.type === 'folder',
    size: Number(item.size || 0),
    createdAt: Date.parse(String(item.created_at || '')) || 0,
    updatedAt: Date.parse(String(item.updated_at || '')) || 0,
    platform: 'aliyun',
    accountId: account.id,
    raw: item,
  }
}

export const aliyunAdapter: DriveAdapter = {
  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      await aliyunDriveId(account)
      return true
    } catch {
      return false
    }
  },

  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    const info = await aliyunRequest<AliyunDriveInfo>(account, '/adrive/v1.0/user/getDriveInfo')
    return { nickname: info.name || info.nick_name || info.user_name || account.nickname || '阿里云盘', avatar: info.avatar || undefined }
  },

  async getQuota(account: DriveAccount): Promise<QuotaInfo> {
    const info = await aliyunRequest<{ personal_space_info?: { used_size?: number; total_size?: number } }>(account, '/adrive/v1.0/user/getSpaceInfo')
    const used = info.personal_space_info?.used_size
    const total = info.personal_space_info?.total_size
    if (typeof used !== 'number' || typeof total !== 'number' || !Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total < 0) {
      throw new Error('阿里云盘容量响应缺少有效的 personal_space_info')
    }
    return { used, total }
  },

  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const driveId = await aliyunDriveId(account)
    const files = await listAliyunFiles(account, driveId, parentId)
    return { files, parentId, hasMore: false }
  },

  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const needle = keyword.trim().toLocaleLowerCase()
    if (!needle) return []
    const driveId = await aliyunDriveId(account)
    // Use the verified list contract until OpenAPI search is independently validated.
    // Reject an incomplete traversal instead of presenting truncated matches as complete.
    const files: FileItem[] = []
    const pending = ['0']
    const visited = new Set<string>(['0'])
    const budget = { remaining: 1000 }
    for (let index = 0; index < pending.length; index++) {
      const children = await listAliyunFiles(account, driveId, pending[index], budget)
      for (const item of children) {
        if (item.name.toLocaleLowerCase().includes(needle)) files.push(item)
        if (item.isDir && !visited.has(item.id)) {
          visited.add(item.id)
          pending.push(item.id)
        }
      }
    }
    return files
  },

  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const driveId = await aliyunDriveId(account)
    const created = await aliyunRequest<{ file_id?: string }>(account, '/adrive/v1.0/openFile/create', {
      drive_id: driveId,
      parent_file_id: parentId === '0' ? 'root' : parentId,
      name,
      type: 'folder',
      check_name_mode: 'refuse',
    })
    if (!created.file_id) throw new Error('创建目录失败：未返回 file_id')
    const now = Date.now()
    return {
      id: created.file_id,
      parentId,
      name,
      isDir: true,
      size: 0,
      createdAt: now,
      updatedAt: now,
      platform: 'aliyun',
      accountId: account.id,
    }
  },

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    const driveId = await aliyunDriveId(account)
    await aliyunRequest(account, '/adrive/v1.0/openFile/update', { drive_id: driveId, file_id: fileId, name: newName, check_name_mode: 'refuse' })
  },

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const driveId = await aliyunDriveId(account)
    for (const fileId of fileIds) {
      await aliyunRequest(account, '/adrive/v1.0/openFile/move', {
        drive_id: driveId,
        file_id: fileId,
        to_parent_file_id: targetDirId === '0' ? 'root' : targetDirId,
      })
    }
  },

  async copy(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const driveId = await aliyunDriveId(account)
    for (const fileId of fileIds) {
      await aliyunRequest(account, '/adrive/v1.0/openFile/copy', {
        drive_id: driveId,
        file_id: fileId,
        to_parent_file_id: targetDirId === '0' ? 'root' : targetDirId,
        auto_rename: true,
      })
    }
  },

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    const driveId = await aliyunDriveId(account)
    for (const fileId of fileIds) {
      await aliyunRequest(account, '/adrive/v1.0/openFile/delete', { drive_id: driveId, file_id: fileId })
    }
  },

  async getDownloadSource(account: DriveAccount, fileId: string): Promise<DriveDownloadSource> {
    return {
      url: await this.getDownloadUrl!(account, fileId),
      fetch: (url, init) => net.fetch(url, init),
    }
  },

  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const driveId = await aliyunDriveId(account)
    const result = await aliyunRequest<{ url?: string }>(account, '/adrive/v1.0/openFile/getDownloadUrl', {
      drive_id: driveId,
      file_id: fileId,
      expire_sec: 3600,
    })
    const url = result.url
    if (!url) throw new Error('获取下载地址失败')
    return url
  },

  async download(account: DriveAccount, fileId: string, localDirPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    const url = await this.getDownloadUrl!(account, fileId)
    const requestedName = options?.fileName || `aliyun-${fileId}`
    const candidateName = path.basename(requestedName.replace(/\\/g, '/'))
    const fileName = candidateName && candidateName !== '.' && candidateName !== '..' ? candidateName : `aliyun-${fileId}`
    const response = await net.fetch(url, { signal: options?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    if (!response.body) throw new Error('下载失败：服务器未返回内容')
    const targetPath = path.join(localDirPath, fileName)
    const total = Number(response.headers.get('content-length')) || 0
    const { pipeline } = await import('node:stream/promises')
    const { Readable } = await import('node:stream')
    const { createWriteStream } = await import('node:fs')
    let loaded = 0
    const { Transform } = await import('node:stream')
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        loaded += chunk.length
        options?.onProgress?.({ loaded, total, percent: total > 0 ? Math.round((loaded / total) * 100) : 0, speed: 0 })
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream), counter, createWriteStream(targetPath), { signal: options?.signal })
    return { success: true, localPath: targetPath, fileName, fileSize: loaded || total }
  },

  async upload(account: DriveAccount, localFilePath: string, targetDirId: string, options?: UploadOptions): Promise<UploadResult> {
    options?.signal?.throwIfAborted()
    const fileName = options?.fileName || localFilePath.split(/[\\/]/).pop() || 'file'
    const stat = await fs.promises.stat(localFilePath)
    if (!stat.isFile()) throw new Error('上传路径不是普通文件')
    const total = stat.size
    const partCount = Math.ceil(total / UPLOAD_PART_SIZE)
    if (partCount > 10_000) throw new Error('上传文件超过当前 10000 个分片的大小上限')
    const driveId = await aliyunDriveId(account, options?.signal)
    // Ordinary multipart upload needs no hash handshake. A valid rapid-upload
    // implementation must negotiate pre_hash, then SHA1 + token-bound proof_code;
    // sending pre_hash and a full hash together without proof is not that protocol.
    const partInfoList = Array.from({ length: partCount }, (_, index) => ({ part_number: index + 1 }))
    const created = await aliyunRequest<{
      file_id?: string
      upload_id?: string
      part_info_list?: Array<{ part_number: number; upload_url: string }>
      rapid_upload?: boolean
      exist?: boolean
      file_name?: string
      name?: string
    }>(account, '/adrive/v1.0/openFile/create', {
      drive_id: driveId,
      parent_file_id: targetDirId === '0' ? 'root' : targetDirId,
      name: fileName,
      type: 'file',
      check_name_mode: 'auto_rename',
      size: total,
      part_info_list: partInfoList,
    }, options?.signal)

    const fileId = created.file_id
    if (typeof fileId !== 'string' || !fileId) throw new Error('上传失败：未返回 file_id')
    const savedName = created.file_name || created.name || fileName
    if (created.rapid_upload === true) {
      options?.onProgress?.({ loaded: total, total, percent: 100, speed: 0 })
      return { success: true, fileId, fileName: savedName, fileSize: total }
    }
    if (created.exist) throw new Error('上传失败：服务器仅返回同名文件已存在，未确认内容上传完成')

    const uploadId = created.upload_id
    const parts = created.part_info_list || []
    if (typeof uploadId !== 'string' || !uploadId || !Array.isArray(parts) || parts.length !== partCount) {
      throw new Error('上传失败：未返回完整分片信息')
    }
    parts.sort((a, b) => a.part_number - b.part_number)
    if (parts.some((part, index) => part.part_number !== index + 1 || typeof part.upload_url !== 'string' || !part.upload_url)) {
      throw new Error('上传失败：分片编号或上传地址无效')
    }

    const handle = await fs.promises.open(localFilePath, 'r')
    try {
      for (const part of parts) {
        if (options?.signal?.aborted) throw new Error('上传已取消')
        const index = part.part_number - 1
        const start = index * UPLOAD_PART_SIZE
        const length = Math.min(UPLOAD_PART_SIZE, total - start)
        const buffer = Buffer.alloc(length)
        let read = 0
        while (read < length) {
          options?.signal?.throwIfAborted()
          const { bytesRead } = await handle.read(buffer, read, length - read, start + read)
          if (!bytesRead) throw new Error('上传失败：本地文件在上传期间被截断')
          read += bytesRead
        }
        options?.signal?.throwIfAborted()
        // OSS 预签名地址不接受 Authorization 头
        const put = await net.fetch(part.upload_url, {
          method: 'PUT',
          body: buffer,
          headers: { 'Content-Length': String(length) },
          signal: requestSignal(options?.signal, UPLOAD_PART_TIMEOUT_MS),
        })
        options?.signal?.throwIfAborted()
        if (!put.ok) throw new Error(`上传分片 ${part.part_number} 失败：HTTP ${put.status}`)
        options?.onProgress?.({
          loaded: Math.min(total, (index + 1) * UPLOAD_PART_SIZE),
          total,
          percent: total > 0 ? Math.min(99, Math.round((Math.min(total, (index + 1) * UPLOAD_PART_SIZE) / total) * 100)) : 0,
          speed: 0,
        })
      }
    } finally {
      await handle.close()
    }

    options?.signal?.throwIfAborted()
    const completed = await aliyunRequest<{ file_id?: string }>(account, '/adrive/v1.0/openFile/complete', { drive_id: driveId, file_id: fileId, upload_id: uploadId }, options?.signal)
    if (completed.file_id !== fileId) throw new Error('上传完成响应未确认对应 file_id')
    options?.onProgress?.({ loaded: total, total, percent: 100, speed: 0 })
    return { success: true, fileId, fileName: savedName, fileSize: total }
  },
}

export async function waitAliyunRateLimit(): Promise<void> {
  await sleep(200)
}

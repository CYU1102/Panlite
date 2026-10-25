import { net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import log from 'electron-log'
import { setTimeout as delay } from 'node:timers/promises'
import type { DriveAdapter, DriveDownloadSource } from './base'
import type { DriveAccount, DownloadOptions, DownloadResult, FileItem, FileListResult, QuotaInfo, UploadOptions, UploadResult } from '../shared/types'

const API_BASE = 'https://open-api.123pan.com'
const REQUEST_TIMEOUT_MS = 30_000
const UPLOAD_PART_TIMEOUT_MS = 10 * 60_000
const LIST_PAGE_SIZE = 100
const MAX_LIST_PAGES = 200
const UPLOAD_CONFIRM_TIMEOUT_MS = 120_000
const MAX_UPLOAD_POLLS = 60

interface Pan123Envelope<T> {
  code: number
  message: string
  data: T
}

interface Pan123Context {
  accessToken: string
}

let onCredentialRefreshed: ((accountId: string, credential: DriveAccount['credential']) => void) | undefined

export function setPan123CredentialRefreshHandler(handler: (accountId: string, credential: DriveAccount['credential']) => void): void {
  onCredentialRefreshed = handler
}

function requestSignal(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
}

function fileIdNumber(value: unknown, allowRoot = false): number {
  const text = String(value ?? '').trim()
  const id = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(id) || id < (allowRoot ? 0 : 1)) throw new Error('123云盘文件或目录 ID 无效')
  return id
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const text = String(value ?? '')
  if (/^\d+$/.test(text)) return Number(text)
  // The API's timestamps without an offset are China Standard Time.
  const date = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(' ', 'T') + '+08:00' : text
  return Date.parse(date) || 0
}

/** 用 clientID/clientSecret 换取 access_token（有效期约 30 天） */
export async function fetchPan123AccessToken(clientId: string, clientSecret: string, signal?: AbortSignal): Promise<{ accessToken: string; expiresIn: number }> {
  signal?.throwIfAborted()
  const response = await net.fetch(`${API_BASE}/api/v1/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Platform: 'open_platform' },
    body: JSON.stringify({ clientID: clientId.trim(), clientSecret: clientSecret.trim() }),
    signal: requestSignal(signal),
  })
  const data = await response.json().catch(() => null) as Pan123Envelope<{ accessToken?: string; expiredAt?: string }> | null
  signal?.throwIfAborted()
  if (!response.ok || data?.code !== 0 || typeof data.data?.accessToken !== 'string' || !data.data.accessToken) {
    throw new Error(`123云盘授权失败：${data?.message || `HTTP ${response.status}`}`)
  }
  // The renderer/IPC contract stores expiry durations in seconds (the same
  // unit used by the other OAuth adapters).  The API returns an ISO timestamp,
  // so convert the remaining milliseconds before returning it.
  const expiredAt = data.data.expiredAt ? Date.parse(data.data.expiredAt) : Number.NaN
  const expiresIn = Number.isFinite(expiredAt)
    ? Math.max(0, Math.floor((expiredAt - Date.now()) / 1000))
    : 30 * 86_400
  return { accessToken: data.data.accessToken, expiresIn }
}

async function pan123Context(account: DriveAccount, attempt = 0, signal?: AbortSignal): Promise<Pan123Context> {
  const credential = account.credential
  let token = credential.accessToken
  const reAuthorize = async (): Promise<string> => {
    const clientId = credential.clientId
    const clientSecret = credential.clientSecret
    if (!clientId || !clientSecret) throw new Error('123云盘授权已过期，请重新添加账号获取授权')
    const refreshed = await fetchPan123AccessToken(clientId, clientSecret, signal)
    credential.accessToken = refreshed.accessToken
    credential.expiresAt = Date.now() + refreshed.expiresIn * 1000
    onCredentialRefreshed?.(account.id, credential)
    log.info('Pan123 access token refreshed')
    return refreshed.accessToken
  }
  if (!token || attempt > 0) {
    token = await reAuthorize()
  }
  return { accessToken: token }
}

async function pan123Request<T = Record<string, unknown>>(
  account: DriveAccount,
  method: 'GET' | 'POST' | 'PUT',
  pathname: string,
  options: { body?: Record<string, unknown>; query?: Record<string, string | number>; attempt?: number; signal?: AbortSignal } = {},
): Promise<Pan123Envelope<T>> {
  options.signal?.throwIfAborted()
  const hadToken = Boolean(account.credential.accessToken)
  const ctx = await pan123Context(account, options.attempt, options.signal)
  // Initial authorization already consumes this request's one refresh attempt.
  if (!hadToken && (options.attempt ?? 0) === 0) options = { ...options, attempt: 1 }
  options.signal?.throwIfAborted()
  const url = new URL(`${API_BASE}${pathname}`)
  for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, String(value))
  const response = await net.fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      Platform: 'open_platform',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: requestSignal(options.signal),
  })
  const data = await response.json().catch(() => ({ code: -1, message: `HTTP ${response.status}` })) as Pan123Envelope<T>
  options.signal?.throwIfAborted()
  if ((response.status === 401 || data?.code === 401) && (options.attempt ?? 0) === 0) {
    return pan123Request<T>(account, method, pathname, { ...options, attempt: 1 })
  }
  if (!response.ok || !data || data.code !== 0) throw new Error(`123云盘接口错误：${data?.message || `HTTP ${response.status}`}`)
  return data
}

function toFileItem(account: DriveAccount, item: Record<string, unknown>, parentId: string): FileItem {
  return {
    id: String(fileIdNumber(item.fileId ?? item.fileID)),
    parentId: String(item.parentFileId ?? item.parentFileID ?? parentId),
    name: String(item.filename ?? item.fileName ?? item.name ?? ''),
    isDir: Number(item.type ?? 1) === 1,
    size: Number(item.size ?? item.fileSize ?? 0),
    createdAt: timestamp(item.createAt ?? item.createTime),
    updatedAt: timestamp(item.updateAt ?? item.updateTime),
    platform: 'pan123',
    accountId: account.id,
    raw: item,
  }
}

async function listPan123(account: DriveAccount, parentId: string, searchData?: string): Promise<FileListResult> {
  const files: FileItem[] = []
  const seenIds = new Set<string>()
  const seenCursors = new Set<number>([0])
  let lastFileId = 0
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page_ = await pan123Request<{ fileList: Array<Record<string, unknown>>; lastFileId: number }>(
      account, 'GET', '/api/v2/file/list',
      { query: {
        parentFileId: fileIdNumber(parentId, true), limit: LIST_PAGE_SIZE, lastFileId, trashed: 'false',
        ...(searchData ? { searchData, searchMode: 0 } : {}),
      } },
    )
    const list = page_.data?.fileList
    if (!Array.isArray(list) || !Number.isSafeInteger(page_.data?.lastFileId) || page_.data.lastFileId < -1) {
      throw new Error('123云盘列表响应格式异常，无法确认目录内容')
    }
    for (const item of list) {
      if (!item || typeof item !== 'object') throw new Error('123云盘列表文件信息无效')
      if (Number(item.trashed ?? 0) !== 0) continue
      const mapped = toFileItem(account, item, parentId)
      if (!seenIds.has(mapped.id)) { files.push(mapped); seenIds.add(mapped.id) }
    }
    lastFileId = page_.data.lastFileId
    if (lastFileId === -1) return { files, parentId, hasMore: false }
    if (seenCursors.has(lastFileId)) throw new Error('123云盘分页游标重复，已停止读取以避免遗漏或重复文件')
    seenCursors.add(lastFileId)
  }
  throw new Error('123云盘目录或搜索结果超过本次读取上限，请缩小查询范围')
}

interface UploadState { completed?: boolean; async?: boolean; fileID?: number | string }

async function confirmUpload(account: DriveAccount, preuploadID: string, initial: UploadState, signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(UPLOAD_CONFIRM_TIMEOUT_MS)
  const confirmationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  let state = initial
  try {
    for (let poll = 0; poll <= MAX_UPLOAD_POLLS; poll++) {
      confirmationSignal.throwIfAborted()
      if (state.completed === true) return String(fileIdNumber(state.fileID))
      if (poll === MAX_UPLOAD_POLLS) break
      if (poll === 0 && state.async !== true) throw new Error('123云盘未确认上传完成，请核对远端结果')
      await delay(2000, undefined, { signal: confirmationSignal })
      state = (await pan123Request<UploadState>(account, 'POST', '/upload/v1/file/upload_async_result', {
        body: { preuploadID }, signal: confirmationSignal,
      })).data
      if (!state || typeof state !== 'object') throw new Error('123云盘上传状态响应无效')
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (!deadline.aborted) throw error
  }
  throw new Error('123云盘上传确认超时，服务端可能仍在处理，请核对远端结果')
}

export const pan123Adapter: DriveAdapter = {
  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      await pan123Request(account, 'GET', '/api/v1/user/info')
      return true
    } catch {
      return false
    }
  },

  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    const info = await pan123Request<{ nickname?: string; headImage?: string }>(account, 'GET', '/api/v1/user/info')
    return { nickname: info.data?.nickname || account.nickname || '123云盘', avatar: info.data?.headImage || undefined }
  },

  async getQuota(account: DriveAccount): Promise<QuotaInfo> {
    const info = await pan123Request<{ spaceUsed?: number; spacePermanent?: number; spaceTemp?: number }>(account, 'GET', '/api/v1/user/info')
    const used = Number(info.data?.spaceUsed ?? 0)
    const total = Number(info.data?.spacePermanent ?? 0) + Number(info.data?.spaceTemp ?? 0)
    return { used, total }
  },

  listFiles: (account, parentId) => listPan123(account, parentId),

  searchFiles: (account, keyword) => {
    const needle = keyword.trim()
    if (!needle) return Promise.resolve([])
    return listPan123(account, '0', needle).then(result => result.files)
  },

  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const created = await pan123Request<{ dirID?: number }>(account, 'POST', '/upload/v1/file/mkdir', {
      body: { parentID: fileIdNumber(parentId, true), name },
    })
    const now = Date.now()
    return {
      id: String(fileIdNumber(created.data?.dirID)),
      parentId,
      name,
      isDir: true,
      size: 0,
      createdAt: now,
      updatedAt: now,
      platform: 'pan123',
      accountId: account.id,
    }
  },

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    await pan123Request(account, 'PUT', '/api/v1/file/name', {
      body: { fileId: fileIdNumber(fileId), fileName: newName },
    })
  },

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    await pan123Request(account, 'POST', '/api/v1/file/move', {
      body: {
        fileIDs: fileIds.map(id => fileIdNumber(id)),
        toParentFileID: fileIdNumber(targetDirId, true),
      },
    })
  },

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    await pan123Request(account, 'POST', '/api/v1/file/trash', {
      body: { fileIDs: fileIds.map(id => fileIdNumber(id)) },
    })
  },

  async getDownloadSource(account: DriveAccount, fileId: string): Promise<DriveDownloadSource> {
    return {
      url: await this.getDownloadUrl!(account, fileId),
      fetch: (url, init) => net.fetch(url, init),
    }
  },

  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const info = await pan123Request<{ downloadUrl?: string }>(account, 'GET', '/api/v1/file/download_info', {
      query: { fileId: fileIdNumber(fileId) },
    })
    const url = info.data?.downloadUrl
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('获取下载地址失败')
    return url
  },

  async download(account: DriveAccount, fileId: string, localDirPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    options?.signal?.throwIfAborted()
    const url = await this.getDownloadUrl!(account, fileId)
    options?.signal?.throwIfAborted()
    const requestedName = options?.fileName || `pan123-${fileId}`
    const candidateName = path.basename(requestedName.replace(/\\/g, '/'))
    const fileName = candidateName && candidateName !== '.' && candidateName !== '..' ? candidateName : `pan123-${fileId}`
    const response = await net.fetch(url, { signal: options?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    if (!response.body) throw new Error('下载失败：服务器未返回内容')
    const { pipeline } = await import('node:stream/promises')
    const { Readable, Transform } = await import('node:stream')
    const { createWriteStream } = await import('node:fs')
    const targetPath = path.join(localDirPath, fileName)
    const total = Number(response.headers.get('content-length')) || 0
    let loaded = 0
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

    const md5 = crypto.createHash('md5')
    const source = fs.createReadStream(localFilePath, { signal: options?.signal })
    for await (const chunk of source) md5.update(chunk)

    const created = await pan123Request<{ fileID?: number; reuse?: boolean; preuploadID?: string; sliceSize?: number }>(
      account, 'POST', '/upload/v1/file/create',
      {
        body: {
          parentFileID: fileIdNumber(targetDirId, true),
          filename: fileName,
          etag: md5.digest('hex'),
          size: total,
          ...(options?.overwrite ? { duplicate: 2 } : {}),
        },
        signal: options?.signal,
      },
    )

    if (created.data?.reuse === true) {
      const fileId = String(fileIdNumber(created.data.fileID))
      options?.onProgress?.({ loaded: total, total, percent: 100, speed: 0 })
      return { success: true, fileId, fileName, fileSize: total }
    }

    const preuploadId = String(created.data?.preuploadID ?? '')
    const sliceSize = Number(created.data?.sliceSize)
    if (!preuploadId) throw new Error('上传失败：未返回 preuploadID')
    if (!Number.isSafeInteger(sliceSize) || sliceSize <= 0) throw new Error('上传失败：分片大小无效')

    const handle = await fs.promises.open(localFilePath, 'r')
    try {
      const partCount = Math.max(1, Math.ceil(total / sliceSize))
      for (let sliceNo = 1; sliceNo <= partCount; sliceNo++) {
        options?.signal?.throwIfAborted()
        const urlRes = await pan123Request<{ presignedURL?: string }>(account, 'POST', '/upload/v1/file/get_upload_url', {
          body: { preuploadID: preuploadId, sliceNo }, signal: options?.signal,
        })
        const putUrl = urlRes.data?.presignedURL
        if (!putUrl) throw new Error(`上传分片 ${sliceNo} 失败：未返回分片地址`)
        const start = (sliceNo - 1) * sliceSize
        const length = Math.min(sliceSize, total - start)
        const buffer = Buffer.alloc(Math.max(0, length))
        let bytesRead = 0
        while (bytesRead < length) {
          options?.signal?.throwIfAborted()
          const chunk = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead)
          if (!chunk.bytesRead) throw new Error('上传失败：本地文件已发生变化，无法完整读取分片')
          bytesRead += chunk.bytesRead
        }
        const put = await net.fetch(putUrl, {
          method: 'PUT',
          body: buffer,
          headers: { 'Content-Length': String(length), 'Content-Type': 'application/octet-stream' },
          signal: requestSignal(options?.signal, UPLOAD_PART_TIMEOUT_MS),
        })
        if (!put.ok) throw new Error(`上传分片 ${sliceNo} 失败：HTTP ${put.status}`)
        options?.onProgress?.({
          loaded: Math.min(total, sliceNo * sliceSize),
          total,
          percent: total > 0 ? Math.min(99, Math.round((Math.min(total, sliceNo * sliceSize) / total) * 100)) : 0,
          speed: 0,
        })
      }
    } finally {
      await handle.close()
    }

    const completed = await pan123Request<UploadState>(account, 'POST', '/upload/v1/file/upload_complete', {
      body: { preuploadID: preuploadId }, signal: options?.signal,
    })
    if (!completed.data || typeof completed.data !== 'object') throw new Error('123云盘上传完成响应无效')
    const finalFileId = await confirmUpload(account, preuploadId, completed.data, options?.signal)
    options?.onProgress?.({ loaded: total, total, percent: 100, speed: 0 })
    return { success: true, fileId: finalFileId, fileName, fileSize: total }
  },
}

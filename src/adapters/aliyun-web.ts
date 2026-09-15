import { net } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import log from 'electron-log'
import { secp256k1 } from '@noble/curves/secp256k1'
import type { DriveAdapter, DriveDownloadSource } from './base'
import type { DriveAccount, DownloadOptions, DownloadResult, FileItem, FileListResult, QuotaInfo, TransferLinkInput } from '../shared/types'
import type { SharedDirectoryOptions, SharedDirectoryResult, SharedSaveOptions } from '../shared/subscription-types'
import { SharedDirectoryPages, sharedEntry } from './shared-directory'

const API_BASE = 'https://api.alipan.com'
const AUTH_BASE = 'https://auth.alipan.com'
/** 阿里云盘 web 端固定的 secp 签名 AppID（与 AList 逆向驱动一致） */
const SECP_APP_ID = '5dde4e1bdf9e4966b387ba58f4b3fdc3'
const REQUEST_TIMEOUT_MS = 30_000
const LIST_PAGE_SIZE = 100

interface AliyunWebSession {
  accessToken: string
  refreshToken: string
  /** token 返回或本地创建并持久化的设备 ID，签名串与请求头共用 */
  deviceId: string
  userId: string
  driveId?: string
  expiresAt?: number
  signature: string
  privateKey?: crypto.KeyObject
}

// ── secp256k1 签名（SHA256, lower-S, r||s||recovery-id hex） ──

export function createSessionKeys(): { privateKey: crypto.KeyObject; publicKeyHex: string } {
  // Electron's BoringSSL does not implement secp256k1 EC KeyObjects/JWK.
  // Keep the scalar in a secret KeyObject and perform curve operations in Noble.
  const secret = secp256k1.utils.randomPrivateKey()
  try {
    return {
      privateKey: crypto.createSecretKey(secret),
      publicKeyHex: Buffer.from(secp256k1.getPublicKey(secret, true)).toString('hex'),
    }
  } finally {
    secret.fill(0)
  }
}

function createUncompressedPublicKeyHex(privateKey: crypto.KeyObject): string {
  const secret = privateKey.export()
  try {
    return Buffer.from(secp256k1.getPublicKey(secret, false)).toString('hex')
  } finally {
    secret.fill(0)
  }
}

/**
 * OpenList signs SHA256(appId:deviceId:userId:nonce) using ecc.RecID|ecc.LowerS.
 * dustinxie/ecc serializes r[32] || s[32] || recid[1], flipping recid when s
 * is normalized. Noble performs both operations together; recid is not fixed.
 * Sources: OpenList drivers/aliyundrive/util.go and dustinxie/ecc/ecdsa.go.
 */
export function ecdsaSignSha256(privateKey: crypto.KeyObject, data: string): string {
  if (privateKey.type !== 'secret') throw new Error('签名需要 secp256k1 私钥标量')
  const secret = privateKey.export()
  try {
    const hash = crypto.createHash('sha256').update(data).digest()
    const signature = secp256k1.sign(hash, secret, { lowS: true, prehash: false })
    return signature.toCompactHex() + signature.recovery.toString(16).padStart(2, '0')
  } finally {
    secret.fill(0)
  }
}

// ── 会话与请求层 ──

interface AliyunWebContext {
  session: AliyunWebSession
  account: DriveAccount
  state: CachedWebSession
}

interface CachedWebSession {
  session: AliyunWebSession
  credentialKeys: Set<string>
  revision: number
  updating?: Promise<void>
}

// Keep device keys in memory across adapter calls, including fresh DB account
// objects. Credentials changed by the user start a new device session.
const sessionCache = new Map<string, CachedWebSession>()

function credentialKey(credential: DriveAccount['credential']): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    credential.refreshToken, credential.accessToken, credential.userId, credential.expiresAt,
  ])).digest('hex')
}

function rememberCredential(state: CachedWebSession, credential: DriveAccount['credential']): void {
  state.credentialKeys.add(credentialKey(credential))
  if (state.credentialKeys.size > 8) state.credentialKeys.delete(state.credentialKeys.values().next().value!)
}

async function updateSession(ctx: AliyunWebContext, update: () => Promise<void>): Promise<void> {
  while (ctx.state.updating) await ctx.state.updating
  const pending = update()
  ctx.state.updating = pending
  try {
    await pending
  } finally {
    if (ctx.state.updating === pending) ctx.state.updating = undefined
  }
}

async function responseObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await response.json().catch(() => undefined)
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isFailureCode(code: unknown): boolean {
  return code !== undefined && code !== '' && code !== 'Success' && code !== 0 && code !== '0'
}

function isAccessTokenInvalid(status: number, code: unknown): boolean {
  return status === 401 || code === 'AccessTokenInvalid' || code === 'AccessTokenExpired'
}

function textField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

let onCredentialRefreshed: ((accountId: string, credential: DriveAccount['credential']) => void) | undefined

/** Register the main-process persistence hook used when web tokens rotate. */
export function setAliyunWebCredentialRefreshHandler(handler: (accountId: string, credential: DriveAccount['credential']) => void): void {
  onCredentialRefreshed = handler
}

function decodeWebIdentity(value: string | undefined): { driveId?: string; deviceId: string; userId: string } {
  const parts = String(value || '').split('|')
  if (parts.length >= 3) {
    return { driveId: parts[0] || undefined, deviceId: parts[1] || '', userId: parts.slice(2).join('|') }
  }
  // Older accounts only stored a drive id in credential.userId.
  return { driveId: value || undefined, deviceId: '', userId: '' }
}

function encodeWebIdentity(session: AliyunWebSession): string {
  return [session.driveId || '', session.deviceId || '', session.userId || ''].join('|')
}

function persistSession(account: DriveAccount, session: AliyunWebSession): void {
  const state = sessionCache.get(account.id)
  // An old in-flight request must not overwrite a newly authorized account.
  if (state && state.session !== session) return
  // 把最新 token 回写凭据，避免重启后用旧 refresh_token
  account.credential.refreshToken = session.refreshToken
  account.credential.accessToken = session.accessToken
  account.credential.expiresAt = session.expiresAt
  if (session.deviceId || session.userId || session.driveId) account.credential.userId = encodeWebIdentity(session)
  if (state) rememberCredential(state, account.credential)
  onCredentialRefreshed?.(account.id, account.credential)
}

async function refreshWebToken(session: AliyunWebSession): Promise<void> {
  const response = await net.fetch(`${AUTH_BASE}/v2/account/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await responseObject(response) || {}
  const data = (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw) as Record<string, unknown>
  const accessToken = textField(data, 'access_token', 'accessToken')
  if (!response.ok || isFailureCode(data.code ?? raw.code) || !accessToken) {
    throw new Error(`阿里云盘·网页版授权已失效，请重新粘贴 Refresh Token：${String(data.message || raw.message || `HTTP ${response.status}`)}`)
  }
  session.accessToken = accessToken
  const refreshToken = textField(data, 'refresh_token', 'refreshToken')
  if (refreshToken) session.refreshToken = refreshToken
  const userId = textField(data, 'user_id', 'userId')
  if (userId && session.userId && session.userId !== userId) {
    session.driveId = undefined
    session.deviceId = ''
    session.privateKey = undefined
  }
  if (userId) session.userId = userId
  const deviceId = textField(data, 'device_id', 'deviceId')
  if (deviceId) session.deviceId = deviceId
  const driveId = textField(data, 'default_drive_id', 'defaultDriveId', 'drive_id', 'driveId')
  if (driveId) session.driveId = driveId
  const expiresIn = Number(data.expires_in)
  // Do not retain an already-expired timestamp when a valid refresh omits TTL.
  session.expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined
  // A token refresh invalidates the old device signature.  It is recreated
  // after the new session metadata has been persisted.
  session.signature = ''
  log.info('AliyunDrive web token refreshed')
}

async function createSignatureSession(ctx: AliyunWebContext, attempt = 0): Promise<void> {
  await ensureWebIdentity(ctx)
  const privateKey = ctx.session.privateKey ??= createSessionKeys().privateKey
  const publicKeyHex = createUncompressedPublicKeyHex(privateKey)
  const data = `${SECP_APP_ID}:${ctx.session.deviceId}:${ctx.session.userId}:0`
  const signature = ecdsaSignSha256(privateKey, data)
  const response = await net.fetch(`${API_BASE}/users/v1/users/device/create_session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.session.accessToken}`,
      Origin: 'https://www.alipan.com',
      Referer: 'https://www.alipan.com/',
      'x-device-id': ctx.session.deviceId,
      'x-signature': signature,
      'X-Canary': 'client=Android,app=adrive,version=v4.1.0',
    },
    body: JSON.stringify({
      deviceName: 'samsung',
      modelName: 'SM-G9810',
      nonce: 0,
      pubKey: publicKeyHex,
      refreshToken: ctx.session.refreshToken,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const result = await responseObject(response)
  if (isAccessTokenInvalid(response.status, result?.code) && attempt === 0) {
    await refreshWebToken(ctx.session)
    persistSession(ctx.account, ctx.session)
    await createSignatureSession(ctx, 1)
    return
  }
  if (!response.ok || !result || isFailureCode(result.code) || result.result === false || result.success === false || (result.result !== true && result.success !== true)) {
    throw new Error(`阿里云盘·网页版签名会话创建失败：${result?.message || result?.code || `HTTP ${response.status}，未返回成功结果`}`)
  }
  // Publish only an accepted signature. Failed registration never becomes a
  // cached, apparently valid device session.
  ctx.session.signature = signature
  ctx.state.revision++
  log.info('AliyunDrive web signature session created')
}

async function ensureWebIdentity(ctx: AliyunWebContext, attempt = 0): Promise<void> {
  let changed = false
  if (!ctx.session.userId) {
    // The token endpoint need not include identity fields. OpenList obtains
    // user_id from this authenticated endpoint before creating a device session.
    const response = await net.fetch(`${API_BASE}/v2/user/get`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${ctx.session.accessToken}`,
        Origin: 'https://www.alipan.com', Referer: 'https://www.alipan.com/',
      },
      body: '{}', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const info = await responseObject(response)
    if (isAccessTokenInvalid(response.status, info?.code) && attempt === 0) {
      await refreshWebToken(ctx.session)
      persistSession(ctx.account, ctx.session)
      await ensureWebIdentity(ctx, 1)
      return
    }
    if (!response.ok || !info || isFailureCode(info.code) || typeof info.user_id !== 'string' || !info.user_id) {
      throw new Error(`阿里云盘·网页版无法获取签名会话的 user_id：${info?.message || info?.code || `HTTP ${response.status}`}`)
    }
    ctx.session.userId = info.user_id
    if (typeof info.default_drive_id === 'string' && info.default_drive_id) ctx.session.driveId = info.default_drive_id
    changed = true
  }
  if (!ctx.session.deviceId) {
    ctx.session.deviceId = crypto.randomBytes(32).toString('hex')
    changed = true
  }
  if (changed) persistSession(ctx.account, ctx.session)
}

async function aliyunWebContext(account: DriveAccount): Promise<AliyunWebContext> {
  const credential = account.credential
  const refreshToken = credential.refreshToken
  if (!refreshToken) throw new Error('阿里云盘·网页版缺少 Refresh Token，请重新添加账号')
  let state = sessionCache.get(account.id)
  if (!state?.credentialKeys.has(credentialKey(credential))) {
    const identity = decodeWebIdentity(credential.userId)
    const session: AliyunWebSession = {
      accessToken: credential.accessToken || '', refreshToken,
      deviceId: identity.deviceId, userId: identity.userId, driveId: identity.driveId,
      expiresAt: credential.expiresAt, signature: '',
    }
    state = { session, credentialKeys: new Set([credentialKey(credential)]), revision: 0 }
    sessionCache.set(account.id, state)
    if (sessionCache.size > 128) sessionCache.delete(sessionCache.keys().next().value!)
  }
  const ctx: AliyunWebContext = { session: state.session, account, state }
  await updateSession(ctx, async () => {
    const session = ctx.session
    if (!session.accessToken || !session.deviceId || !session.userId || (session.expiresAt !== undefined && session.expiresAt <= Date.now() + 60_000)) {
      await refreshWebToken(session)
      persistSession(account, session)
    }
    if (!session.signature) await createSignatureSession(ctx)
  })
  // A concurrent caller may hold an older DB snapshot after token rotation.
  Object.assign(account.credential, {
    accessToken: ctx.session.accessToken, refreshToken: ctx.session.refreshToken,
    expiresAt: ctx.session.expiresAt, userId: encodeWebIdentity(ctx.session),
  })
  rememberCredential(state, account.credential)
  return ctx
}

async function aliyunWebRequest<T = Record<string, unknown>>(
  ctx: AliyunWebContext,
  method: 'GET' | 'POST',
  url: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  attempt = 0,
): Promise<T> {
  if (attempt > 2) throw new Error('阿里云盘·网页版请求重试次数超限')
  const session = ctx.session
  const revision = ctx.state.revision
  const response = await net.fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      origin: 'https://www.alipan.com',
      Referer: 'https://alipan.com/',
      'X-Signature': session.signature,
      'x-request-id': crypto.randomUUID(),
      'X-Canary': 'client=Android,app=adrive,version=v4.1.0',
      'X-Device-Id': session.deviceId,
      ...extraHeaders,
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const data = await responseObject(response)
  const errorCode = data?.code
  const tokenInvalid = isAccessTokenInvalid(response.status, errorCode)
  if (tokenInvalid || errorCode === 'DeviceSessionSignatureInvalid') {
    if (attempt >= 2) throw new Error('阿里云盘·网页版授权或签名会话重试次数超限，请重新授权')
    await updateSession(ctx, async () => {
      // Concurrent failures from the previous session share one repair.
      if (ctx.state.revision !== revision) return
      ctx.session.signature = ''
      if (tokenInvalid) {
        await refreshWebToken(ctx.session)
        persistSession(ctx.account, ctx.session)
      }
      await createSignatureSession(ctx)
    })
    return aliyunWebRequest<T>(ctx, method, url, body, extraHeaders, attempt + 1)
  }
  if (isFailureCode(errorCode)) throw new Error(`阿里云盘·网页版接口错误：${data?.message || errorCode}`)
  if (!response.ok) throw new Error(`阿里云盘·网页版接口错误：HTTP ${response.status}`)
  if (!data) throw new Error('阿里云盘·网页版接口返回无效 JSON')
  return data as T
}

// ── 适配器 ──

async function aliyunWebDriveId(ctx: AliyunWebContext): Promise<string> {
  if (ctx.session.driveId) return ctx.session.driveId
  const info = await aliyunWebRequest<{ default_drive_id?: string; id?: string; personal?: { drive_id?: string } }>(ctx, 'POST', `${API_BASE}/v2/user/get`)
  const driveId = info.default_drive_id || info.personal?.drive_id || info.id || ''
  if (!driveId) throw new Error('无法获取阿里云盘·网页版 drive_id')
  ctx.session.driveId = driveId
  persistSession(ctx.account, ctx.session)
  return driveId
}

function toFileItem(account: DriveAccount, item: Record<string, unknown>, parentId: string): FileItem {
  return {
    id: String(item.file_id || ''),
    parentId: String(item.parent_file_id || parentId),
    name: String(item.name || ''),
    isDir: item.type === 'folder',
    size: Number(item.size || 0),
    createdAt: Date.parse(String(item.created_at || '')) || 0,
    updatedAt: Date.parse(String(item.updated_at || '')) || 0,
    platform: 'aliyun_web',
    accountId: account.id,
    raw: item,
  }
}

function checkedWebPage(page: { items?: Array<Record<string, unknown>>; next_marker?: string }, seen: Set<string>): string {
  if (!Array.isArray(page.items) || page.items.some(item => !item || typeof item.file_id !== 'string' || !item.file_id)) {
    throw new Error('阿里云盘网页版文件列表响应无效')
  }
  const marker = page.next_marker || ''
  if (typeof marker !== 'string' || (marker && seen.has(marker))) throw new Error('阿里云盘网页版分页游标无效或重复')
  if (marker) seen.add(marker)
  if (seen.size >= 1000) throw new Error('阿里云盘网页版达到分页上限，结果不完整')
  return marker
}

export const aliyunWebAdapter: DriveAdapter = {
  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      const ctx = await aliyunWebContext(account)
      await aliyunWebRequest(ctx, 'POST', `${API_BASE}/v2/user/get`)
      return true
    } catch {
      return false
    }
  },

  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    const ctx = await aliyunWebContext(account)
    const info = await aliyunWebRequest<{ nick_name?: string; avatar?: string; user_name?: string }>(ctx, 'POST', `${API_BASE}/v2/user/get`)
    return { nickname: info.nick_name || info.user_name || account.nickname || '阿里云盘', avatar: info.avatar || undefined }
  },

  async getQuota(account: DriveAccount): Promise<QuotaInfo> {
    const ctx = await aliyunWebContext(account)
    const info = await aliyunWebRequest<{ personal?: { used_size?: number; total_size?: number } }>(ctx, 'POST', `${API_BASE}/v2/user/get`)
    return { used: Number(info.personal?.used_size || 0), total: Number(info.personal?.total_size || 0) }
  },

  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    const files: FileItem[] = []
    let marker = ''
    const seen = new Set<string>()
    do {
      const page = await aliyunWebRequest<{ items?: Array<Record<string, unknown>>; next_marker?: string }>(ctx, 'POST', `${API_BASE}/v2/file/list`, {
        drive_id: driveId,
        parent_file_id: parentId === '0' ? 'root' : parentId,
        limit: LIST_PAGE_SIZE,
        marker,
        order_by: 'name',
        order_direction: 'ASC',
      })
      marker = checkedWebPage(page, seen)
      for (const item of page.items!) files.push(toFileItem(account, item, parentId))
    } while (marker)
    return { files, parentId, hasMore: false }
  },

  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    const needle = keyword.trim()
    if (!needle) return []
    const files: FileItem[] = []
    let marker = ''
    const seen = new Set<string>()
    do {
      const page = await aliyunWebRequest<{ items?: Array<Record<string, unknown>>; next_marker?: string }>(ctx, 'POST', `${API_BASE}/v2/file/search`, {
        drive_id: driveId,
        query: `name matching "${needle.replace(/"/g, '')}"`,
        limit: LIST_PAGE_SIZE,
        marker,
      })
      marker = checkedWebPage(page, seen)
      for (const item of page.items!) files.push(toFileItem(account, item, String(item.parent_file_id || '0')))
    } while (marker)
    return files
  },

  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    const created = await aliyunWebRequest<{ file_id?: string }>(ctx, 'POST', `${API_BASE}/v3/file/create`, {
      drive_id: driveId,
      parent_file_id: parentId === '0' ? 'root' : parentId,
      name,
      type: 'folder',
      check_name_mode: 'refuse',
    })
    if (typeof created.file_id !== 'string' || !created.file_id) throw new Error('阿里云盘网页版新建文件夹响应缺少 ID')
    const now = Date.now()
    return {
      id: String(created.file_id || ''),
      parentId,
      name,
      isDir: true,
      size: 0,
      createdAt: now,
      updatedAt: now,
      platform: 'aliyun_web',
      accountId: account.id,
    }
  },

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    await aliyunWebRequest(ctx, 'POST', `${API_BASE}/v3/file/update`, {
      drive_id: driveId,
      file_id: fileId,
      name: newName,
      check_name_mode: 'refuse',
    })
  },

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    await aliyunWebBatch(ctx, fileIds.map((fileId) => ({
      url: '/file/move',
      body: { drive_id: driveId, file_id: fileId, to_drive_id: driveId, to_parent_file_id: targetDirId === '0' ? 'root' : targetDirId },
    })))
  },

  async copy(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    await aliyunWebBatch(ctx, fileIds.map((fileId) => ({
      url: '/file/copy',
      body: { drive_id: driveId, file_id: fileId, to_drive_id: driveId, to_parent_file_id: targetDirId === '0' ? 'root' : targetDirId, auto_rename: true },
    })))
  },

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    await aliyunWebBatch(ctx, fileIds.map((fileId) => ({
      url: '/file/delete',
      body: { drive_id: driveId, file_id: fileId },
    })))
  },

  async getDownloadSource(account: DriveAccount, fileId: string): Promise<DriveDownloadSource> {
    return {
      url: await this.getDownloadUrl!(account, fileId),
      fetch: (url, init) => net.fetch(url, init),
    }
  },

  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    const result = await aliyunWebRequest<{ url?: string }>(ctx, 'POST', `${API_BASE}/v2/file/get_download_url`, {
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
    const requestedName = options?.fileName || `aliyun-web-${fileId}`
    const candidateName = path.basename(requestedName.replace(/\\/g, '/'))
    const fileName = candidateName && candidateName !== '.' && candidateName !== '..' ? candidateName : `aliyun-web-${fileId}`
    const response = await net.fetch(url, { signal: options?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    if (!response.body) throw new Error('下载失败：服务器未返回内容')
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
    await pipeline(Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream), counter, fs.createWriteStream(targetPath))
    return { success: true, localPath: targetPath, fileName, fileSize: loaded || total }
  },

  async createShare(account: DriveAccount, items: Array<{ fileId: string; name?: string }>, options?: { expireDays?: number; password?: string; title?: string }): Promise<{ id: string; platform: 'aliyun_web'; accountId: string; fileIds: string[]; title: string; shareUrl: string; password?: string; createdAt: number; expiredAt?: number; raw?: Record<string, unknown> }> {
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    const body: Record<string, unknown> = {
      drive_id: driveId,
      file_id_list: items.map((item) => item.fileId),
      share_name: options?.title || items[0]?.name || 'PanLite 分享',
    }
    if (options?.password) body.share_pwd = options.password
    if (options?.expireDays && options.expireDays > 0) {
      body.expiration = new Date(Date.now() + options.expireDays * 86_400_000).toISOString()
    }
    const created = await aliyunWebRequest<{ share_id?: string; share_url?: string; share_pwd?: string }>(ctx, 'POST', `${API_BASE}/adrive/v2/share_link/create`, body)
    const shareId = String(created.share_id || '')
    const shareUrl = created.share_url || (shareId ? `https://www.alipan.com/s/${shareId}` : '')
    if (!shareId || !shareUrl) throw new Error('创建分享失败')
    return {
      id: shareId,
      platform: 'aliyun_web',
      accountId: account.id,
      fileIds: items.map((item) => item.fileId),
      title: body.share_name as string,
      shareUrl,
      password: created.share_pwd || options?.password,
      createdAt: Date.now(),
      expiredAt: options?.expireDays && options.expireDays > 0
        ? Date.now() + options.expireDays * 86_400_000
        : undefined,
      raw: created,
    }
  },

  async cancelShare(account: DriveAccount, shareId: string): Promise<void> {
    const ctx = await aliyunWebContext(account)
    await aliyunWebBatch(ctx, [{ url: '/share_link/cancel', body: { share_id: shareId } }])
  },

  async parseShareLink(url: string, password?: string): Promise<{ shareId: string; password?: string; raw?: unknown }> {
    const match = url.match(/(?:alipan\.com|aliyundrive\.com)\/s\/([a-zA-Z0-9_-]+)/)
    if (!match) throw new Error('无法解析阿里云盘分享链接')
    const pwdMatch = url.match(/pwd=([a-zA-Z0-9]+)/)
    return { shareId: match[1], password: password || (pwdMatch ? pwdMatch[1] : undefined) }
  },

  async getShareDetail(account: DriveAccount, input: TransferLinkInput): Promise<{ platform: 'aliyun_web'; shareId: string; title?: string; files: Array<{ fileId: string; name: string; isDir: boolean; size?: number; raw?: unknown }>; raw?: unknown }> {
    const directory = await this.listSharedDirectory!(account, input)
    return { platform: 'aliyun_web', shareId: directory.shareId || '', files: directory.entries }
  },

  async listSharedDirectory(account: DriveAccount, input: TransferLinkInput, options: SharedDirectoryOptions = {}): Promise<SharedDirectoryResult> {
    options.signal?.throwIfAborted()
    const ctx = await aliyunWebContext(account)
    const parsed = await this.parseShareLink!(input.url, input.password)
    const token = await aliyunWebRequest<{ share_token?: string }>(ctx, 'POST', `${API_BASE}/v2/share_link/get_share_token`, {
      share_id: parsed.shareId,
      share_pwd: parsed.password || '',
    })
    const shareToken = token.share_token
    if (!shareToken) throw new Error('获取分享令牌失败（提取码错误或分享失效）')
    const files: SharedDirectoryResult['entries'] = []
    let marker = ''
    const seen = new Set<string>()
    const pages = new SharedDirectoryPages()
    do {
      options.signal?.throwIfAborted()
      const page = await aliyunWebRequest<{ items?: Array<Record<string, unknown>>; next_marker?: string }>(ctx, 'POST', `${API_BASE}/adrive/v2/file/list_by_share`, {
        share_id: parsed.shareId,
        share_token: shareToken,
        ...(options.parentId && options.parentId !== '0' ? { parent_file_id: options.parentId } : {}),
        limit: LIST_PAGE_SIZE,
        marker,
        order_by: 'name',
        order_direction: 'ASC',
      }, { 'x-share-token': shareToken })
      marker = checkedWebPage(page, seen)
      options.signal?.throwIfAborted()
      pages.accept(page.items!.map(item => String(item.file_id || '')), LIST_PAGE_SIZE)
      if (marker && !page.items!.length) throw new Error('分享目录分页不完整')
      for (const item of page.items!) files.push(sharedEntry(item, 'aliyun'))
    } while (marker)
    return { shareId: parsed.shareId, entries: files, complete: true }
  },

  async saveSharedFiles(account: DriveAccount, input: TransferLinkInput, targetDirId: string, options: SharedSaveOptions = {}): Promise<{ platform: 'aliyun_web'; accountId: string; sourceUrl: string; success: boolean; savedCount?: number; targetDirId?: string; error?: string; savedFileIds?: string[] }> {
    options.signal?.throwIfAborted()
    const ctx = await aliyunWebContext(account)
    const driveId = await aliyunWebDriveId(ctx)
    const parsed = await this.parseShareLink!(input.url, input.password)
    const token = await aliyunWebRequest<{ share_token?: string }>(ctx, 'POST', `${API_BASE}/v2/share_link/get_share_token`, {
      share_id: parsed.shareId,
      share_pwd: parsed.password || '',
    })
    const shareToken = token.share_token
    if (!shareToken) throw new Error('转存失败：获取分享令牌失败')

    const detail: Array<{ fileId: string; isDir: boolean }> = []
    let marker = ''
    const seen = new Set<string>()
    const pages = new SharedDirectoryPages()
    do {
      options.signal?.throwIfAborted()
      const page = await aliyunWebRequest<{ items?: Array<Record<string, unknown>>; next_marker?: string }>(ctx, 'POST', `${API_BASE}/adrive/v2/file/list_by_share`, {
        share_id: parsed.shareId,
        share_token: shareToken,
        ...(options.sourceParentId && options.sourceParentId !== '0' ? { parent_file_id: options.sourceParentId } : {}),
        limit: LIST_PAGE_SIZE,
        marker,
      }, { 'x-share-token': shareToken })
      marker = checkedWebPage(page, seen)
      pages.accept(page.items!.map(item => String(item.file_id || '')), LIST_PAGE_SIZE)
      if (marker && !page.items!.length) throw new Error('分享目录分页不完整')
      for (const item of page.items!) detail.push({ fileId: String(item.file_id || ''), isDir: item.type === 'folder' })
    } while (marker)
    if (!detail.length) throw new Error('转存失败：分享中没有文件')

    const selected = input.fileIds?.length
      ? detail.filter((item) => input.fileIds!.includes(item.fileId))
      : detail
    if (!selected.length) throw new Error('转存失败：没有可转存的新文件')
    if (input.fileIds?.length && selected.length !== new Set(input.fileIds).size) throw new Error('分享文件在扫描后发生变化，请重新检查')

    options.signal?.throwIfAborted()
    const responses = await aliyunWebBatch(ctx, selected.map((item, index) => ({
      id: String(index),
      url: '/file/copy',
      body: {
        drive_id: driveId,
        file_id: item.fileId,
        share_id: parsed.shareId,
        share_token: shareToken,
        to_drive_id: driveId,
        to_parent_file_id: targetDirId === '0' ? 'root' : targetDirId,
        auto_rename: true,
      },
    })), { 'x-share-token': shareToken }, true)

    const savedFileIds: string[] = []
    let failed = 0
    for (const response of responses) {
      const status = Number(response.status || 0)
      const body = (response.body || {}) as { file_id?: string }
      if (status < 200 || status >= 300 || isFailureCode(response.body?.code) || typeof body.file_id !== 'string' || !body.file_id) failed++
      else savedFileIds.push(body.file_id)
    }
    if (failed >= selected.length) throw new Error('转存失败：全部文件保存失败')
    return {
      platform: 'aliyun_web',
      accountId: account.id,
      sourceUrl: input.url,
      success: savedFileIds.length > 0,
      savedCount: savedFileIds.length,
      targetDirId,
      savedFileIds,
      error: failed > 0 ? `${failed} 个文件保存失败` : undefined,
    }
  },
}

type AliyunWebBatchRequest = { url: string; body?: Record<string, unknown>; id?: string }

/** 阿里云盘 web 的 batch 批量接口（move/delete/copy/分享取消等都走这里） */
async function aliyunWebBatch(
  ctx: AliyunWebContext,
  requests: AliyunWebBatchRequest[],
  extraHeaders: Record<string, string> = {},
  allowPartial = false,
): Promise<Array<{ id?: string; status?: number; body?: Record<string, unknown> }>> {
  if (!requests.length) return []
  const result = await aliyunWebRequest<{ responses?: Array<{ id?: string; status?: number; body?: Record<string, unknown> }> }>(
    ctx, 'POST', `${API_BASE}/adrive/v3/batch`,
    {
      requests: requests.map((request, index) => ({
        id: request.id ?? String(index),
        method: 'POST',
        url: request.url,
        headers: { 'Content-Type': 'application/json' },
        body: request.body ?? {},
      })),
      resource: 'file',
    },
    extraHeaders,
  )
  if (!Array.isArray(result.responses) || result.responses.length !== requests.length) throw new Error('阿里云盘网页版批量操作响应不完整，请核对远端结果')
  const expectedIds = new Set(requests.map((request, index) => request.id ?? String(index)))
  for (const response of result.responses) {
    if (!response || typeof response.id !== 'string' || !expectedIds.delete(response.id) || typeof response.status !== 'number') {
      throw new Error('阿里云盘网页版批量操作响应不完整或无效，请核对远端结果')
    }
    if (!allowPartial && (response.status < 200 || response.status >= 300 || isFailureCode(response.body?.code))) {
      throw new Error(`阿里云盘网页版批量操作失败 (HTTP ${response.status}): ${response.body?.message || response.body?.code || ''}`)
    }
  }
  return result.responses
}

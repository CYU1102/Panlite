import { net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import log from 'electron-log'
import type { DriveAdapter, DriveDownloadSource } from './base'
import type { DriveAccount, DownloadOptions, DownloadResult, FileItem, FileListResult, QuotaInfo, UploadOptions, UploadResult } from '../shared/types'

const REQUEST_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 10 * 60_000
const SEARCH_MAX_ENTRIES = 3000
const SEARCH_TIME_BUDGET_MS = 10_000
const SEARCH_MAX_DEPTH = 6

/** WebDAV 文件 ID 就是服务器上的完整解码路径；根目录用 '0' 与其他平台保持一致 */
export const WEBDAV_ROOT_ID = '0'

// ── 纯函数（导出供测试） ──

export interface DavEntry {
  href: string
  path: string
  name: string
  isDir: boolean
  size: number
  createdAt: number
  updatedAt: number
}

export function normalizeDavBase(serverUrl: string): string {
  const raw = serverUrl.trim()
  if (!raw) throw new Error('WebDAV 服务器地址未配置')
  if (!/^https?:\/\//i.test(raw)) throw new Error('WebDAV 服务器地址必须以 http(s):// 开头')
  try {
    const parsed = new URL(raw)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    // Query/hash components are not part of the DAV collection URL.  Keeping
    // them would place the subsequent path after the query string.
    return `${parsed.origin}${pathname}`
  } catch {
    throw new Error('WebDAV 服务器地址格式无效')
  }
}

export function idToPath(id: string): string {
  if (!id || id === WEBDAV_ROOT_ID) return '/'
  return id.startsWith('/') ? id : `/${id}`
}

export function pathToId(serverPath: string): string {
  const trimmed = serverPath.replace(/\/+$/, '')
  return trimmed === '' || trimmed === '/' ? WEBDAV_ROOT_ID : trimmed
}

export function encodeDavPath(serverPath: string): string {
  return serverPath.split('/').map(segment => (segment ? encodeURIComponent(segment) : '')).join('/')
}

function decodeDavComponent(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  }[entity] || _))
}

function hrefToServerPath(href: string): string {
  const withoutQuery = href.split('?')[0]
  try {
    // WebDAV servers are allowed to return either a path or an absolute URL
    // in <d:href>.  Always use the URL pathname for the latter so path IDs do
    // not accidentally contain the scheme/host.
    if (/^(?:https?:)?\/\//i.test(withoutQuery)) {
      const absolute = /^\/\//.test(withoutQuery) ? `https:${withoutQuery}` : withoutQuery
      return decodeDavComponent(new URL(absolute).pathname)
    }
  } catch { /* fall through to the raw href */ }
  return decodeDavComponent(withoutQuery)
}

export function parentPath(serverPath: string): string {
  const trimmed = serverPath.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

export function baseName(serverPath: string): string {
  const trimmed = serverPath.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

function parseDate(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** 解析 207 Multi-Status 响应；正则按命名空间无关方式匹配，兼容 Nextcloud/Apache/Alist 等前缀差异 */
export function parseMultistatus(xml: string): DavEntry[] {
  const entries: DavEntry[] = []
  const blocks = xml.match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || []
  for (const block of blocks) {
    const href = decodeXmlEntities(block.match(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i)?.[1]?.trim() || '')
    if (!href) continue
    const serverPath = hrefToServerPath(href)
    const isDir = /<(?:[\w-]+:)?collection\b\s*\/?>/i.test(block)
    const size = Number(block.match(/<(?:[\w-]+:)?getcontentlength\b[^>]*>(\d+)</i)?.[1] || 0)
    const updatedAt = parseDate(block.match(/<(?:[\w-]+:)?getlastmodified\b[^>]*>([\s\S]*?)</i)?.[1]?.trim()
      || block.match(/<(?:[\w-]+:)?modificationdate\b[^>]*>([\s\S]*?)</i)?.[1]?.trim())
    const createdAt = parseDate(block.match(/<(?:[\w-]+:)?creationdate\b[^>]*>([\s\S]*?)</i)?.[1]?.trim()) || updatedAt
    entries.push({
      href,
      path: serverPath,
      name: baseName(serverPath),
      isDir,
      size,
      createdAt,
      updatedAt,
    })
  }
  return entries
}

export function parseQuotaFromPropfind(xml: string): { used: number; total: number } {
  const used = Number(xml.match(/<(?:[\w-]+:)?quota-used-bytes\b[^>]*>(-?\d+)</i)?.[1] || 0)
  const available = Number(xml.match(/<(?:[\w-]+:)?quota-available-bytes\b[^>]*>(-?\d+)</i)?.[1] || NaN)
  // RFC 4331：available 可能为负表示超额；无法解析时 total=0 表示未知
  if (!Number.isFinite(available)) return { used: Math.max(0, used), total: 0 }
  return { used: Math.max(0, used), total: Math.max(0, used + available) }
}

// ── 请求层 ──

interface DavContext {
  base: string
  auth: string
}

function davContext(account: DriveAccount): DavContext {
  const credential = account.credential
  const base = normalizeDavBase(credential.serverUrl || credential.raw?.serverUrl as string || '')
  const auth = 'Basic ' + Buffer.from(`${credential.username || ''}:${credential.password || ''}`).toString('base64')
  return { base, auth }
}

const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:creationdate/><d:resourcetype/><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>'

interface DavRequestOptions {
  depth?: number | string
  body?: string
  destinationPath?: string
  signal?: AbortSignal
  contentType?: string
}

async function davRequest(ctx: DavContext, method: string, serverPath: string, options: DavRequestOptions = {}): Promise<Response> {
  const url = `${ctx.base}${encodeDavPath(serverPath)}`
  const headers: Record<string, string> = { Authorization: ctx.auth }
  if (options.depth !== undefined) headers.Depth = String(options.depth)
  if (options.body !== undefined) headers['Content-Type'] = options.contentType || 'application/xml; charset=utf-8'
  if (options.destinationPath) {
    headers.Destination = `${ctx.base}${encodeDavPath(options.destinationPath)}`
    headers.Overwrite = 'F'
  }
  const response = await net.fetch(url, {
    method,
    headers,
    body: options.body,
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  log.info(`WebDAV ${method} ${serverPath} -> ${response.status}`)
  return response
}

function davErrorMessage(status: number, action: string): string {
  if (status === 401) return `${action}失败：用户名或密码错误`
  if (status === 403) return `${action}失败：没有权限`
  if (status === 404) return `${action}失败：路径不存在`
  if (status === 405) return `${action}失败：目标已存在`
  if (status === 409) return `${action}失败：上级目录不存在`
  if (status === 507) return `${action}失败：服务器空间不足`
  return `${action}失败：HTTP ${status}`
}

interface DavXmlNode { name: string; uri: string; text: string; children: DavXmlNode[] }
interface DavSaxParser {
  onopentag?: (tag: { local: string; uri: string }) => void
  onclosetag?: () => void
  ontext?: (text: string) => void
  oncdata?: (text: string) => void
  ondoctype?: () => void
  onerror?: (error: Error) => void
  write(text: string): DavSaxParser
  close(): void
}
// sax already ships as a production dependency of electron-updater's
// builder-util-runtime. Use strict parsing and close the document explicitly;
// matching a closing tag alone cannot detect malformed nested responses.
const davSax = require('sax') as { parser(strict: boolean, options: { xmlns: boolean; strictEntities: boolean }): DavSaxParser }
function davDocument(xml: string): DavXmlNode {
  const parser = davSax.parser(true, { xmlns: true, strictEntities: true }), stack: DavXmlNode[] = []
  let root: DavXmlNode | undefined
  parser.onopentag = tag => {
    const node: DavXmlNode = { name: tag.local, uri: tag.uri, text: '', children: [] }
    if (stack.length) stack[stack.length - 1].children.push(node)
    else { if (root) throw new Error('Multiple XML roots'); root = node }
    stack.push(node)
  }
  parser.onclosetag = () => { stack.pop() }
  parser.ontext = parser.oncdata = value => { if (stack.length) stack[stack.length - 1].text += value }
  parser.ondoctype = () => { throw new Error('DAV document must not contain a DTD') }
  parser.onerror = error => { throw error }
  try { parser.write(xml).close() } catch { throw new Error('WebDAV 响应不是完整有效的目录信息') }
  if (!root || root.name !== 'multistatus' || (root.uri && root.uri !== 'DAV:')) throw new Error('WebDAV 响应不是有效的目录信息')
  return root
}
const davChildren = (node: DavXmlNode, name: string): DavXmlNode[] => node.children.filter(child => child.name === name && (!child.uri || child.uri === 'DAV:'))
function davStatus(node: DavXmlNode): number {
  const statuses = davChildren(node, 'status'), match = statuses[0]?.text.trim().match(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/)
  if (statuses.length !== 1 || !match) throw new Error('WebDAV 响应包含无效的资源状态')
  return Number(match[1])
}
function checkedPropfind(xml: string): DavEntry[] {
  const responses = davChildren(davDocument(xml), 'response'), entries: DavEntry[] = []
  // A successful depth-zero/one PROPFIND includes the requested resource,
  // even when its collection contains no children (RFC 4918 section 9.1).
  if (!responses.length) throw new Error('WebDAV 响应缺少资源信息')
  for (const response of responses) {
    const hrefs = davChildren(response, 'href'), href = hrefs[0]?.text.trim()
    if (hrefs.length !== 1 || !href || hrefs[0].children.length) throw new Error('WebDAV 响应包含无效的资源路径')
    if (davChildren(response, 'status').length) {
      const status = davStatus(response)
      if (status >= 300) throw new Error(davErrorMessage(status, '读取 WebDAV 资源'))
    }
    const properties: DavXmlNode[] = []
    for (const propstat of davChildren(response, 'propstat')) {
      const status = davStatus(propstat), props = davChildren(propstat, 'prop')
      if (props.length !== 1) throw new Error('WebDAV 响应包含无效的资源属性')
      if (status >= 300) {
        if (davChildren(props[0], 'resourcetype').length || davChildren(props[0], 'getcontentlength').length) throw new Error(davErrorMessage(status, '读取 WebDAV 文件属性'))
        continue // Unsupported optional quota/date properties do not invalidate a directory.
      }
      properties.push(...props[0].children)
    }
    if (!properties.length) throw new Error('WebDAV 响应缺少可读取的资源属性')
    const property = (name: string): DavXmlNode | undefined => {
      const matches = properties.filter(node => node.name === name && (!node.uri || node.uri === 'DAV:'))
      if (matches.length > 1) throw new Error('WebDAV 响应包含重复的资源属性')
      return matches[0]
    }
    const resourceType = property('resourcetype'), isDir = !!resourceType && davChildren(resourceType, 'collection').length > 0
    const length = property('getcontentlength')?.text.trim(), size = length === undefined && isDir ? 0 : Number(length)
    if (!resourceType || !Number.isSafeInteger(size) || size < 0 || (length !== undefined && !/^\d+$/.test(length))) throw new Error('WebDAV 响应缺少有效的文件类型或长度')
    const serverPath = hrefToServerPath(href), updatedAt = parseDate(property('getlastmodified')?.text.trim() || property('modificationdate')?.text.trim())
    entries.push({ href, path: serverPath, name: baseName(serverPath), isDir, size, updatedAt, createdAt: parseDate(property('creationdate')?.text.trim()) || updatedAt })
  }
  return entries
}

async function checkDavMutation(response: Response, action: string): Promise<void> {
  if (!response.ok) throw new Error(davErrorMessage(response.status, action))
  // A 207 response can contain individual failures, despite response.ok.
  if (response.status === 207) {
    const resources = davChildren(davDocument(await response.text()), 'response')
    if (!resources.length) throw new Error(`${action}失败：WebDAV 响应无效`)
    for (const resource of resources) {
      const hrefs = davChildren(resource, 'href')
      if (hrefs.length !== 1 || !hrefs[0].text.trim() || hrefs[0].children.length) throw new Error(`${action}失败：WebDAV 资源路径无效`)
      const groups = [...(davChildren(resource, 'status').length ? [resource] : []), ...davChildren(resource, 'propstat')]
      if (!groups.length) throw new Error(`${action}失败：WebDAV 缺少资源确认状态`)
      for (const group of groups) {
        const status = davStatus(group)
        if (status >= 300) throw new Error(davErrorMessage(status, action))
      }
    }
  }
}

function toFileItem(account: DriveAccount, entry: DavEntry, parentId: string): FileItem {
  return {
    id: pathToId(entry.path),
    parentId,
    name: entry.name,
    isDir: entry.isDir,
    size: entry.size,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    platform: 'webdav',
    accountId: account.id,
  }
}

function davBasePath(base: string): string {
  try {
    const pathname = decodeDavComponent(new URL(base).pathname)
    const trimmed = pathname.replace(/\/+$/, '')
    return trimmed || '/'
  } catch {
    return '/'
  }
}

/** Convert a server href to a path relative to the configured DAV root. */
function relativeDavPath(serverPath: string, basePath: string): string {
  const normalized = serverPath.startsWith('/') ? serverPath : `/${serverPath}`
  if (basePath === '/') return normalized
  if (normalized === basePath || normalized === `${basePath}/`) return '/'
  if (normalized.startsWith(`${basePath}/`)) return normalized.slice(basePath.length) || '/'
  // A few servers return already-relative paths.  Keep these usable rather
  // than prepending the base path a second time.
  return normalized
}

async function listEntries(ctx: DavContext, serverPath: string, signal?: AbortSignal): Promise<DavEntry[]> {
  const response = await davRequest(ctx, 'PROPFIND', serverPath, { depth: 1, body: PROPFIND_BODY, signal })
  if (response.status === 404) throw new Error('目录不存在或已被删除')
  if (!response.ok && response.status !== 207) throw new Error(davErrorMessage(response.status, '列出目录'))
  const xml = await response.text()
  const selfPath = serverPath === '/' ? '/' : `${serverPath.replace(/\/+$/, '')}/`
  const basePath = davBasePath(ctx.base)
  const entries = checkedPropfind(xml).map((entry) => {
    entry.path = relativeDavPath(entry.path, basePath)
    entry.name = baseName(entry.path)
    return entry
  })
  const self = entries.filter(entry => `${entry.path.replace(/\/+$/, '')}/` === selfPath)
  if (self.length !== 1 || !self[0].isDir) throw new Error('WebDAV 响应缺少所请求的目录，无法确认列表完整')
  const children = entries.filter(entry => entry !== self[0]), ids = new Set<string>()
  for (const entry of children) {
    const id = pathToId(entry.path)
    if (ids.has(id) || pathToId(parentPath(entry.path)) !== pathToId(serverPath)) throw new Error('WebDAV 响应包含重复或范围外的目录项')
    ids.add(id)
  }
  return children
}

export const webdavAdapter: DriveAdapter = {
  async checkLogin(account: DriveAccount): Promise<boolean> {
    try {
      const ctx = davContext(account)
      const response = await davRequest(ctx, 'PROPFIND', '/', { depth: 0, body: PROPFIND_BODY })
      if (!response.ok) return false
      return checkedPropfind(await response.text()).some(entry => entry.isDir)
    } catch {
      return false
    }
  },

  async getUserInfo(account: DriveAccount): Promise<{ nickname: string; avatar?: string }> {
    return { nickname: account.credential.username || account.nickname || 'WebDAV' }
  },

  async getQuota(account: DriveAccount): Promise<QuotaInfo> {
    const ctx = davContext(account)
    const response = await davRequest(ctx, 'PROPFIND', '/', { depth: 0, body: PROPFIND_BODY })
    if (!response.ok && response.status !== 207) throw new Error(davErrorMessage(response.status, '获取容量'))
    const xml = await response.text()
    checkedPropfind(xml)
    const quota = parseQuotaFromPropfind(xml)
    return { used: quota.used, total: quota.total }
  },

  async listFiles(account: DriveAccount, parentId: string): Promise<FileListResult> {
    const ctx = davContext(account)
    const serverPath = idToPath(parentId)
    const entries = await listEntries(ctx, serverPath)
    return {
      files: entries.map(entry => toFileItem(account, entry, pathToId(serverPath))),
      parentId,
      hasMore: false,
    }
  },

  async searchFiles(account: DriveAccount, keyword: string): Promise<FileItem[]> {
    const ctx = davContext(account)
    const needle = keyword.trim().toLowerCase()
    if (!needle) return []
    const results: FileItem[] = []
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS
    let visited = 0

    const walk = async (serverPath: string, depth: number): Promise<void> => {
      if (depth > SEARCH_MAX_DEPTH || visited >= SEARCH_MAX_ENTRIES || Date.now() > deadline) {
        throw new Error('WebDAV 搜索达到深度、数量或时间上限，无法返回完整结果；请缩小搜索范围')
      }
      const entries = await listEntries(ctx, serverPath)
      for (const entry of entries) {
        visited++
        if (visited > SEARCH_MAX_ENTRIES || Date.now() > deadline) throw new Error('WebDAV 搜索达到数量或时间上限，无法返回完整结果')
        if (!entry.isDir && entry.name.toLowerCase().includes(needle)) {
          results.push(toFileItem(account, entry, pathToId(parentPath(entry.path))))
        }
      }
      for (const entry of entries) {
        if (entry.isDir) await walk(entry.path.endsWith('/') ? entry.path : `${entry.path}/`, depth + 1)
      }
    }

    await walk('/', 0)
    return results
  },

  async mkdir(account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
    const ctx = davContext(account)
    const parent = idToPath(parentId)
    const target = `${parent === '/' ? '' : parent.replace(/\/+$/, '')}/${name}`
    // WebDAV 的 MKCOL 不支持递归建父目录，逐级补齐
    const segments = target.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      const response = await davRequest(ctx, 'MKCOL', current)
      if (response.status === 405) {
        // MKCOL 405 only establishes that a resource already exists; it may
        // be a regular file, so verify the collection before continuing.
        const existing = await davRequest(ctx, 'PROPFIND', current, { depth: 0, body: PROPFIND_BODY })
        if (!existing.ok) throw new Error(davErrorMessage(existing.status, '检查已有文件夹'))
        const entries = checkedPropfind(await existing.text())
        const basePath = davBasePath(ctx.base)
        if (!entries.some(entry => pathToId(relativeDavPath(entry.path, basePath)) === pathToId(current) && entry.isDir)) {
          throw new Error('新建文件夹失败：同名资源不是文件夹')
        }
      } else {
        await checkDavMutation(response, '新建文件夹')
      }
    }
    const now = Date.now()
    return {
      id: target,
      parentId: pathToId(parent),
      name,
      isDir: true,
      size: 0,
      createdAt: now,
      updatedAt: now,
      platform: 'webdav',
      accountId: account.id,
    }
  },

  async rename(account: DriveAccount, fileId: string, newName: string): Promise<void> {
    const ctx = davContext(account)
    const source = idToPath(fileId)
    const destination = `${parentPath(source).replace(/\/+$/, '')}/${newName}`
    const response = await davRequest(ctx, 'MOVE', source, { destinationPath: destination })
    await checkDavMutation(response, '重命名')
  },

  async move(account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
    const ctx = davContext(account)
    const targetDir = idToPath(targetDirId).replace(/\/+$/, '')
    for (const fileId of fileIds) {
      const source = idToPath(fileId)
      const destination = `${targetDir}/${baseName(source)}`
      const response = await davRequest(ctx, 'MOVE', source, { destinationPath: destination })
      await checkDavMutation(response, `移动 ${baseName(source)}`)
    }
  },

  async delete(account: DriveAccount, fileIds: string[]): Promise<void> {
    const ctx = davContext(account)
    for (const fileId of fileIds) {
      const response = await davRequest(ctx, 'DELETE', idToPath(fileId))
      if (response.status !== 404) await checkDavMutation(response, '删除')
    }
  },

  async upload(account: DriveAccount, localFilePath: string, targetDirId: string, options?: UploadOptions): Promise<UploadResult> {
    const ctx = davContext(account)
    const fileName = options?.fileName || path.basename(localFilePath)
    const dirPath = idToPath(targetDirId).replace(/\/+$/, '')
    const targetPath = `${dirPath}/${fileName}`
    const stat = await fs.promises.stat(localFilePath)
    if (!stat.isFile()) throw new Error('上传路径不是普通文件')
    options?.signal?.throwIfAborted()
    const total = stat.size

    if (!options?.overwrite) {
      const head = await davRequest(ctx, 'PROPFIND', targetPath, { depth: 0, body: PROPFIND_BODY, signal: options?.signal })
      if (head.status === 207 || head.ok) throw new Error(`同名文件已存在：${fileName}`)
      if (head.status !== 404) throw new Error(davErrorMessage(head.status, '检查上传目标'))
    }

    let loaded = 0
    let lastTickAt = Date.now()
    let lastTickLoaded = 0
    let speed = 0
    const source = fs.createReadStream(localFilePath)
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        loaded += chunk.length
        const now = Date.now()
        if (now - lastTickAt >= 300) {
          speed = Math.round(((loaded - lastTickLoaded) * 1000) / (now - lastTickAt))
          lastTickAt = now
          lastTickLoaded = loaded
        }
        options?.onProgress?.({ loaded, total, percent: total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0, speed })
        callback(null, chunk)
      },
    })
    try {
      const response = await net.fetch(`${ctx.base}${encodeDavPath(targetPath)}`, {
        method: 'PUT',
        headers: {
          Authorization: ctx.auth,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(total),
          ...(!options?.overwrite ? { 'If-None-Match': '*' } : {}),
        },
        body: Readable.toWeb(source.pipe(counter)) as unknown as BodyInit,
        signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
      if (!response.ok && response.status !== 201 && response.status !== 204) {
        throw new Error(davErrorMessage(response.status, '上传'))
      }
      options?.onProgress?.({ loaded: total, total, percent: 100, speed })
      return { success: true, fileId: targetPath, fileName, fileSize: total }
    } catch (error) {
      source.destroy()
      throw error
    }
  },

  async getDownloadSource(account: DriveAccount, fileId: string): Promise<DriveDownloadSource> {
    return {
      url: await this.getDownloadUrl!(account, fileId),
      headers: { Authorization: davContext(account).auth },
      fetch: (url, init) => net.fetch(url, init),
    }
  },

  async getDownloadUrl(account: DriveAccount, fileId: string): Promise<string> {
    const ctx = davContext(account)
    return `${ctx.base}${encodeDavPath(idToPath(fileId))}`
  },

  async download(account: DriveAccount, fileId: string, localDirPath: string, options?: DownloadOptions): Promise<DownloadResult> {
    const ctx = davContext(account)
    const serverPath = idToPath(fileId)
    const requestedName = options?.fileName || baseName(serverPath)
    const candidateName = path.basename(requestedName.replace(/\\/g, '/'))
    const fallbackName = baseName(serverPath)
    const fileName = candidateName && candidateName !== '.' && candidateName !== '..' ? candidateName : fallbackName
    const response = await davRequest(ctx, 'GET', serverPath, { signal: options?.signal })
    if (!response.ok) throw new Error(davErrorMessage(response.status, '下载'))
    if (!response.body) throw new Error('下载失败：服务器未返回内容')

    const total = Number(response.headers.get('content-length')) || 0
    const targetPath = path.join(localDirPath, fileName)
    let loaded = 0
    let lastTickAt = Date.now()
    let lastTickLoaded = 0
    let speed = 0
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        loaded += chunk.length
        const now = Date.now()
        if (now - lastTickAt >= 300) {
          speed = Math.round(((loaded - lastTickLoaded) * 1000) / (now - lastTickAt))
          lastTickAt = now
          lastTickLoaded = loaded
        }
        options?.onProgress?.({ loaded, total, percent: total > 0 ? Math.round((loaded / total) * 100) : 0, speed })
        callback(null, chunk)
      },
    })
    const output = fs.createWriteStream(targetPath)
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
        counter,
        output,
      )
      return { success: true, localPath: targetPath, fileName, fileSize: loaded || total }
    } catch (error) {
      await fs.promises.rm(targetPath, { force: true }).catch(() => undefined)
      throw error
    }
  },
}

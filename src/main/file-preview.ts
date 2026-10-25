import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from 'fs'
import os from 'os'
import path from 'path'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { detectFilePreviewType } from '../shared/file-preview'
import type { FilePreviewRequest, FilePreviewSessionDto, FilePreviewIpcResult } from '../shared/file-preview'
export { detectFilePreviewType } from '../shared/file-preview'
export type { FilePreviewKind, FilePreviewType, FilePreviewRequest, FilePreviewSessionDto, FilePreviewIpcResult } from '../shared/file-preview'
import { previewError, streamPreviewSource, validPreviewRange, type PreviewSource } from './preview-stream'
import { listArchiveFiles } from './archive'
import { sanitizeFileName } from './file-transfer'
import { parseAiDocument } from './ai/document-parser'

export interface FilePreviewDownloadContext {
  directory: string
  fileName: string
  maxBytes: number
}

export interface FilePreviewDownloadResult {
  success: boolean
  localPath?: string
  error?: string
}

export type FilePreviewDownloader = (
  request: FilePreviewRequest,
  context: FilePreviewDownloadContext,
) => Promise<FilePreviewDownloadResult>

export type FilePreviewSourceResolver = (request: FilePreviewRequest) => Promise<PreviewSource | undefined>

export interface FilePreviewServiceOptions {
  tempRoot?: string
  maxTextBytes?: number
  maxDownloadBytes?: number
  sessionTtlMs?: number
  now?: () => number
}

interface StoredPreviewSession {
  directory?: string
  filePath?: string
  source?: PreviewSource
  active: Set<AbortController>
  pendingReads: Set<AbortController>
  expiryTimer?: ReturnType<typeof setTimeout>
  dto: FilePreviewSessionDto
}

export interface FilePreviewIpcHandlers {
  create(request: FilePreviewRequest): Promise<FilePreviewIpcResult>
  cleanup(sessionId: string): FilePreviewIpcResult
}

export interface IpcHandlerRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): unknown
}

export const FILE_PREVIEW_IPC_CHANNELS = Object.freeze({
  create: 'file-preview:create',
  cleanup: 'file-preview:cleanup',
})

export const FILE_PREVIEW_DEFAULTS = Object.freeze({
  maxTextBytes: 1024 * 1024,
  maxDownloadBytes: 4 * 1024 * 1024 * 1024,
  sessionTtlMs: 30 * 60 * 1000,
})

/** Resolve a candidate below root without trusting string prefixes. */
export function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  const relation = path.relative(resolvedRoot, resolvedCandidate)
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error('预览临时路径越界')
  }
  return resolvedCandidate
}

export function readTextPreview(filePath: string, maxBytes: number): { content: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('文本预览大小限制无效')
  const size = statSync(filePath).size
  const bytesToRead = Math.min(size, maxBytes + 2)
  const buffer = Buffer.alloc(bytesToRead)
  const descriptor = openSync(filePath, 'r')
  let bytesRead = 0
  try {
    bytesRead = readSync(descriptor, buffer, 0, bytesToRead, 0)
  } finally {
    closeSync(descriptor)
  }

  const truncated = size > maxBytes
  const visible = buffer.subarray(0, Math.min(bytesRead, maxBytes))
  const content = decodeText(visible, truncated)
  const nulCount = content.split('\0').length - 1
  if (content.length > 0 && nulCount / content.length > 0.01) throw new Error('文件内容不是可安全预览的文本')
  return { content, truncated }
}

function decodeText(buffer: Buffer, truncated: boolean): string {
  let encoding = 'utf-8'
  if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le'
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be'
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer, { stream: truncated })
  } catch {
    if (encoding !== 'utf-8') throw new Error('文本编码损坏，请另存为 UTF-8 后重试')
    try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer, { stream: truncated }) }
    catch { throw new Error('无法识别文本编码，请另存为 UTF-8 后重试') }
  }
}

export class FilePreviewService {
  readonly tempRoot: string
  readonly maxTextBytes: number
  readonly maxDownloadBytes: number
  readonly sessionTtlMs: number

  private readonly sessions = new Map<string, StoredPreviewSession>()
  private readonly now: () => number
  private cleanupGeneration = 0

  constructor(options: FilePreviewServiceOptions = {}) {
    this.tempRoot = path.resolve(options.tempRoot || path.join(os.tmpdir(), 'panlite-file-preview'))
    this.maxTextBytes = positiveLimit(options.maxTextBytes, FILE_PREVIEW_DEFAULTS.maxTextBytes, '文本预览')
    this.maxDownloadBytes = positiveLimit(options.maxDownloadBytes, FILE_PREVIEW_DEFAULTS.maxDownloadBytes, '预览下载')
    this.sessionTtlMs = positiveLimit(options.sessionTtlMs, FILE_PREVIEW_DEFAULTS.sessionTtlMs, '预览会话')
    this.now = options.now || Date.now
    mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 })
  }

  async createSession(request: FilePreviewRequest, downloader: FilePreviewDownloader, resolveSource?: FilePreviewSourceResolver): Promise<FilePreviewSessionDto> {
    const generation = this.cleanupGeneration
    const assertActive = () => {
      if (generation !== this.cleanupGeneration) throw new Error('预览已取消')
    }
    this.cleanupExpiredSessions()
    validateRequest(request)
    const previewType = detectFilePreviewType(request.fileName)
    if (previewType.kind === 'unsupported') throw new Error('暂不支持预览此文件类型')
    if (!previewType.supported) throw new Error('已识别此压缩包格式，但当前解压引擎暂不支持读取')
    if (resolveSource && ['image', 'audio', 'video', 'pdf'].includes(previewType.kind)) {
      const source = await resolveSource(request)
      assertActive()
      if (source) {
        const url = new URL(source.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网盘预览地址无效')
        const sessionId = randomUUID()
        const dto: FilePreviewSessionDto = {
          sessionId, fileName: sanitizeFileName(request.fileName), kind: previewType.kind,
          mimeType: previewType.mimeType, size: request.fileSize || 0,
          delivery: 'stream', assetUrl: `panlite-preview://session/${sessionId}`,
          expiresAt: this.now() + this.sessionTtlMs,
        }
        this.storeSession({ source, dto })
        return dto
      }
    }
    if (request.fileSize !== undefined && request.fileSize > this.maxDownloadBytes) {
      throw new Error('文件超过预览下载大小限制')
    }

    const directory = mkdtempSync(path.join(this.tempRoot, 'session-'))
    const safeName = sanitizeFileName(request.fileName)
    try {
      const downloadResult = await downloader(request, {
        directory,
        fileName: safeName,
        maxBytes: this.maxDownloadBytes,
      })
      assertActive()
      if (!downloadResult.success || !downloadResult.localPath) {
        throw new Error(downloadResult.error || '预览文件下载失败')
      }

      const filePath = this.validateDownloadedFile(directory, downloadResult.localPath)
      const size = statSync(filePath).size
      if (size > this.maxDownloadBytes) throw new Error('下载文件超过预览大小限制')

      const sessionId = randomUUID()
      const expiresAt = this.now() + this.sessionTtlMs
      const common = {
        sessionId,
        fileName: safeName,
        kind: previewType.kind,
        mimeType: previewType.mimeType,
        size,
        expiresAt,
        delivery: 'download',
      } as const

      let dto: FilePreviewSessionDto
      if (previewType.kind === 'text' || previewType.kind === 'markdown') {
        const text = readTextPreview(filePath, this.maxTextBytes)
        dto = { ...common, kind: previewType.kind, content: text.content, truncated: text.truncated }
      } else if (previewType.kind === 'office') {
        const parsed = await parseAiDocument(filePath, previewType.extension.slice(1))
        if (parsed.status !== 'ready' || !parsed.sections?.length) {
          throw new Error(parsed.message || 'Office 文档未提取到可预览内容')
        }
        const fullContent = parsed.sections.map((section) => {
          const heading = section.section || (section.pageNumber ? `第 ${section.pageNumber} 页` : '正文')
          return `【${heading}】\n${section.content}`
        }).join('\n\n')
        const contentBuffer = Buffer.from(fullContent, 'utf8')
        const truncated = contentBuffer.length > this.maxTextBytes
        const content = truncated
          ? contentBuffer.subarray(0, this.maxTextBytes).toString('utf8').replace(/�$/, '')
          : fullContent
        dto = { ...common, kind: 'office', content, truncated, notice: parsed.message }
      } else if (previewType.kind === 'archive') {
        const archive = await listArchiveFiles(filePath, request.password)
        dto = { ...common, kind: 'archive', archive }
      } else {
        dto = { ...common, kind: previewType.kind, assetUrl: `panlite-preview://session/${sessionId}` }
      }

      assertActive()
      this.storeSession({ directory, filePath, dto })
      return dto
    } catch (error) {
      this.removeManagedDirectory(directory)
      throw error
    }
  }

  getSession(sessionId: string): FilePreviewSessionDto | undefined {
    this.cleanupExpiredSessions()
    return this.sessions.get(String(sessionId || ''))?.dto
  }

  /** Return a validated real path for custom protocol handlers; never accept a renderer-supplied path. */
  getSessionFilePath(sessionId: string): string {
    this.cleanupExpiredSessions()
    const session = this.sessions.get(String(sessionId || ''))
    if (!session?.directory || !session.filePath) throw new Error('预览会话不存在或已过期，或使用在线流')
    return this.validateDownloadedFile(session.directory, session.filePath)
  }

  cleanupSession(sessionId: string): boolean {
    const key = String(sessionId || '')
    const session = this.sessions.get(key)
    if (!session) return false
    this.sessions.delete(key)
    clearTimeout(session.expiryTimer)
    for (const controller of session.active) controller.abort()
    session.active.clear()
    session.pendingReads.clear()
    if (session.directory) this.removeManagedDirectory(session.directory)
    return true
  }

  cleanupExpiredSessions(): number {
    const now = this.now()
    let count = 0
    for (const [sessionId, session] of this.sessions) {
      if (!session.pendingReads.size && session.dto.expiresAt <= now && this.cleanupSession(sessionId)) count++
    }
    return count
  }

  cleanupAll(): number {
    this.cleanupGeneration++
    let count = 0
    for (const sessionId of [...this.sessions.keys()]) {
      if (this.cleanupSession(sessionId)) count++
    }
    return count
  }

  private storeSession(session: Omit<StoredPreviewSession, 'active' | 'pendingReads' | 'expiryTimer'>): void {
    const stored = { ...session, active: new Set<AbortController>(), pendingReads: new Set<AbortController>() }
    this.sessions.set(session.dto.sessionId, stored)
    this.touchSession(stored)
  }

  private touchSession(session: StoredPreviewSession): void {
    if (this.sessions.get(session.dto.sessionId) !== session) return
    session.dto.expiresAt = this.now() + this.sessionTtlMs
    this.scheduleExpiry(session, this.sessionTtlMs)
  }

  private scheduleExpiry(session: StoredPreviewSession, delay: number): void {
    clearTimeout(session.expiryTimer)
    session.expiryTimer = setTimeout(() => {
      if (this.sessions.get(session.dto.sessionId) !== session) return
      // A pending network read has its own 30-second timeout. Paused consumers have
      // no pending read, so a forgotten/paused stream cannot hold a session forever.
      if (session.pendingReads.size) this.scheduleExpiry(session, Math.min(this.sessionTtlMs, 30_000))
      else if (session.dto.expiresAt <= this.now()) this.cleanupSession(session.dto.sessionId)
      else this.scheduleExpiry(session, session.dto.expiresAt - this.now())
    }, Math.max(1, delay))
    session.expiryTimer.unref?.()
  }

  /** Called only by the registered custom protocol. The URL contains an opaque session id. */
  async handleRequest(request: Request): Promise<Response> {
    this.cleanupExpiredSessions()
    let id: string
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'panlite-preview:' || url.host !== 'session' || url.search || url.hash || url.username || url.password || !/^\/[0-9a-f-]{36}$/.test(url.pathname)) {
        return previewError(404, '预览会话不存在')
      }
      id = url.pathname.slice(1)
    } catch { return previewError(400, '预览地址无效') }
    const session = this.sessions.get(id)
    if (!session) return previewError(404, '预览会话不存在或已过期')
    if (!['GET', 'HEAD'].includes(request.method)) return previewError(405, '请求方法不受支持')
    const range = request.headers.get('range')
    if (range && !validPreviewRange(range)) return previewError(416, '请求范围无效')
    const controller = new AbortController()
    session.active.add(controller)
    this.touchSession(session)
    const activity = (pending: boolean) => {
      if (!session.active.has(controller)) return
      if (pending) session.pendingReads.add(controller)
      else session.pendingReads.delete(controller)
      this.touchSession(session)
    }
    const finish = () => {
      session.active.delete(controller)
      session.pendingReads.delete(controller)
      this.touchSession(session)
    }
    if (session.source) return streamPreviewSource(session.source, request, session.dto.mimeType, controller, finish, activity)
    // Reuse the same guarded streaming bridge for downloaded local previews.
    try {
      const filePath = this.getSessionFilePath(id)
      return await streamPreviewSource({
        url: 'http://local-preview.invalid/',
        fetch: async (_url, init) => {
          const size = statSync(filePath).size
          let start = 0
          let end = size - 1
          if (range) {
            const [left, right] = range.slice(6).split('-')
            start = left ? Number(left) : Math.max(0, size - Number(right))
            end = left && right ? Math.min(Number(right), size - 1) : size - 1
            if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
          }
          const headers: Record<string, string> = { 'Content-Length': String(Math.max(0, end - start + 1)), 'Accept-Ranges': 'bytes' }
          if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
          const body = init.method === 'HEAD' || size === 0 ? null : Readable.toWeb(createReadStream(filePath, { start, end, signal: init.signal || undefined })) as ReadableStream<Uint8Array>
          return new Response(body, { status: range ? 206 : 200, headers })
        },
      }, request, session.dto.mimeType, controller, finish, activity)
    } catch { finish(); return previewError(404, '预览文件不存在') }
  }

  private validateDownloadedFile(directory: string, candidate: string): string {
    const managedDirectory = assertPathInside(this.tempRoot, directory)
    const candidatePath = assertPathInside(managedDirectory, candidate)
    if (!existsSync(candidatePath)) throw new Error('下载结果不存在')
    if (lstatSync(candidatePath).isSymbolicLink()) throw new Error('下载结果不能是符号链接')
    const realDirectory = realpathSync(managedDirectory)
    const realFilePath = realpathSync(candidatePath)
    assertPathInside(realDirectory, realFilePath)
    if (!statSync(realFilePath).isFile()) throw new Error('下载结果不是普通文件')
    return realFilePath
  }

  private removeManagedDirectory(directory: string): void {
    const managedDirectory = assertPathInside(this.tempRoot, directory)
    rmSync(managedDirectory, { recursive: true, force: true })
  }
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label}限制无效`)
  return result
}

function validateRequest(request: FilePreviewRequest): void {
  if (!request || typeof request !== 'object') throw new Error('预览请求无效')
  if (!String(request.accountId || '').trim()) throw new Error('账号 ID 不能为空')
  if (!String(request.fileId || '').trim()) throw new Error('文件 ID 不能为空')
  if (!String(request.fileName || '').trim()) throw new Error('文件名不能为空')
  if (request.fileSize !== undefined && (!Number.isSafeInteger(request.fileSize) || request.fileSize < 0)) {
    throw new Error('文件大小无效')
  }
}

export function createFilePreviewIpcHandlers(
  service: FilePreviewService,
  downloader: FilePreviewDownloader,
  resolveSource?: FilePreviewSourceResolver,
): FilePreviewIpcHandlers {
  return {
    async create(request) {
      try {
        const preview = await service.createSession(request, downloader, resolveSource)
        return { success: true, preview }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    cleanup(sessionId) {
      try {
        return { success: true, cleaned: service.cleanupSession(sessionId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

export function registerFilePreviewIpc(
  ipcMain: IpcHandlerRegistrar,
  service: FilePreviewService,
  downloader: FilePreviewDownloader,
  resolveSource?: FilePreviewSourceResolver,
): FilePreviewIpcHandlers {
  const handlers = createFilePreviewIpcHandlers(service, downloader, resolveSource)
  ipcMain.handle(FILE_PREVIEW_IPC_CHANNELS.create, (_event, request: FilePreviewRequest) => handlers.create(request))
  ipcMain.handle(FILE_PREVIEW_IPC_CHANNELS.cleanup, (_event, sessionId: string) => handlers.cleanup(sessionId))
  return handlers
}

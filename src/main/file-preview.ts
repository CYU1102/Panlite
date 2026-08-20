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
import { pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import type { ArchiveMeta } from '../shared/types'
import { isArchiveFile, isSupportedArchive, listArchiveFiles } from './archive'
import { sanitizeFileName } from './file-transfer'

export type FilePreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'markdown' | 'archive' | 'unsupported'

export interface FilePreviewType {
  kind: FilePreviewKind
  mimeType: string
  extension: string
  supported: boolean
}

export interface FilePreviewRequest {
  accountId: string
  fileId: string
  fileName: string
  fileSize?: number
  password?: string
}

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

export interface FilePreviewSessionDto {
  sessionId: string
  fileName: string
  kind: Exclude<FilePreviewKind, 'unsupported'>
  mimeType: string
  size: number
  assetUrl?: string
  content?: string
  truncated?: boolean
  archive?: ArchiveMeta
  expiresAt: number
}

export interface FilePreviewServiceOptions {
  tempRoot?: string
  maxTextBytes?: number
  maxDownloadBytes?: number
  sessionTtlMs?: number
  now?: () => number
}

interface StoredPreviewSession {
  directory: string
  filePath: string
  dto: FilePreviewSessionDto
}

export interface FilePreviewIpcResult {
  success: boolean
  preview?: FilePreviewSessionDto
  cleaned?: boolean
  error?: string
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

const IMAGE_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
])

const VIDEO_MIME = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.m4v', 'video/x-m4v'],
  ['.avi', 'video/x-msvideo'],
  ['.mkv', 'video/x-matroska'],
  ['.flv', 'video/x-flv'],
  ['.wmv', 'video/x-ms-wmv'],
])

const AUDIO_MIME = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.opus', 'audio/opus'],
])

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])
const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.log', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.properties', '.env', '.sql', '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx',
  '.vue', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.rb', '.sh', '.ps1',
  '.bat', '.cmd', '.dockerfile', '.gitignore', '.editorconfig',
])

function normalizedExtension(fileName: string): string {
  const lower = String(fileName || '').trim().toLowerCase()
  if (lower.endsWith('.tar.gz')) return '.tar.gz'
  return path.extname(lower)
}

/** Pure extension-based classification. SVG is treated as text so active content is never embedded as an image. */
export function detectFilePreviewType(fileName: string): FilePreviewType {
  const extension = normalizedExtension(fileName)
  const imageMime = IMAGE_MIME.get(extension)
  if (imageMime) return { kind: 'image', mimeType: imageMime, extension, supported: true }

  const videoMime = VIDEO_MIME.get(extension)
  if (videoMime) return { kind: 'video', mimeType: videoMime, extension, supported: true }

  const audioMime = AUDIO_MIME.get(extension)
  if (audioMime) return { kind: 'audio', mimeType: audioMime, extension, supported: true }

  if (extension === '.pdf') return { kind: 'pdf', mimeType: 'application/pdf', extension, supported: true }
  if (MARKDOWN_EXTENSIONS.has(extension)) return { kind: 'markdown', mimeType: 'text/markdown; charset=utf-8', extension, supported: true }
  if (extension === '.svg') return { kind: 'text', mimeType: 'text/plain; charset=utf-8', extension, supported: true }

  if (isArchiveFile(fileName)) {
    return {
      kind: 'archive',
      mimeType: archiveMimeType(extension),
      extension,
      supported: isSupportedArchive(fileName),
    }
  }

  if (TEXT_EXTENSIONS.has(extension) || isSpecialTextName(fileName)) {
    return { kind: 'text', mimeType: 'text/plain; charset=utf-8', extension, supported: true }
  }

  return { kind: 'unsupported', mimeType: 'application/octet-stream', extension, supported: false }
}

function archiveMimeType(extension: string): string {
  switch (extension) {
    case '.zip': return 'application/zip'
    case '.rar': return 'application/vnd.rar'
    case '.7z': return 'application/x-7z-compressed'
    case '.tar': return 'application/x-tar'
    case '.tar.gz':
    case '.tgz':
    case '.gz': return 'application/gzip'
    default: return 'application/octet-stream'
  }
}

function isSpecialTextName(fileName: string): boolean {
  const base = path.basename(String(fileName || '')).toLowerCase()
  return ['dockerfile', 'makefile', 'license', 'readme', 'changelog'].includes(base)
}

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
  const content = decodeText(visible)
  const nulCount = content.split('\0').length - 1
  if (content.length > 0 && nulCount / content.length > 0.01) throw new Error('文件内容不是可安全预览的文本')
  return { content, truncated }
}

function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2)
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1]
      swapped[index - 1] = buffer[index]
    }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0
  return new TextDecoder('utf-8').decode(buffer.subarray(start))
}

export class FilePreviewService {
  readonly tempRoot: string
  readonly maxTextBytes: number
  readonly maxDownloadBytes: number
  readonly sessionTtlMs: number

  private readonly sessions = new Map<string, StoredPreviewSession>()
  private readonly now: () => number

  constructor(options: FilePreviewServiceOptions = {}) {
    this.tempRoot = path.resolve(options.tempRoot || path.join(os.tmpdir(), 'panlite-file-preview'))
    this.maxTextBytes = positiveLimit(options.maxTextBytes, FILE_PREVIEW_DEFAULTS.maxTextBytes, '文本预览')
    this.maxDownloadBytes = positiveLimit(options.maxDownloadBytes, FILE_PREVIEW_DEFAULTS.maxDownloadBytes, '预览下载')
    this.sessionTtlMs = positiveLimit(options.sessionTtlMs, FILE_PREVIEW_DEFAULTS.sessionTtlMs, '预览会话')
    this.now = options.now || Date.now
    mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 })
  }

  async createSession(request: FilePreviewRequest, downloader: FilePreviewDownloader): Promise<FilePreviewSessionDto> {
    this.cleanupExpiredSessions()
    validateRequest(request)
    const previewType = detectFilePreviewType(request.fileName)
    if (previewType.kind === 'unsupported') throw new Error('暂不支持预览此文件类型')
    if (!previewType.supported) throw new Error('已识别此压缩包格式，但当前解压引擎暂不支持读取')
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
      } as const

      let dto: FilePreviewSessionDto
      if (previewType.kind === 'text' || previewType.kind === 'markdown') {
        const text = readTextPreview(filePath, this.maxTextBytes)
        dto = { ...common, kind: previewType.kind, content: text.content, truncated: text.truncated }
      } else if (previewType.kind === 'archive') {
        const archive = await listArchiveFiles(filePath, request.password)
        dto = { ...common, kind: 'archive', archive }
      } else {
        dto = { ...common, kind: previewType.kind, assetUrl: pathToFileURL(filePath).href }
      }

      this.sessions.set(sessionId, { directory, filePath, dto })
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
    if (!session) throw new Error('预览会话不存在或已过期')
    return this.validateDownloadedFile(session.directory, session.filePath)
  }

  cleanupSession(sessionId: string): boolean {
    const key = String(sessionId || '')
    const session = this.sessions.get(key)
    if (!session) return false
    this.sessions.delete(key)
    this.removeManagedDirectory(session.directory)
    return true
  }

  cleanupExpiredSessions(): number {
    const now = this.now()
    let count = 0
    for (const [sessionId, session] of this.sessions) {
      if (session.dto.expiresAt <= now && this.cleanupSession(sessionId)) count++
    }
    return count
  }

  cleanupAll(): number {
    let count = 0
    for (const sessionId of [...this.sessions.keys()]) {
      if (this.cleanupSession(sessionId)) count++
    }
    return count
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
): FilePreviewIpcHandlers {
  return {
    async create(request) {
      try {
        const preview = await service.createSession(request, downloader)
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
): FilePreviewIpcHandlers {
  const handlers = createFilePreviewIpcHandlers(service, downloader)
  ipcMain.handle(FILE_PREVIEW_IPC_CHANNELS.create, (_event, request: FilePreviewRequest) => handlers.create(request))
  ipcMain.handle(FILE_PREVIEW_IPC_CHANNELS.cleanup, (_event, sessionId: string) => handlers.cleanup(sessionId))
  return handlers
}

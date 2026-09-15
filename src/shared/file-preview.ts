import type { ArchiveMeta } from './types'

export type FilePreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'markdown' | 'office' | 'archive' | 'unsupported'

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

export interface FilePreviewSessionDto {
  sessionId: string
  fileName: string
  kind: Exclude<FilePreviewKind, 'unsupported'>
  mimeType: string
  size: number
  delivery?: 'stream' | 'download'
  assetUrl?: string
  content?: string
  truncated?: boolean
  notice?: string
  archive?: ArchiveMeta
  expiresAt: number
}

export interface FilePreviewIpcResult {
  success: boolean
  preview?: FilePreviewSessionDto
  cleaned?: boolean
  error?: string
}

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
const OFFICE_MIME = new Map([
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
])
const TEXT_EXTENSIONS = new Set([
  '.srt', '.vtt', '.ass', '.ssa', '.lrc', '.txt', '.text', '.log', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.properties', '.env', '.sql', '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx',
  '.vue', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.rb', '.sh', '.ps1',
  '.bat', '.cmd', '.dockerfile', '.gitignore', '.editorconfig',
])

function normalizedExtension(fileName: string): string {
  const lower = String(fileName || '').trim().toLowerCase()
  if (lower.endsWith('.tar.gz')) return '.tar.gz'
  const base = lower.replace(/\\/g, '/').split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
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
  const officeMime = OFFICE_MIME.get(extension)
  if (officeMime) return { kind: 'office', mimeType: officeMime, extension, supported: true }

  if (new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.iso', '.tar.gz']).has(extension)) {
    return {
      kind: 'archive',
      mimeType: archiveMimeType(extension),
      extension,
      supported: new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.tar.gz']).has(extension),
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
  const base = (String(fileName || '').replace(/\\/g, '/').split('/').pop() || '').toLowerCase()
  return ['dockerfile', 'makefile', 'license', 'readme', 'changelog'].includes(base)
}

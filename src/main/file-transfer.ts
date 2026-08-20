import path from 'path'
import type { FileConflictPolicy } from '../shared/types'

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/** Turn an untrusted cloud name into one safe local path segment. */
export function sanitizeFileName(name: string): string {
  let safe = String(name || '').replace(INVALID_FILE_CHARS, '_').trim()
  safe = safe.replace(/[. ]+$/g, '')
  if (!safe || safe === '.' || safe === '..') safe = '_'
  if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`
  // Leave room for the parent path while avoiding Windows' common segment limit.
  if (safe.length > 180) {
    const ext = path.extname(safe).slice(0, 30)
    safe = `${safe.slice(0, 180 - ext.length)}${ext}`
  }
  return safe
}

/** Validate an IPC-supplied relative path and normalize every segment. */
export function normalizeRelativePath(relativePath: string): string {
  const raw = String(relativePath || '').replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw) || raw.startsWith('//')) {
    throw new Error('相对路径无效')
  }
  const parts = raw.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('相对路径包含非法目录')
  }
  return parts.map(sanitizeFileName).join(path.sep)
}

/** Resolve a normalized relative path while proving it remains below root. */
export function resolvePathInside(root: string, relativePath: string): string {
  const rootPath = path.resolve(root)
  const targetPath = path.resolve(rootPath, normalizeRelativePath(relativePath))
  const relation = path.relative(rootPath, targetPath)
  if (!relation || relation.startsWith(`..${path.sep}`) || relation === '..' || path.isAbsolute(relation)) {
    throw new Error('目标路径越界')
  }
  return targetPath
}

export function chooseAvailableName(
  requestedName: string,
  isDir: boolean,
  isTaken: (candidate: string) => boolean,
): string {
  const safeName = sanitizeFileName(requestedName)
  if (!isTaken(safeName)) return safeName
  const ext = isDir ? '' : path.extname(safeName)
  const stem = ext ? safeName.slice(0, -ext.length) : safeName
  for (let index = 1; index <= 10_000; index++) {
    const candidate = `${stem} (${index})${ext}`
    if (!isTaken(candidate)) return candidate
  }
  throw new Error(`无法为 ${safeName} 生成不冲突的名称`)
}

export function normalizeConflictPolicy(
  conflictPolicy?: FileConflictPolicy,
  overwrite?: boolean,
): FileConflictPolicy {
  if (conflictPolicy) return conflictPolicy
  return overwrite ? 'overwrite' : 'rename'
}

export function calculateTransferProgress(input: {
  completedBytes: number
  currentLoaded: number
  totalBytes: number
  completedFiles: number
  currentPercent?: number
  totalFiles: number
}): number {
  if (input.totalBytes > 0) {
    return Math.max(0, Math.min(99, Math.round(((input.completedBytes + input.currentLoaded) / input.totalBytes) * 100)))
  }
  if (input.totalFiles <= 0) return 0
  const currentFraction = Math.max(0, Math.min(1, (input.currentPercent || 0) / 100))
  return Math.max(0, Math.min(99, Math.round(((input.completedFiles + currentFraction) / input.totalFiles) * 100)))
}

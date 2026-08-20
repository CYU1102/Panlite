import type { FileItem } from './types'

export type BatchRenameMode = 'replace' | 'prefix' | 'suffix' | 'sequence'

export interface BatchRenameOptions {
  mode: BatchRenameMode
  replaceFrom?: string
  replaceTo?: string
  useRegex?: boolean
  prefix?: string
  suffix?: string
  sequenceStart?: number
  sequenceDigits?: number
  sequenceSeparator?: string
}

export interface BatchRenamePreviewItem {
  file: FileItem
  oldName: string
  newName: string
  changed: boolean
  errors: string[]
}

export interface BatchRenamePreview {
  items: BatchRenamePreviewItem[]
  errors: string[]
  valid: boolean
  changedCount: number
}

function splitExtension(name: string, isDir: boolean): { stem: string; extension: string } {
  if (isDir) return { stem: name, extension: '' }
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return { stem: name, extension: '' }
  return { stem: name.slice(0, dotIndex), extension: name.slice(dotIndex) }
}

export function validateRegularExpression(pattern: string): string | null {
  if (!pattern) return null
  try {
    new RegExp(pattern, 'g')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : '无效的正则表达式'
  }
}

export function validateFileName(name: string): string[] {
  const errors: string[] = []
  if (!name) errors.push('名称不能为空')
  if (name === '.' || name === '..') errors.push('名称不能是 . 或 ..')
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) errors.push('名称包含非法字符')
  if (/[. ]$/.test(name)) errors.push('名称不能以空格或句点结尾')
  if (name.length > 255) errors.push('名称不能超过 255 个字符')
  return errors
}

export function buildBatchRenameName(
  file: Pick<FileItem, 'name' | 'isDir'>,
  index: number,
  options: BatchRenameOptions,
): string {
  const { stem, extension } = splitExtension(file.name, file.isDir)
  switch (options.mode) {
    case 'replace': {
      if (!options.replaceFrom) return file.name
      if (options.useRegex) {
        if (validateRegularExpression(options.replaceFrom)) return file.name
        return file.name.replace(new RegExp(options.replaceFrom, 'g'), options.replaceTo || '')
      }
      return file.name.split(options.replaceFrom).join(options.replaceTo || '')
    }
    case 'prefix':
      return `${options.prefix || ''}${file.name}`
    case 'suffix':
      return `${stem}${options.suffix || ''}${extension}`
    case 'sequence': {
      const start = Math.max(0, Math.floor(options.sequenceStart ?? 1))
      const digits = Math.max(1, Math.floor(options.sequenceDigits ?? 3))
      const sequence = String(start + index).padStart(digits, '0')
      return `${sequence}${options.sequenceSeparator ?? '_'}${stem}${extension}`
    }
  }
}

function itemLocationKey(file: FileItem, name: string): string {
  return `${file.accountId}\u0000${file.parentId}\u0000${name.toLocaleLowerCase()}`
}

export function buildBatchRenamePreview(files: FileItem[], options: BatchRenameOptions): BatchRenamePreview {
  const regexError = options.mode === 'replace' && options.useRegex
    ? validateRegularExpression(options.replaceFrom || '')
    : null
  const items = files.map((file, index): BatchRenamePreviewItem => {
    const newName = buildBatchRenameName(file, index, options)
    return {
      file,
      oldName: file.name,
      newName,
      changed: newName !== file.name,
      errors: [...(regexError ? [`正则表达式无效：${regexError}`] : []), ...validateFileName(newName)],
    }
  })

  const locations = new Map<string, BatchRenamePreviewItem[]>()
  for (const item of items) {
    const key = itemLocationKey(item.file, item.newName)
    locations.set(key, [...(locations.get(key) || []), item])
  }
  for (const duplicates of locations.values()) {
    if (duplicates.length < 2) continue
    for (const item of duplicates) item.errors.push(`同一目录存在重复名称：${item.newName}`)
  }

  const errors = [...new Set(items.flatMap((item) => item.errors))]
  const changedCount = items.filter((item) => item.changed).length
  return {
    items,
    errors,
    valid: errors.length === 0,
    changedCount,
  }
}

export function toBatchRenameItems(preview: BatchRenamePreview): Array<{
  fileId: string
  path?: string
  newName: string
}> {
  if (!preview.valid) throw new Error(preview.errors[0] || '重命名预览无效')
  return preview.items
    .filter((item) => item.changed)
    .map((item) => ({ fileId: item.file.id, path: item.file.path, newName: item.newName }))
}

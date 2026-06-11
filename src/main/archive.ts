import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { pipeline } from 'stream/promises'
import type { ArchiveFileInfo, ArchiveMeta } from '../shared/types'
import log from 'electron-log'

// ── 支持的压缩包格式 ──

// 实际支持的格式（ZIP、RAR、7Z、TAR.GZ）
const SUPPORTED_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz'])

// 所有压缩包格式（用于UI显示）
const ALL_ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso'])

export function isArchiveFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase().replace('.', '')
  return ALL_ARCHIVE_EXTENSIONS.has(ext)
}

export function isSupportedArchive(filename: string): boolean {
  const lower = filename.toLowerCase()
  // 处理复合扩展名
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return true
  const ext = extname(filename).toLowerCase().replace('.', '')
  return SUPPORTED_EXTENSIONS.has(ext)
}

export function getArchiveFormat(filename: string): string {
  const lower = filename.toLowerCase()
  // 处理复合扩展名
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar'

  const ext = extname(filename).toLowerCase().replace('.', '')
  if (ext === 'zip') return 'zip'
  if (ext === 'rar') return 'rar'
  if (ext === '7z') return '7z'
  if (ext === 'tar') return 'tar'
  if (ext === 'gz') return 'tar'
  return 'unknown'
}

// ── ZIP 解压 ──

async function listZipFiles(filePath: string, password?: string): Promise<{ files: ArchiveFileInfo[]; isEncrypted: boolean }> {
  try {
    const unzipper = require('unzipper')
    const files: ArchiveFileInfo[] = []
    let isEncrypted = false

    const directory = await unzipper.Open.file(filePath)

    for (const entry of directory.files) {
      // 检测是否加密（encrypted bit in general purpose bit flag）
      if (entry.flags && (entry.flags & 0x01) !== 0) {
        isEncrypted = true
      }

      files.push({
        name: entry.path.split('/').pop() || entry.path,
        path: entry.path,
        size: entry.size || 0,
        isDir: entry.type === 'Directory',
        compressedSize: entry.compressedSize,
        modifiedAt: entry.lastModifiedDateTime ? new Date(entry.lastModifiedDateTime).getTime() : undefined,
      })
    }

    return { files, isEncrypted }
  } catch (err) {
    log.error('Failed to list ZIP files:', err)
    throw new Error('无法读取ZIP文件内容')
  }
}

async function extractZip(filePath: string, outputDir: string, password?: string, files?: string[]): Promise<void> {
  try {
    const unzipper = require('unzipper')

    const directory = await unzipper.Open.file(filePath)

    for (const entry of directory.files) {
      // 如果指定了文件，只解压指定的文件
      if (files && !files.includes(entry.path)) continue

      const targetPath = join(outputDir, entry.path)

      if (entry.type === 'Directory') {
        mkdirSync(targetPath, { recursive: true })
      } else {
        // 确保父目录存在
        const parentDir = join(targetPath, '..')
        mkdirSync(parentDir, { recursive: true })

        // 解压文件
        const readStream = entry.stream(password)
        const writeStream = createWriteStream(targetPath)
        await pipeline(readStream, writeStream)
      }
    }
  } catch (err) {
    log.error('Failed to extract ZIP:', err)
    throw new Error('解压ZIP文件失败')
  }
}

// ── RAR 解压 ──

async function listRarFiles(filePath: string, password?: string): Promise<ArchiveFileInfo[]> {
  try {
    const unrar = require('node-unrar-js')
    const files: ArchiveFileInfo[] = []

    // 读取文件到 Buffer
    const fs = require('fs')
    const buffer = fs.readFileSync(filePath)

    // 创建 Archive 对象
    const archive = await unrar.createExtractorFromData({ data: buffer, password: password || '' })

    // 获取文件列表
    const list = archive.getFileList()
    const fileHeaders = list.fileHeaders

    for (const header of fileHeaders) {
      files.push({
        name: header.name.split('/').pop() || header.name,
        path: header.name,
        size: header.unpSize || 0,
        isDir: header.flags?.directory || false,
        compressedSize: header.packSize,
        modifiedAt: header.time ? new Date(header.time).getTime() : undefined,
      })
    }

    return files
  } catch (err) {
    log.error('Failed to list RAR files:', err)
    throw new Error('无法读取RAR文件内容')
  }
}

async function extractRar(filePath: string, outputDir: string, password?: string, files?: string[]): Promise<void> {
  try {
    const unrar = require('node-unrar-js')
    const fs = require('fs')

    // 读取文件到 Buffer
    const buffer = fs.readFileSync(filePath)

    // 创建 Archive 对象
    const archive = await unrar.createExtractorFromData({ data: buffer, password: password || '' })

    // 解压文件
    const extracted = archive.extract({ files: files || undefined })

    for (const file of extracted.files) {
      const targetPath = join(outputDir, file.fileHeader.name)

      if (file.fileHeader.flags?.directory) {
        mkdirSync(targetPath, { recursive: true })
      } else {
        // 确保父目录存在
        const parentDir = join(targetPath, '..')
        mkdirSync(parentDir, { recursive: true })

        // 写入文件
        fs.writeFileSync(targetPath, file.extraction)
      }
    }
  } catch (err) {
    log.error('Failed to extract RAR:', err)
    throw new Error('解压RAR文件失败')
  }
}

// ── 7Z 解压 ──

async function list7zFiles(filePath: string, password?: string): Promise<ArchiveFileInfo[]> {
  try {
    const Seven = require('node-7z')
    const files: ArchiveFileInfo[] = []

    // 使用 7z 列出文件
    const seven = new Seven()
    const result = await seven.list(filePath, {
      password: password || '',
    })

    for (const file of result.files) {
      files.push({
        name: file.name.split('/').pop() || file.name,
        path: file.name,
        size: file.size || 0,
        isDir: file.isDirectory || false,
        compressedSize: file.compressed,
        modifiedAt: file.date ? new Date(file.date).getTime() : undefined,
      })
    }

    return files
  } catch (err) {
    log.error('Failed to list 7z files:', err)
    throw new Error('无法读取7z文件内容')
  }
}

async function extract7z(filePath: string, outputDir: string, password?: string, files?: string[]): Promise<void> {
  try {
    const Seven = require('node-7z')

    // 确保输出目录存在
    mkdirSync(outputDir, { recursive: true })

    // 解压文件
    const seven = new Seven()
    await seven.extract(filePath, outputDir, {
      password: password || '',
      $cherryPick: files || undefined,
    })
  } catch (err) {
    log.error('Failed to extract 7z:', err)
    throw new Error('解压7z文件失败')
  }
}

// ── TAR 解压 ──

async function listTarFiles(filePath: string): Promise<ArchiveFileInfo[]> {
  try {
    const tar = require('tar')
    const files: ArchiveFileInfo[] = []

    // 检查是否是压缩的tar
    const lower = filePath.toLowerCase()

    // 使用 tar 列出文件
    const entries: any[] = []

    await tar.list({
      file: filePath,
      gzip: lower.endsWith('.gz') || lower.endsWith('.tgz'),
      onentry: (entry: any) => {
        entries.push({
          name: entry.path,
          size: entry.size || 0,
          isDir: entry.type === 'Directory',
          modifiedAt: entry.mtime ? new Date(entry.mtime).getTime() : undefined,
        })
      },
    })

    for (const entry of entries) {
      files.push({
        name: entry.name.split('/').filter(Boolean).pop() || entry.name,
        path: entry.name,
        size: entry.size,
        isDir: entry.isDir,
        modifiedAt: entry.modifiedAt,
      })
    }

    return files
  } catch (err) {
    log.error('Failed to list tar files:', err)
    throw new Error('无法读取tar文件内容')
  }
}

async function extractTar(filePath: string, outputDir: string, files?: string[]): Promise<void> {
  try {
    const tar = require('tar')

    // 确保输出目录存在
    mkdirSync(outputDir, { recursive: true })

    // 检查是否是压缩的tar
    const lower = filePath.toLowerCase()
    const isGzip = lower.endsWith('.gz') || lower.endsWith('.tgz')
    const isBzip2 = lower.endsWith('.bz2')
    const isXz = lower.endsWith('.xz')

    const options: any = {
      file: filePath,
      cwd: outputDir,
      gzip: isGzip,
    }

    // 如果指定了文件，只解压指定的文件
    if (files && files.length > 0) {
      options.filter = (path: string) => files.some(f => path.startsWith(f))
    }

    await tar.extract(options)
  } catch (err) {
    log.error('Failed to extract tar:', err)
    throw new Error('解压tar文件失败')
  }
}

// ── 统一接口 ──

export async function listArchiveFiles(filePath: string, password?: string): Promise<ArchiveMeta> {
  const format = getArchiveFormat(filePath)

  let files: ArchiveFileInfo[] = []
  let isEncrypted = false

  switch (format) {
    case 'zip': {
      const result = await listZipFiles(filePath, password)
      files = result.files
      isEncrypted = result.isEncrypted
      break
    }
    case 'rar':
      files = await listRarFiles(filePath, password)
      break
    case '7z':
      files = await list7zFiles(filePath, password)
      break
    case 'tar':
      files = await listTarFiles(filePath)
      break
    default:
      throw new Error('不支持的压缩包格式')
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0)

  return {
    fileCount: files.length,
    totalSize,
    isEncrypted,
    format,
    files,
  }
}

export async function extractArchive(
  filePath: string,
  outputDir: string,
  password?: string,
  files?: string[],
): Promise<void> {
  const format = getArchiveFormat(filePath)

  // 确保输出目录存在
  mkdirSync(outputDir, { recursive: true })

  switch (format) {
    case 'zip':
      await extractZip(filePath, outputDir, password, files)
      break
    case 'rar':
      await extractRar(filePath, outputDir, password, files)
      break
    case '7z':
      await extract7z(filePath, outputDir, password, files)
      break
    case 'tar':
      await extractTar(filePath, outputDir, files)
      break
    default:
      throw new Error('不支持的压缩包格式')
  }
}

// ── 递归获取目录下所有文件 ──

export function getAllFilesInDir(dirPath: string, basePath: string = ''): Array<{ relativePath: string; fullPath: string; size: number }> {
  const files: Array<{ relativePath: string; fullPath: string; size: number }> = []

  const entries = readdirSync(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      files.push(...getAllFilesInDir(fullPath, relativePath))
    } else {
      const stat = statSync(fullPath)
      files.push({
        relativePath,
        fullPath,
        size: stat.size,
      })
    }
  }

  return files
}

// ── 清理临时文件 ──

export function cleanupTempDir(dirPath: string): void {
  try {
    if (!existsSync(dirPath)) return

    const entries = readdirSync(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        cleanupTempDir(fullPath)
      } else {
        unlinkSync(fullPath)
      }
    }

    // 删除空目录
    const { rmdirSync } = require('fs')
    rmdirSync(dirPath)
  } catch (err) {
    log.warn('Failed to cleanup temp dir:', err)
  }
}

// ── ZIP 压缩 ──

export async function compressToZip(
  sourceDir: string,
  outputPath: string,
  files?: Array<{ relativePath: string; fullPath: string }>,
): Promise<void> {
  try {
    const archiver = require('archiver')
    const fs = require('fs')

    // 创建输出流
    const output = createWriteStream(outputPath)
    const archive = archiver('zip', {
      zlib: { level: 6 }, // 压缩级别
    })

    // 监听事件
    archive.on('warning', (err: any) => {
      if (err.code === 'ENOENT') {
        log.warn('Archive warning:', err)
      } else {
        throw err
      }
    })

    archive.on('error', (err: any) => {
      throw err
    })

    // 管道到输出流
    archive.pipe(output)

    if (files && files.length > 0) {
      // 添加指定文件
      for (const file of files) {
        archive.file(file.fullPath, { name: file.relativePath })
      }
    } else {
      // 添加整个目录
      archive.directory(sourceDir, false)
    }

    // 完成压缩
    await archive.finalize()

    // 等待输出流关闭
    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve)
      output.on('error', reject)
    })
  } catch (err) {
    log.error('Failed to create ZIP:', err)
    throw new Error('创建ZIP文件失败')
  }
}

// ── 创建压缩包 ──

export async function createArchive(
  sourceDir: string,
  outputPath: string,
  format: string = 'zip',
  files?: Array<{ relativePath: string; fullPath: string }>,
): Promise<void> {
  switch (format) {
    case 'zip':
      await compressToZip(sourceDir, outputPath, files)
      break
    case 'tar':
      await compressToTar(sourceDir, outputPath, files)
      break
    default:
      throw new Error(`不支持的压缩格式: ${format}`)
  }
}

// ── TAR 压缩 ──

async function compressToTar(
  sourceDir: string,
  outputPath: string,
  files?: Array<{ relativePath: string; fullPath: string }>,
): Promise<void> {
  try {
    const tar = require('tar')

    if (files && files.length > 0) {
      // 添加指定文件
      await tar.create(
        {
          file: outputPath,
          gzip: outputPath.endsWith('.gz') || outputPath.endsWith('.tgz'),
          cwd: sourceDir,
        },
        files.map(f => f.relativePath),
      )
    } else {
      // 添加整个目录
      await tar.create(
        {
          file: outputPath,
          gzip: outputPath.endsWith('.gz') || outputPath.endsWith('.tgz'),
          cwd: sourceDir,
        },
        ['.'],
      )
    }
  } catch (err) {
    log.error('Failed to create tar:', err)
    throw new Error('创建tar文件失败')
  }
}

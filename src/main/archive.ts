import { createReadStream, createWriteStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, existsSync } from 'fs'
import { join, extname, dirname, resolve } from 'path'
import { finished, pipeline } from 'stream/promises'
import type { ArchiveFileInfo, ArchiveMeta } from '../shared/types'
import log from 'electron-log'
import { ARCHIVE_LIMITS, assertArchiveLimits, resolveArchiveEntryPath } from './archive-security'

export interface ArchiveOperationOptions {
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  throw error
}

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

async function withZipDirectory<T>(filePath: string, operation: (directory: any) => Promise<T>): Promise<T> {
  const unzipper = require('unzipper')
  const streams = new Set<ReturnType<typeof createReadStream>>()
  try {
    // Open.file resolves when metadata is parsed, before its underlying readers close.
    // Own those readers so listing, extraction and failure all release the ZIP first.
    const directory = await unzipper.Open.custom({
      size: async () => statSync(filePath).size,
      stream: (start: number, length?: number) => {
        const stream = createReadStream(filePath, { start, end: length ? start + length : undefined })
        streams.add(stream)
        stream.once('close', () => streams.delete(stream))
        return stream
      },
    })
    return await operation(directory)
  } finally {
    await Promise.all([...streams].map(stream => {
      const closed = finished(stream).catch(() => undefined)
      stream.destroy()
      return closed
    }))
  }
}

async function listZipFiles(filePath: string, _password?: string): Promise<{ files: ArchiveFileInfo[]; isEncrypted: boolean }> {
  try {
    return await withZipDirectory(filePath, async directory => {
      const files: ArchiveFileInfo[] = []
      let isEncrypted = false

      for (const entry of directory.files) {
        if (files.length >= ARCHIVE_LIMITS.maxEntries) throw new Error('压缩包文件数量超过限制')
        // 检测是否加密（encrypted bit in general purpose bit flag）
        if (entry.flags && (entry.flags & 0x01) !== 0) {
          isEncrypted = true
        }

        files.push({
          name: entry.path.split('/').pop() || entry.path,
          path: entry.path,
          size: entry.uncompressedSize || 0,
          isDir: entry.type === 'Directory',
          compressedSize: entry.compressedSize,
          modifiedAt: entry.lastModifiedDateTime ? new Date(entry.lastModifiedDateTime).getTime() : undefined,
        })
      }

      return { files, isEncrypted }
    })
  } catch (err) {
    log.error('Failed to list ZIP files:', err)
    throw new Error('无法读取ZIP文件内容')
  }
}

async function extractZip(filePath: string, outputDir: string, password?: string, files?: string[], runtime: ArchiveOperationOptions = {}): Promise<void> {
  try {
    await withZipDirectory(filePath, async directory => {
      const selectedEntries = directory.files.filter((entry: { path: string }) => !files || files.includes(entry.path))
      let completed = 0
      for (const entry of selectedEntries) {
        throwIfAborted(runtime.signal)
        // 如果指定了文件，只解压指定的文件
        const targetPath = resolveArchiveEntryPath(outputDir, entry.path)

        if (entry.type === 'Directory') {
          mkdirSync(targetPath, { recursive: true })
        } else {
          // 确保父目录存在
          const parentDir = join(targetPath, '..')
          mkdirSync(parentDir, { recursive: true })

          // 解压文件
          const readStream = entry.stream(password)
          const writeStream = createWriteStream(targetPath)
          await pipeline(readStream, writeStream, { signal: runtime.signal })
        }
        runtime.onProgress?.(++completed, selectedEntries.length)
      }
    })
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
      if (files.length >= ARCHIVE_LIMITS.maxEntries) throw new Error('压缩包文件数量超过限制')
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

async function extractRar(filePath: string, outputDir: string, password?: string, files?: string[], runtime: ArchiveOperationOptions = {}): Promise<void> {
  try {
    const unrar = require('node-unrar-js')
    const fs = require('fs')

    // 读取文件到 Buffer
    const buffer = fs.readFileSync(filePath)

    // 创建 Archive 对象
    const archive = await unrar.createExtractorFromData({ data: buffer, password: password || '' })

    // 解压文件
    throwIfAborted(runtime.signal)
    const extracted = archive.extract({ files: files || undefined })

    let completed = 0
    for (const file of extracted.files) {
      throwIfAborted(runtime.signal)
      const targetPath = resolveArchiveEntryPath(outputDir, file.fileHeader.name)

      if (file.fileHeader.flags?.directory) {
        mkdirSync(targetPath, { recursive: true })
      } else {
        // 确保父目录存在
        const parentDir = join(targetPath, '..')
        mkdirSync(parentDir, { recursive: true })

        // 写入文件
        fs.writeFileSync(targetPath, file.extraction)
      }
      runtime.onProgress?.(++completed, extracted.files.length)
    }
  } catch (err) {
    log.error('Failed to extract RAR:', err)
    throw new Error('解压RAR文件失败')
  }
}

// ── 7Z 解压 ──

/** Executables cannot be spawned from Electron's virtual ASAR filesystem. */
export function resolve7ZipExecutablePath(binaryPath: string): string {
  return binaryPath.replace(/([\\/])app\.asar(?=[\\/]node_modules[\\/]7zip-bin[\\/])/, '$1app.asar.unpacked')
}

async function list7zFiles(filePath: string, password?: string): Promise<ArchiveFileInfo[]> {
  try {
    const Seven = require('node-7z')
    const { path7za } = require('7zip-bin')
    const files: ArchiveFileInfo[] = []

    const stream = Seven.list(filePath, {
      $bin: resolve7ZipExecutablePath(path7za),
      password: password || '',
    })
    const result = await new Promise<any[]>((resolve, reject) => {
      const entries: any[] = []
      stream.on('data', (entry: any) => entries.push(entry))
      stream.once('error', reject)
      stream.once('end', () => resolve(entries))
    })

    for (const file of result) {
      if (files.length >= ARCHIVE_LIMITS.maxEntries) throw new Error('压缩包文件数量超过限制')
      if (!file.file) continue
      files.push({
        name: file.file.split('/').pop() || file.file,
        path: file.file,
        size: file.size || 0,
        isDir: typeof file.attributes === 'string' && file.attributes.startsWith('D'),
        compressedSize: file.sizeCompressed,
        modifiedAt: file.datetime ? new Date(file.datetime).getTime() : undefined,
      })
    }

    return files
  } catch (err) {
    log.error('Failed to list 7z files:', err)
    throw new Error('无法读取7z文件内容')
  }
}

async function extract7z(filePath: string, outputDir: string, password?: string, files?: string[], runtime: ArchiveOperationOptions = {}): Promise<void> {
  try {
    const Seven = require('node-7z')
    const { path7za } = require('7zip-bin')

    // 确保输出目录存在
    mkdirSync(outputDir, { recursive: true })

    throwIfAborted(runtime.signal)
    const stream = Seven.extractFull(filePath, outputDir, {
      $bin: resolve7ZipExecutablePath(path7za),
      password: password || '',
      $cherryPick: files || undefined,
    })
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        stream._childProcess?.kill()
        const error = new Error('操作已取消')
        error.name = 'AbortError'
        reject(error)
      }
      runtime.signal?.addEventListener('abort', abort, { once: true })
      let completed = 0
      stream.on('data', () => runtime.onProgress?.(++completed, 0))
      stream.once('error', reject)
      stream.once('end', () => {
        runtime.signal?.removeEventListener('abort', abort)
        resolve()
      })
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
        if (entries.length >= ARCHIVE_LIMITS.maxEntries) throw new Error('压缩包文件数量超过限制')
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
          throw new Error(`压缩包包含不允许的链接条目: ${entry.path}`)
        }
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

async function extractTar(filePath: string, outputDir: string, files?: string[], runtime: ArchiveOperationOptions = {}): Promise<void> {
  try {
    const tar = require('tar')

    // 确保输出目录存在
    mkdirSync(outputDir, { recursive: true })

    // 检查是否是压缩的tar
    const lower = filePath.toLowerCase()
    const isGzip = lower.endsWith('.gz') || lower.endsWith('.tgz')
    throwIfAborted(runtime.signal)
    let completed = 0
    const options: any = {
      file: filePath,
      cwd: outputDir,
      gzip: isGzip,
      signal: runtime.signal,
      onentry: () => runtime.onProgress?.(++completed, 0),
    }

    // 如果指定了文件，只解压指定的文件
    options.filter = (entryPath: string, entry: { type?: string }) => {
      throwIfAborted(runtime.signal)
      resolveArchiveEntryPath(outputDir, entryPath)
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        throw new Error(`压缩包包含不允许的链接条目: ${entryPath}`)
      }
      return !files || files.length === 0 || files.includes(entryPath)
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
  assertArchiveLimits(files)

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
  runtime: ArchiveOperationOptions = {},
): Promise<void> {
  throwIfAborted(runtime.signal)
  const format = getArchiveFormat(filePath)

  const meta = await listArchiveFiles(filePath, password)
  const requested = files?.length ? files : undefined
  if (requested && requested.some((entryPath) => !meta.files.some((file) => file.path === entryPath))) {
    throw new Error('选择的压缩包条目无效')
  }
  const selected = requested
    ? meta.files.filter((file) => requested.some((entryPath) => file.path === entryPath || file.path.startsWith(`${entryPath.replace(/\/$/, '')}/`)))
    : meta.files
  const selectedPaths = requested ? selected.map((file) => file.path) : undefined
  assertArchiveLimits(selected)

  // 确保输出目录存在
  mkdirSync(outputDir, { recursive: true })

  switch (format) {
    case 'zip':
      await extractZip(filePath, outputDir, password, selectedPaths, runtime)
      break
    case 'rar':
      await extractRar(filePath, outputDir, password, selectedPaths, runtime)
      break
    case '7z':
      await extract7z(filePath, outputDir, password, selectedPaths, runtime)
      break
    case 'tar':
      await extractTar(filePath, outputDir, selectedPaths, runtime)
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
  runtime: ArchiveOperationOptions = {},
): Promise<void> {
  let temporaryDirectory: string | undefined
  try {
    throwIfAborted(runtime.signal)
    const archiver = require('archiver')
    temporaryDirectory = mkdtempSync(join(dirname(outputPath), '.panlite-archive-'))
    const temporaryPath = join(temporaryDirectory, 'complete.zip')
    const inputs: Array<{ relativePath: string; fullPath: string }> = []
    if (files?.length) {
      inputs.push(...files)
    } else {
      const collect = (directory: string, prefix = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const fullPath = join(directory, entry.name)
          // Do not read our own output when it lives under the source directory.
          if (resolve(fullPath) === resolve(outputPath) || resolve(fullPath) === resolve(temporaryDirectory!)) continue
          const relativePath = prefix + entry.name
          inputs.push({ relativePath, fullPath })
          if (entry.isDirectory()) collect(fullPath, relativePath + '/')
        }
      }
      collect(sourceDir)
    }
    const output = createWriteStream(temporaryPath)
    const archive = archiver('zip', {
      zlib: { level: 6 }, // 压缩级别
    })

    // Missing inputs must fail the job instead of producing a successful partial archive.
    archive.on('warning', (err: Error) => archive.destroy(err))

    archive.on('progress', (progress: { entries?: { processed?: number; total?: number } }) => {
      runtime.onProgress?.(progress.entries?.processed || 0, inputs.length)
    })

    // Attach stream error/close and abort handling before finalization can emit events.
    const completion = pipeline(archive, output, { signal: runtime.signal })
    let input: ReturnType<typeof createReadStream> | undefined
    // Destroying archiver alone leaves its queue and input sources running.
    void completion.catch((error: Error) => {
      archive.abort()
      input?.destroy(error)
    })

    try {
      for (const file of inputs) {
        throwIfAborted(runtime.signal)
        const stats = lstatSync(file.fullPath)
        const data = { name: file.relativePath, mode: stats.mode, date: stats.mtime, stats }
        if (stats.isDirectory()) {
          archive.append(Buffer.alloc(0), { ...data, type: 'directory' })
        } else if (stats.isSymbolicLink()) {
          archive.symlink(file.relativePath, readlinkSync(file.fullPath), stats.mode)
        } else if (stats.isFile()) {
          input = createReadStream(file.fullPath, { signal: runtime.signal })
          const closed = finished(input)
          input.once('error', (error: Error) => archive.destroy(error))
          archive.append(input, data)
          // Only open one input at a time and wait for its descriptor to close.
          await closed
          input = undefined
        } else {
          throw new Error(`不支持的文件类型: ${file.relativePath}`)
        }
      }
      void archive.finalize().catch((error: Error) => archive.destroy(error))
    } catch (error) {
      archive.abort()
      archive.destroy(error as Error)
      if (input) {
        const closed = finished(input).catch(() => undefined)
        input.destroy()
        await closed
      }
    }
    await completion
    throwIfAborted(runtime.signal)
    renameSync(temporaryPath, outputPath)
  } catch (err) {
    log.error('Failed to create ZIP:', err)
    throw new Error('创建ZIP文件失败')
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

// ── 创建压缩包 ──

export async function createArchive(
  sourceDir: string,
  outputPath: string,
  format: string = 'zip',
  files?: Array<{ relativePath: string; fullPath: string }>,
  runtime: ArchiveOperationOptions = {},
): Promise<void> {
  throwIfAborted(runtime.signal)
  switch (format) {
    case 'zip':
      await compressToZip(sourceDir, outputPath, files, runtime)
      break
    case 'tar':
      await compressToTar(sourceDir, outputPath, files, runtime)
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
  runtime: ArchiveOperationOptions = {},
): Promise<void> {
  try {
    const tar = require('tar')
    throwIfAborted(runtime.signal)
    let completed = 0
    const onWriteEntry = () => runtime.onProgress?.(++completed, files?.length || 0)

    if (files && files.length > 0) {
      // 添加指定文件
      await tar.create(
        {
          file: outputPath,
          gzip: outputPath.endsWith('.gz') || outputPath.endsWith('.tgz'),
          cwd: sourceDir,
          signal: runtime.signal,
          onWriteEntry,
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
          signal: runtime.signal,
          onWriteEntry,
        },
        ['.'],
      )
    }
    throwIfAborted(runtime.signal)
  } catch (err) {
    log.error('Failed to create tar:', err)
    throw new Error('创建tar文件失败')
  }
}

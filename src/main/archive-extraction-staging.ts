import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ArchiveFileInfo } from '../shared/types'
import { normalizeArchiveEntryPath, resolveArchiveEntryPath } from './archive-security'
import { assertSafeDownloadTarget, prepareSafeDownloadRoot } from './download-target'
import { removeOwnedDirectory } from './owned-directory'
import log from 'electron-log'

interface Entry { path: string; size: number; isDir: boolean }
const identity = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

function extractionPlan(files: ArchiveFileInfo[]): { files: Map<string, Entry>; directories: Map<string, Entry> } {
  const entries = new Map<string, Entry>(), directories = new Map<string, Entry>(), regular = new Map<string, Entry>()
  for (const item of files) {
    const name = normalizeArchiveEntryPath(item.path), id = identity(name)
    if (entries.has(id)) throw new Error(`压缩包包含重复或冲突的路径: ${name}`)
    const entry = { path: name, size: item.size, isDir: item.isDir }
    entries.set(id, entry)
    if (item.isDir) directories.set(id, entry)
    else regular.set(id, entry)
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/'), parentId = identity(parent)
      if (!directories.has(parentId)) directories.set(parentId, { path: parent, size: 0, isDir: true })
    }
  }
  for (const [id, file] of regular) if (directories.has(id)) throw new Error(`压缩包文件与目录冲突: ${file.path}`)
  return { files: regular, directories }
}

function existing(path: string): Stats | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function checkDestinations(root: string, plan: ReturnType<typeof extractionPlan>): void {
  for (const item of [...plan.directories.values(), ...plan.files.values()]) {
    const target = resolveArchiveEntryPath(root, item.path)
    assertSafeDownloadTarget(root, target)
    const current = existing(target)
    if (item.isDir ? current && !current.isDirectory() : current) {
      throw new Error(`目标已存在同名文件或目录，未覆盖: ${item.path}`)
    }
  }
}

function verifyStaged(root: string, plan: ReturnType<typeof extractionPlan>): Map<string, string> {
  const found = new Map<string, string>()
  const foundDirectories = new Set<string>()
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name), stat = lstatSync(full)
      const name = relative(root, full).split(sep).join('/'), id = identity(name)
      if (stat.isSymbolicLink()) throw new Error('压缩包包含不允许的链接')
      if (stat.isDirectory()) {
        if (!plan.directories.has(id)) throw new Error(`压缩包包含未声明的目录: ${name}`)
        foundDirectories.add(id)
        walk(full)
      } else if (stat.isFile()) {
        const expected = plan.files.get(id)
        if (!expected || found.has(id) || stat.size !== expected.size) throw new Error(`解压文件与压缩包清单不一致: ${name}`)
        found.set(id, full)
      } else throw new Error('压缩包包含不支持的文件类型')
    }
  }
  walk(root)
  if (found.size !== plan.files.size || foundDirectories.size !== plan.directories.size) throw new Error('解压文件或目录不完整')
  return found
}

/** Stage every entry before publishing; existing destination files are never replaced. */
export async function stageArchiveExtraction(
  output: string,
  files: ArchiveFileInfo[],
  extract: (stage: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const root = resolve(output), plan = extractionPlan(files)
  prepareSafeDownloadRoot(root)
  checkDestinations(root, plan)
  const stage = mkdtempSync(join(root, '.panlite-extract-'))
  const owner = lstatSync(stage)
  let published = 0
  try {
    await extract(stage)
    if (signal?.aborted) throw new Error('操作已取消')
    const found = verifyStaged(stage, plan)
    checkDestinations(root, plan)
    try {
      const directories = [...plan.directories.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length)
      for (const directory of directories) {
        if (signal?.aborted) throw new Error('操作已取消')
        const target = resolveArchiveEntryPath(root, directory.path)
        assertSafeDownloadTarget(root, target)
        mkdirSync(target, { recursive: true })
        assertSafeDownloadTarget(root, target)
      }
      for (const [id, item] of plan.files) {
        if (signal?.aborted) throw new Error('操作已取消')
        const target = resolveArchiveEntryPath(root, item.path), source = found.get(id)!
        assertSafeDownloadTarget(root, target)
        try { linkSync(source, target) }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(code || '')) throw error
          // Filesystems without hard links still refuse to overwrite an existing file.
          try { copyFileSync(source, target, constants.COPYFILE_EXCL) }
          catch (copyError) { throw new Error(`无法完整写入新文件，目标目录可能有不完整的新文件: ${String(copyError)}`) }
        }
        published++
      }
    } catch (error) {
      if (published) throw new Error(`解压未全部完成；已写入 ${published} 个新文件，原有文件未覆盖: ${String(error)}`)
      throw error
    }
  } finally {
    try {
      const current = lstatSync(stage)
      assertSafeDownloadTarget(root, stage)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino || dirname(stage) !== root) throw new Error('临时目录身份发生变化')
      removeOwnedDirectory(stage, owner)
    } catch (error) { log.warn('Could not safely clean archive staging directory:', String(error)) }
  }
}

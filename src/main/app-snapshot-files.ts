import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { AppSnapshotEntry } from '../shared/app-snapshots'

export const SNAPSHOT_FORMAT = 'panlite-app-snapshot-v1'
export const SNAPSHOT_ROOTS = ['panlite.db', 'url-crypto.key', 'ai-attachments'] as const
export const RESTORE_ROOTS = ['panlite.db-wal', 'panlite.db-shm', 'panlite.db', 'url-crypto.key', 'ai-attachments'] as const
export const UUID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/
export class AppSnapshotError extends Error {
  constructor(message: string, readonly code = 'SNAPSHOT_INVALID') { super(message); this.name = 'AppSnapshotError' }
}
export const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
export async function exists(file: string): Promise<boolean> { try { await fsp.lstat(file); return true } catch (error) { if (absent(error)) return false; throw error } }
export const sha256Text = (text: string): string => createHash('sha256').update(text).digest('hex')
export function safeRelative(value: unknown, directory = false): string {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || path.posix.normalize(value) !== value
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new AppSnapshotError('快照包含不安全的相对路径')
  if (directory ? value !== 'ai-attachments' && !value.startsWith('ai-attachments/') : value !== 'panlite.db' && value !== 'url-crypto.key' && !value.startsWith('ai-attachments/')) throw new AppSnapshotError('快照包含受管范围以外的文件')
  return value
}
export async function syncFile(file: string): Promise<void> { const handle = await fsp.open(file, 'r+'); try { await handle.sync() } finally { await handle.close() } }
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fsp.open(directory, 'r'); try { await handle.sync() } finally { await handle.close() }
}
export async function durableJson(file: string, value: unknown, exclusive = false): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fsp.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  try {
    if (exclusive) await fsp.link(temporary, file)
    else await fsp.rename(temporary, file)
    await syncDirectory(path.dirname(file))
  } finally { await fsp.unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
}
export async function readJson(file: string, limit = 32 * 1024 * 1024): Promise<unknown> {
  const stat = await fsp.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new AppSnapshotError('快照清单不是安全的普通文件')
  return JSON.parse(await fsp.readFile(file, 'utf8')) as unknown
}
export async function regular(file: string, directory = false): Promise<void> {
  const stat = await fsp.lstat(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new AppSnapshotError('受管路径包含符号链接或错误的文件类型')
}
export async function fileDigest(file: string): Promise<AppSnapshotEntry> {
  await regular(file)
  const before = await fsp.stat(file), hash = createHash('sha256')
  let size = 0
  for await (const bytes of fs.createReadStream(file)) { size += bytes.length; hash.update(bytes) }
  const after = await fsp.stat(file)
  if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new AppSnapshotError('文件在快照过程中发生变化')
  return { path: '', size, sha256: hash.digest('hex') }
}
export async function tree(root: string): Promise<{ files: AppSnapshotEntry[]; directories: string[] }> {
  const files: AppSnapshotEntry[] = [], directories: string[] = []
  async function walk(relative: string): Promise<void> {
    const full = path.join(root, ...relative.split('/')), stat = await fsp.lstat(full)
    if (stat.isSymbolicLink()) throw new AppSnapshotError('快照不包含符号链接或目录联接')
    if (stat.isDirectory()) {
      safeRelative(relative, true); directories.push(relative)
      for (const name of (await fsp.readdir(full)).sort()) await walk(`${relative}/${name}`)
    } else {
      safeRelative(relative); files.push({ ...await fileDigest(full), path: relative })
    }
    if (files.length + directories.length > 100_000) throw new AppSnapshotError('快照附件数量超过支持范围')
  }
  for (const name of SNAPSHOT_ROOTS) if (await exists(path.join(root, name))) await walk(name)
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), directories: directories.sort() }
}
export async function copyVerified(source: string, target: string, entry: AppSnapshotEntry): Promise<void> {
  const relative = safeRelative(entry.path), from = path.join(source, ...relative.split('/')), to = path.join(target, ...relative.split('/'))
  await regular(from); await fsp.mkdir(path.dirname(to), { recursive: true })
  await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL); await syncFile(to)
  const actual = await fileDigest(to)
  if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new AppSnapshotError('文件复制后的校验不一致')
}
export async function ownedDirectory(parent: string, name: string): Promise<string> {
  const destination = path.join(parent, name)
  if (!await exists(destination)) {
    const staging = await fsp.mkdtemp(path.join(parent, '.snapshot-init-'))
    await durableJson(path.join(staging, 'owner.json'), { format: SNAPSHOT_FORMAT })
    try { await fsp.rename(staging, destination) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      await fsp.unlink(path.join(staging, 'owner.json')); await fsp.rmdir(staging)
    }
  }
  await regular(destination, true)
  const marker = await readJson(path.join(destination, 'owner.json'), 1024) as { format?: string }
  if (marker.format !== SNAPSHOT_FORMAT) throw new AppSnapshotError('拒绝使用不属于应用快照的目录')
  return destination
}
export async function removeOwnedChild(parent: string, name: string): Promise<void> {
  if (!/^[a-z][a-z-]*$/.test(name)) throw new AppSnapshotError('临时目录名称不安全')
  await regular(parent, true)
  const marker = await readJson(path.join(parent, 'owner.json'), 1024) as { format?: string }
  const child = path.resolve(parent, name)
  if (marker.format !== SNAPSHOT_FORMAT || path.dirname(child) !== path.resolve(parent)) throw new AppSnapshotError('拒绝清理范围外的目录')
  if (await exists(child)) { await regular(child, true); await fsp.rm(child, { recursive: true, force: true }) }
}

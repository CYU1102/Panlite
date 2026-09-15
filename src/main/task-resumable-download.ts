import fsp from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DriveAdapter, DriveDownloadSource } from '../adapters/base'
import type { DriveAccount, FileItem, TaskStatus } from '../shared/types'
import { extractSourceHash } from '../shared/cloud-transfer'
import {
  discardResumableDownload, resumableDownloadTo, ResumableDownloadBusyError, ResumableFallbackError, ResumableSourceChangedError,
  type ResumableDownloadOptions, type ResumableDownloadResult, type ResumableFetch,
} from './resumable-download'

export interface TaskResumableDownloadOptions {
  taskId: string
  account: DriveAccount
  fileId: string
  targetPath: string
  adapter: Pick<DriveAdapter, 'getDownloadSource' | 'getDownloadUrl'>
  /** Must obtain current provider metadata each time; do not return the saved task payload or catalog snapshot. */
  getFreshFile?: (context: { reason: 'start' | 'refresh' | 'verify'; signal: AbortSignal }) => Promise<FileItem>
  overwrite?: boolean
  /** A saved plan's content hash is a publication gate, not a source identity substitute. */
  expectedHash?: { algorithm: 'md5' | 'sha1' | 'sha256'; value: string }
  /** Positive task-known size must match fresh evidence; zero/omitted means unknown. */
  expectedSize?: number
  signal?: AbortSignal
  assertActive?: () => void
  getStatus?: () => TaskStatus | undefined
  /** Defaults to app.getPath('userData')/task-resume-v1. Tests inject an independent temporary directory. */
  cacheRoot?: string
  fetch?: ResumableFetch
  connections?: number
  chunkSize?: number
  retriesPerChunk?: number
  limiter?: ResumableDownloadOptions['limiter']
  speedLimitBps?: number
  onProgress?: ResumableDownloadOptions['onProgress']
  onCheckpoint?: ResumableDownloadOptions['onCheckpoint']
}
export type TaskResumableDownloadOutcome =
  | ({ kind: 'downloaded'; cacheCleanupPending?: true } & ResumableDownloadResult)
  | { kind: 'fallback'; reason: 'identity-unavailable' | 'range-unsupported' }

const TASK_FORMAT = 'panlite-task-resume-v1'
const HEX = /^[a-f\d]{64}$/
const live = new Set<string>()
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const exists = (error: unknown): boolean => ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '')
function identifier(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')) throw new Error('续传任务或文件标识无效')
  return digest(value)
}
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
async function cacheRoot(input?: string): Promise<string> {
  const root = input ?? path.join((await import('electron')).app.getPath('userData'), 'task-resume-v1')
  return path.resolve(root)
}
async function readMarker(file: string): Promise<Record<string, unknown>> {
  const stat = await fsp.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('续传缓存归属文件不安全')
  const data: unknown = JSON.parse(await fsp.readFile(file, 'utf8'))
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('续传缓存归属文件无效')
  return data as Record<string, unknown>
}
async function writeMarker(file: string, value: unknown): Promise<void> {
  const handle = await fsp.open(file, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
}
async function taskDirectory(root: string, taskDigest: string, create: boolean): Promise<string | undefined> {
  if (create) await fsp.mkdir(root, { recursive: true })
  let rootStat
  try { rootStat = await fsp.lstat(root) } catch (error) { if (missing(error) && !create) return undefined; throw error }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('续传缓存根目录不安全')
  const canonical = await fsp.realpath(root), directory = path.join(canonical, `task-${taskDigest}`)
  if (create) {
    const staging = await fsp.mkdtemp(path.join(canonical, '.new-task-'))
    try {
      await writeMarker(path.join(staging, 'task-owner.json'), { format: TASK_FORMAT, taskDigest })
      try { await fsp.rename(staging, directory) } catch (error) { if (!exists(error)) throw error }
    } finally {
      await fsp.unlink(path.join(staging, 'task-owner.json')).catch(error => { if (!missing(error)) throw error })
      await fsp.rmdir(staging).catch(error => { if (!missing(error)) throw error })
    }
  }
  let stat
  try { stat = await fsp.lstat(directory) } catch (error) { if (missing(error) && !create) return undefined; throw error }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(canonical, await fsp.realpath(directory))) throw new Error('续传任务缓存目录不安全')
  const owner = await readMarker(path.join(directory, 'task-owner.json'))
  if (owner.format !== TASK_FORMAT || owner.taskDigest !== taskDigest) throw new Error('拒绝使用其他任务的续传缓存')
  return directory
}
interface CacheRecord { format: 1; taskDigest: string; accountDigest: string; fileDigest: string; resumeKey: string }
function recordFor(taskDigest: string, accountDigest: string, fileDigest: string): CacheRecord {
  return { format: 1, taskDigest, accountDigest, fileDigest, resumeKey: JSON.stringify([TASK_FORMAT, taskDigest, accountDigest, fileDigest]) }
}
async function register(directory: string, record: CacheRecord): Promise<void> {
  const file = path.join(directory, `job-${digest(record.resumeKey)}.json`)
  const temporary = path.join(directory, `.job-${randomUUID()}.tmp`)
  try {
    await writeMarker(temporary, record)
    try { await fsp.link(temporary, file) } catch (error) {
      if (!exists(error)) throw error
      const previous = await readMarker(file)
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('续传缓存身份不匹配')
    }
  } finally { await fsp.unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
}
function strongEtag(value: string | null): string | undefined {
  return value && /^"[\x21\x23-\x7e]{1,1024}"$/.test(value) ? value : undefined
}
function contentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const size = Number(value)
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}
async function cancelBody(response: Response): Promise<void> { await response.body?.cancel().catch(() => undefined) }
async function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return (await import('electron')).net.fetch(url, init)
}
async function probe(source: DriveDownloadSource, fetcher: ResumableFetch, signal: AbortSignal): Promise<{ size: number; etag?: string }> {
  const headers = new Headers(source.headers)
  headers.set('Accept-Encoding', 'identity')
  const head = await fetcher(source.url, { method: 'HEAD', headers, signal })
  signal.throwIfAborted()
  const size = contentLength(head.headers.get('content-length')), etag = strongEtag(head.headers.get('etag'))
  await cancelBody(head)
  if (head.ok && size !== undefined && etag) return { size, etag }
  if (!head.ok && ![403, 404, 405, 501].includes(head.status)) throw new Error(`下载源元数据读取失败：HTTP ${head.status}`)
  headers.set('Range', 'bytes=0-0')
  const response = await fetcher(source.url, { headers, signal })
  try {
    signal.throwIfAborted()
    if (response.status === 200) throw new ResumableFallbackError('range-unsupported')
    if (response.status === 416 && head.ok && size === 0) return { size: 0, etag }
    if (response.status !== 206) throw new Error(`下载源范围探测失败：HTTP ${response.status}`)
    const range = /^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
    const total = range ? contentLength(range[1]) : undefined
    if (total === undefined || total < 1) throw new Error('下载源范围探测返回不正确')
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new Error('下载源范围响应使用了内容压缩')
    return { size: total, etag: strongEtag(response.headers.get('etag')) }
  } finally { await cancelBody(response) }
}
async function targetFile(file: string, overwrite: boolean): Promise<void> {
  try {
    const stat = await fsp.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('下载目标不是普通文件')
    if (!overwrite) throw new Error('下载目标已存在，未允许覆盖')
  } catch (error) { if (!missing(error)) throw error }
}

/** Returns fallback only for absent trustworthy identity or lack of Range support. Other failures must not start a full download. */
export async function downloadTaskResumable(options: TaskResumableDownloadOptions): Promise<TaskResumableDownloadOutcome> {
  const record = recordFor(identifier(options.taskId), identifier(options.account.id), identifier(options.fileId))
  if (typeof options.targetPath !== 'string' || !path.isAbsolute(options.targetPath)) throw new Error('下载目标必须是绝对路径')
  if (options.overwrite !== undefined && typeof options.overwrite !== 'boolean') throw new Error('覆盖选项必须是布尔值')
  if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0)) throw new Error('下载内容大小参数无效')
  const expectedSize = options.expectedSize !== undefined && options.expectedSize > 0 ? options.expectedSize : undefined
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const assertActive = (): void => {
    try {
      signal.throwIfAborted()
      options.assertActive?.()
      if (options.getStatus && options.getStatus() !== 'running') throw new Error('任务已暂停、取消或失去执行权')
    } catch (error) { controller.abort(error); throw error }
  }
  assertActive()
  const root = await cacheRoot(options.cacheRoot)
  const requestedParent = path.dirname(options.targetPath)
  await fsp.mkdir(requestedParent, { recursive: true })
  if ((await fsp.lstat(requestedParent)).isSymbolicLink()) throw new Error('下载目标目录不能是符号链接')
  const parent = await fsp.realpath(requestedParent), target = path.join(parent, path.basename(options.targetPath))
  if (inside(root, target)) throw new Error('下载目标不能位于续传缓存目录内')
  await targetFile(target, options.overwrite === true)
  const directory = (await taskDirectory(root, record.taskDigest, true))!
  const key = path.join(directory, digest(record.resumeKey))
  if (live.has(key)) throw new ResumableDownloadBusyError()
  live.add(key)
  const temporary = path.join(parent, `.panlite-task-download-${randomUUID()}`)
  const cache = { resumeRoot: path.join(directory, 'parts'), resumeKey: record.resumeKey }
  let published = false
  try {
    await register(directory, record)
    assertActive()
    const getSource: ResumableDownloadOptions['getSource'] = async context => {
      assertActive()
      const fresh = await options.getFreshFile?.(context)
      assertActive()
      if (fresh && (fresh.id !== options.fileId || fresh.accountId !== options.account.id || fresh.isDir
        || fresh.platform !== options.account.platform || !Number.isSafeInteger(fresh.size) || fresh.size < 0)) throw new ResumableSourceChangedError()
      if (fresh && expectedSize !== undefined && fresh.size !== expectedSize) throw new ResumableSourceChangedError()
      const hash = fresh ? extractSourceHash(options.account.platform, fresh.raw) : undefined
      let source: DriveDownloadSource
      if (options.adapter.getDownloadSource) source = await options.adapter.getDownloadSource(options.account, options.fileId)
      else if (options.adapter.getDownloadUrl) source = { url: await options.adapter.getDownloadUrl(options.account, options.fileId) }
      else return { url: '', totalSize: fresh?.size ?? 0 }
      assertActive()
      if (!source || typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) throw new Error('下载源地址无效')
      // The adapter's authenticated/custom transport takes precedence over the default transport for probes and bytes.
      const fetcher: ResumableFetch = source.fetch ? (url, init) => source.fetch!(url, init ?? {}) : options.fetch ?? defaultFetch
      if (hash && fresh) return { ...source, fetch: fetcher, totalSize: fresh.size, identity: { kind: 'hash', ...hash } }
      const evidence = await probe(source, fetcher, context.signal)
      assertActive()
      if (fresh && fresh.size !== evidence.size) throw new ResumableSourceChangedError()
      if (expectedSize !== undefined && evidence.size !== expectedSize) throw new ResumableSourceChangedError()
      return { ...source, fetch: fetcher, totalSize: evidence.size, identity: evidence.etag ? { kind: 'etag', value: evidence.etag } : undefined }
    }
    const result = await resumableDownloadTo({
      ...cache, targetPath: temporary, getSource, signal, retainCacheOnSuccess: true,
      getAbortDisposition: () => options.getStatus?.() === 'cancelled' ? 'cancel' : 'pause',
      connections: options.connections, chunkSize: options.chunkSize, retriesPerChunk: options.retriesPerChunk,
      limiter: options.limiter, speedLimitBps: options.speedLimitBps,
      onProgress: progress => { assertActive(); options.onProgress?.(progress); assertActive() },
      onCheckpoint: checkpoint => { assertActive(); options.onCheckpoint?.(checkpoint); assertActive() },
    })
    assertActive()
    if (options.expectedHash) {
      const expected = options.expectedHash
      if (!['md5', 'sha1', 'sha256'].includes(expected.algorithm) || !new RegExp(`^[a-f\\d]{${{ md5: 32, sha1: 40, sha256: 64 }[expected.algorithm]}}$`, 'i').test(expected.value)) throw new Error('下载内容校验参数无效')
      const hash = createHash(expected.algorithm)
      for await (const bytes of createReadStream(temporary, { signal })) { assertActive(); hash.update(bytes) }
      if (hash.digest('hex') !== expected.value.toLowerCase()) throw new ResumableSourceChangedError()
    }
    assertActive()
    await targetFile(target, options.overwrite === true)
    assertActive()
    // Both paths are on the target filesystem. A failed rename/link leaves the original target untouched.
    if (options.overwrite) await fsp.rename(temporary, target)
    else await fsp.link(temporary, target)
    published = true
    let cacheCleanupPending: true | undefined
    try { await discardResumableDownload(cache) } catch { cacheCleanupPending = true }
    return { ...result, kind: 'downloaded', localPath: target, ...(cacheCleanupPending ? { cacheCleanupPending } : {}) }
  } catch (error) {
    if (options.getStatus?.() === 'cancelled') await discardResumableDownload(cache)
    assertActive()
    if (error instanceof ResumableFallbackError && !signal.aborted) {
      // getSource can discover fallback before the core has a current identity; remove its older parts explicitly.
      await discardResumableDownload(cache)
      return { kind: 'fallback', reason: error.reason }
    }
    throw error
  } finally {
    live.delete(key)
    await fsp.unlink(temporary).catch(error => { if (!missing(error) && !published) throw error })
  }
}

/** Cancels all registered objects of a paused task. Unknown files and live attempts are preserved. */
export async function clearTaskResumeCache(taskId: string, options: { cacheRoot?: string } = {}): Promise<void> {
  const taskDigest = identifier(taskId), directory = await taskDirectory(await cacheRoot(options.cacheRoot), taskDigest, false)
  if (!directory) return
  const records: Array<{ file: string; record: CacheRecord }> = []
  for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!/^job-[a-f\d]{64}\.json$/.test(item.name)) continue
    const file = path.join(directory, item.name), raw = await readMarker(file)
    if (raw.format !== 1 || raw.taskDigest !== taskDigest || typeof raw.accountDigest !== 'string' || !HEX.test(raw.accountDigest)
      || typeof raw.fileDigest !== 'string' || !HEX.test(raw.fileDigest)) throw new Error('续传对象归属无效')
    const record = recordFor(taskDigest, raw.accountDigest, raw.fileDigest)
    if (raw.resumeKey !== record.resumeKey || item.name !== `job-${digest(record.resumeKey)}.json`) throw new Error('续传对象身份不匹配')
    if (live.has(path.join(directory, digest(record.resumeKey)))) throw new ResumableDownloadBusyError()
    records.push({ file, record })
  }
  for (const { file, record } of records) {
    await discardResumableDownload({ resumeRoot: path.join(directory, 'parts'), resumeKey: record.resumeKey })
    await fsp.unlink(file)
  }
}

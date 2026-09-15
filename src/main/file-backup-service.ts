import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem, Platform, TaskStatus } from '../shared/types'
import type { FileBackupsApi, FileBackupEntry, FileBackupJob, FileBackupPage, FileBackupPlan, FileBackupPlanInput, FileBackupPreviewItem, FileBackupResult, FileBackupSnapshot, FileRestorePreviewItem } from '../shared/file-backup'
import { FileBackupStore, type LocalBackupEvidence, type RestoreExisting, type StoredBackupPreview, type StoredRestorePreview, type StoredRetentionPreview } from './file-backup-store'

export class FileBackupError extends Error {
  constructor(message: string, readonly code = 'BACKUP_INVALID') { super(message); this.name = 'FileBackupError' }
}
export interface FileBackupDependencies {
  getAccount(accountId: string): DriveAccount | undefined
  getAdapter(platform: Platform): DriveAdapter
  getTaskStatus?(taskId: string): TaskStatus | undefined
  /** Must match the job's plan/kind/preview/snapshot payload; undefined means the durable queue was checked and no task exists. */
  findTaskByJob?(job: FileBackupJob): { taskId: string; status: TaskStatus } | undefined
  enqueueTask(input: { accountId: string; platform: 'webdav'; type: 'file_backup' | 'file_restore' | 'file_backup_prune'; title: string; payload: { planId: string; jobId: string; previewId: string; snapshotId?: string } }): string
  request?<T>(accountId: string, execute: () => Promise<T>, signal?: AbortSignal): Promise<T>
}
const activeStatuses = new Set<TaskStatus>(['pending', 'running', 'paused'])
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FileBackupError('参数格式不正确'); return value as Record<string, unknown> }
function text(value: unknown, label: string, max = 4096): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max) throw new FileBackupError(`${label}不正确`); return value }
function integer(value: unknown, label: string, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new FileBackupError(`${label}不正确`); return value }
function page(input: FileBackupPage): { page: number; pageSize: number } { return { page: input.page === undefined ? 1 : integer(input.page, '页码', 1, 1_000_000), pageSize: input.pageSize === undefined ? 50 : integer(input.pageSize, '每页条数', 1, 200) } }
const ordered = <T extends { relativePath: string }>(items: T[]): T[] => items.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
export const backupDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
export function backupFingerprint(entries: FileBackupEntry[]): string { return backupDigest(JSON.stringify(ordered(entries.map(entry => ({ relativePath: entry.relativePath, isDir: entry.isDir, size: entry.size, sha256: entry.sha256 }))))) }
export function backupInside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (allowRoot || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
export function backupRelative(value: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || (!allowRoot && !value) || value.split('/').some(part => part === '..' || part === '.' || part.includes(':')) || value.length > 16_384) throw new FileBackupError('快照包含不安全的相对路径')
  return value
}
export function backupLocalPath(root: string, relative: string, allowRoot = false): string {
  backupRelative(relative, allowRoot)
  const result = path.resolve(root, ...relative.split('/'))
  if (!backupInside(root, result, allowRoot)) throw new FileBackupError('文件路径越出了选定目录')
  return result
}
export async function assertBackupNoLinks(input: string, allowMissing = false): Promise<void> {
  const absolute = path.resolve(input), parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try { if ((await fsp.lstat(current)).isSymbolicLink()) throw new FileBackupError('不能跟随本地符号链接或目录联接', 'LOCAL_LINK') }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
}
function evidence(stat: fs.Stats): Pick<LocalBackupEvidence, 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs'> { return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } }
function sameStat(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory() }
/** Hashes through one open handle, optionally staging identical bytes, and rejects replacement/change while reading. */
export async function readStableBackupFile(file: string, signal?: AbortSignal, copyTo?: string): Promise<{ sha256: string; size: number } & Pick<LocalBackupEvidence, 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs'>> {
  signal?.throwIfAborted(); await assertBackupNoLinks(file)
  const before = await fsp.lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size)) throw new FileBackupError('备份源不是普通文件', 'LOCAL_FILE_CHANGED')
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let output: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    if (!sameStat(before, await handle.stat())) throw new FileBackupError('本地文件在打开时已变化', 'LOCAL_FILE_CHANGED')
    if (copyTo) output = await fsp.open(copyTo, 'wx', 0o600)
    const hash = createHash('sha256'); let size = 0
    for await (const bytes of handle.createReadStream({ autoClose: false, signal })) {
      signal?.throwIfAborted(); hash.update(bytes); size += bytes.length
      if (output) await output.writeFile(bytes)
    }
    signal?.throwIfAborted()
    if (!sameStat(before, await handle.stat()) || !sameStat(before, await fsp.lstat(file)) || size !== before.size) throw new FileBackupError('本地文件在读取期间变化，请重新预演', 'LOCAL_FILE_CHANGED')
    await assertBackupNoLinks(file)
    if (output) await output.sync()
    return { sha256: hash.digest('hex'), size, ...evidence(before) }
  } finally { await output?.close(); await handle.close() }
}
function glob(value: string): RegExp {
  let pattern = '^'
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '*' && value[index + 1] === '*') { index++; if (value[index + 1] === '/') { index++; pattern += '(?:.*/)?' } else pattern += '.*' }
    else if (char === '*') pattern += '[^/]*'
    else if (char === '?') pattern += '[^/]'
    else pattern += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(pattern + '(?:/.*)?$')
}
export async function scanBackupSource(plan: FileBackupPlan, signal?: AbortSignal): Promise<{ source: LocalBackupEvidence[]; excluded: FileBackupPreviewItem[]; failures: Array<{ path: string; error: string }> }> {
  await assertBackupNoLinks(plan.sourcePath)
  const root = await fsp.realpath(plan.sourcePath), rootStat = await fsp.lstat(root)
  if (!rootStat.isDirectory()) throw new FileBackupError('备份源必须是本地目录')
  const source: LocalBackupEvidence[] = [{ relativePath: '', isDir: true, size: 0, ...evidence(rootStat) }], excluded: FileBackupPreviewItem[] = [], failures: Array<{ path: string; error: string }> = []
  const patterns = plan.exclude.map(glob), queue = ['']
  for (let cursor = 0; cursor < queue.length; cursor++) {
    signal?.throwIfAborted()
    const relative = queue[cursor], current = backupLocalPath(root, relative, true)
    try {
      await assertBackupNoLinks(current)
      for (const child of await fsp.readdir(current, { withFileTypes: true })) {
        signal?.throwIfAborted()
        const relativePath = relative ? `${relative}/${child.name}` : child.name
        backupRelative(relativePath)
        if (patterns.some(pattern => pattern.test(relativePath) || pattern.test(relativePath + '/'))) { excluded.push({ relativePath, isDir: child.isDirectory(), size: 0, action: 'excluded', reason: '匹配排除规则' }); continue }
        if (source.length >= 200_000 || relativePath.split('/').length > 128) throw new FileBackupError('范围过大或层级过深，请缩小备份目录')
        const file = backupLocalPath(root, relativePath)
        try {
          const stat = await fsp.lstat(file)
          if (stat.isSymbolicLink()) throw new FileBackupError('符号链接或目录联接未备份，请明确排除该路径', 'LOCAL_LINK')
          if (stat.isDirectory()) { source.push({ relativePath, isDir: true, size: 0, ...evidence(stat) }); queue.push(relativePath) }
          else if (stat.isFile()) source.push({ relativePath, isDir: false, ...await readStableBackupFile(file, signal) })
          else throw new FileBackupError('不支持备份设备或特殊文件')
        } catch (error) { signal?.throwIfAborted(); failures.push({ path: relativePath, error: error instanceof FileBackupError ? error.message : '本地文件读取失败' }) }
      }
    } catch (error) { signal?.throwIfAborted(); failures.push({ path: relative, error: error instanceof FileBackupError ? error.message : '本地目录读取失败' }) }
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  // A file read early in traversal must still be the same object when the complete tree has been collected.
  for (const entry of source) {
    signal?.throwIfAborted()
    try {
      const current = backupLocalPath(root, entry.relativePath, entry.isDir), stat = await fsp.lstat(current)
      if (stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.mtimeMs !== entry.mtimeMs || stat.ctimeMs !== entry.ctimeMs
        || (entry.isDir ? !stat.isDirectory() : !stat.isFile() || stat.size !== entry.size)) throw new FileBackupError('源目录在扫描期间发生变化，请重新预演', 'LOCAL_FILE_CHANGED')
    } catch (error) { failures.push({ path: entry.relativePath, error: error instanceof FileBackupError ? error.message : '扫描结束前文件已删除或无法读取' }) }
  }
  return { source: ordered(source), excluded: ordered(excluded), failures }
}

export class FileBackupService implements FileBackupsApi {
  private readonly busy = new Set<string>()
  private readonly lifecycle = new AbortController()
  constructor(readonly store: FileBackupStore, readonly dependencies: FileBackupDependencies) {}
  dispose(): void { this.lifecycle.abort() }
  /** Bind existing durable queue records after startup; never enqueue or infer remote success. Call before starting the queue. */
  async recoverInterruptedJobs(): Promise<void> {
    if (!this.dependencies.findTaskByJob) return
    this.lifecycle.signal.throwIfAborted()
    for (const job of this.store.interruptedJobs()) {
      const task = this.dependencies.findTaskByJob(job)
      this.store.db.transaction(() => {
        if (!task) {
          const error = '启动核对未找到原任务；执行证据已保留，请重新预演，不会自动重新提交'
          this.store.patchJob(job.id, { taskId: undefined, status: 'failed', error })
          if (job.kind === 'backup' && job.snapshotId && this.store.snapshot(job.snapshotId)?.status !== 'ready') this.store.patchSnapshot(job.snapshotId, { taskId: undefined, status: 'failed', error })
          return
        }
        this.store.patchJob(job.id, { taskId: task.taskId })
        if (job.kind === 'backup' && job.snapshotId) this.store.patchSnapshot(job.snapshotId, { taskId: task.taskId })
        if (activeStatuses.has(task.status)) this.store.patchJob(job.id, { status: task.status === 'running' ? 'running' : 'queued', error: undefined })
        else {
          const confirmed = job.kind === 'backup' && job.snapshotId && this.store.snapshot(job.snapshotId)?.status === 'ready'
          // A queue success alone cannot create backup/restore/prune completion evidence.
          const error = '原任务已结束但此执行尚未确认完成；已保留记录，请检查任务或重新预演'
          this.store.patchJob(job.id, confirmed ? { status: 'completed', error: undefined } : { status: 'failed', error })
          if (!confirmed && job.kind === 'backup' && job.snapshotId) this.store.patchSnapshot(job.snapshotId, { status: 'failed', error })
        }
      })()
    }
  }
  private async result<T extends object>(execute: () => T | Promise<T>): Promise<FileBackupResult<T>> {
    try { this.lifecycle.signal.throwIfAborted(); return { success: true, ...await execute() } }
    catch (error) { return { success: false, error: error instanceof FileBackupError ? error.message : '文件备份操作失败，请检查目录、账号和任务状态', ...(error instanceof FileBackupError ? { code: error.code } : {}) } }
  }
  account(id: string): DriveAccount {
    const account = this.dependencies.getAccount(id)
    if (!account || account.platform !== 'webdav' || account.status !== 'active') throw new FileBackupError('此版本仅支持已登录且可读写的 WebDAV 账号', 'ACCOUNT_UNAVAILABLE')
    const adapter = this.dependencies.getAdapter('webdav')
    if (!adapter.upload || (!adapter.getDownloadSource && !adapter.getDownloadUrl) || !adapter.mkdir || !adapter.delete || !adapter.listFiles) throw new FileBackupError('WebDAV 账号缺少完整读写能力')
    return account
  }
  plan(id: string): FileBackupPlan { const plan = this.store.plan(text(id, '计划标识', 256)); if (!plan) throw new FileBackupError('备份计划不存在', 'PLAN_MISSING'); return plan }
  snapshot(id: string, ready = false): FileBackupSnapshot {
    const snapshot = this.store.snapshot(text(id, '快照标识', 256))
    if (!snapshot || snapshot.status === 'deleted') throw new FileBackupError('备份版本不存在', 'SNAPSHOT_MISSING')
    if (ready && snapshot.status !== 'ready') throw new FileBackupError('该版本尚未通过完整内容校验，不能恢复', 'SNAPSHOT_NOT_READY')
    if (ready) {
      const entries = this.store.entries(snapshot.id), manifest = this.store.manifestObject(snapshot.id)
      if (entries.length !== snapshot.fileCount + snapshot.directoryCount || backupFingerprint(entries) !== snapshot.fingerprint || manifest?.state !== 'verified') throw new FileBackupError('快照元数据与已校验版本不一致', 'SNAPSHOT_NOT_READY')
      for (const entry of entries) if (!entry.isDir) {
        const object = entry.objectId ? this.store.object(entry.objectId) : undefined
        if (!object || object.planId !== snapshot.planId || object.state !== 'verified' || object.sha256 !== entry.sha256 || object.size !== entry.size
          || !this.store.references(object.objectId).includes(snapshot.id)) throw new FileBackupError('版本引用的内容证据不一致', 'SNAPSHOT_NOT_READY')
      }
    }
    return snapshot
  }
  /** A no-change backup still reads every immutable object, so a missing/corrupt old version is never reported as a new successful backup. */
  async verifyReadySnapshot(snapshot: FileBackupSnapshot): Promise<void> {
    const plan = this.plan(snapshot.planId), account = this.account(plan.target.accountId), adapter = this.dependencies.getAdapter('webdav')
    const container = this.store.container(plan.id)
    if (!container.id) throw new FileBackupError('版本缺少已确认的远端目录', 'SNAPSHOT_NOT_READY')
    const files = await this.directory(account, container.id, this.lifecycle.signal)
    const corrupt = (objectId: string): never => {
      this.store.patchObject(objectId, { state: 'corrupt', error: '现有对象已丢失或内容不一致' })
      for (const id of this.store.references(objectId)) if (this.store.snapshot(id)?.status === 'ready') this.store.patchSnapshot(id, { status: 'damaged', error: '远端历史内容校验失败，请重新备份源文件' })
      throw new FileBackupError('历史备份缺失或内容变化，不能复用为成功备份，请重新预演', 'OBJECT_CORRUPT')
    }
    for (const object of this.store.snapshotObjects(snapshot.id)) {
      this.lifecycle.signal.throwIfAborted()
      const matches = files.filter(file => file.id === object.remoteId && file.name === object.name && !file.isDir)
      if (matches.length !== 1 || matches[0].size !== object.size) corrupt(object.objectId)
      const read = async (): Promise<void> => {
        const source = adapter.getDownloadSource ? await adapter.getDownloadSource(account, object.remoteId!) : { url: await adapter.getDownloadUrl!(account, object.remoteId!) }
        const response = await (source.fetch ? source.fetch(source.url, { headers: source.headers, signal: this.lifecycle.signal })
          : (await import('electron')).net.fetch(source.url, { headers: source.headers, signal: this.lifecycle.signal }))
        if (response.status === 404) { await response.body?.cancel().catch(() => undefined); corrupt(object.objectId) }
        if (!response.ok || response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => undefined); throw new FileBackupError('无法读取历史对象，未将本次备份判定为成功') }
        const hash = createHash('sha256'), reader = response.body.getReader(); let size = 0
        try {
          while (true) {
            this.lifecycle.signal.throwIfAborted()
            const chunk = await reader.read(); if (chunk.done) break
            size += chunk.value.byteLength
            if (size > object.size) corrupt(object.objectId)
            hash.update(chunk.value)
          }
        } finally { await reader.cancel().catch(() => undefined) }
        if (size !== object.size || hash.digest('hex') !== object.sha256) corrupt(object.objectId)
      }
      if (this.dependencies.request) await this.dependencies.request(account.id, read, this.lifecycle.signal); else await read()
    }
  }
  document<T extends StoredBackupPreview | StoredRestorePreview | StoredRetentionPreview>(id: string, kind: 'backup' | 'restore' | 'prune'): T {
    const document = this.store.preview<T>(text(id, '预演标识', 256), kind)
    if (!document) throw new FileBackupError('预演不存在，请重新预演', 'STALE_PREVIEW')
    return document
  }
  taskStatus(job: FileBackupJob): TaskStatus | undefined { return job.taskId ? this.dependencies.getTaskStatus?.(job.taskId) : undefined }
  assertIdle(planId: string): void {
    if (this.busy.has(planId)) throw new FileBackupError('该计划正在预演或提交，请稍后重试', 'PLAN_BUSY')
    for (const job of this.store.jobs(planId, null)) {
      const status = this.taskStatus(job)
      if ((status && activeStatuses.has(status)) || ((!job.taskId || !this.dependencies.getTaskStatus || status === undefined) && ['queued', 'running'].includes(job.status))) throw new FileBackupError('该计划仍有运行、排队或暂停的任务，请先处理任务', 'PLAN_BUSY')
    }
  }
  private async locked<T>(planId: string, execute: () => Promise<T>): Promise<T> {
    this.assertIdle(planId); this.busy.add(planId)
    try { return await execute() } finally { this.busy.delete(planId) }
  }
  async directory(account: DriveAccount, parentId: string, signal?: AbortSignal): Promise<FileItem[]> {
    signal?.throwIfAborted(); this.lifecycle.signal.throwIfAborted()
    const adapter = this.dependencies.getAdapter('webdav')
    const listing = await (this.dependencies.request ? this.dependencies.request(account.id, () => adapter.listFiles(account, parentId), signal) : adapter.listFiles(account, parentId))
    signal?.throwIfAborted()
    if (!listing || listing.hasMore !== false || listing.parentId !== parentId || !Array.isArray(listing.files)) throw new FileBackupError('WebDAV 目录列表不完整，不能确认写入或删除结果', 'INCOMPLETE_LISTING')
    const ids = new Set<string>()
    for (const file of listing.files) {
      if (!file || file.accountId !== account.id || file.platform !== 'webdav' || file.parentId !== parentId || typeof file.id !== 'string' || !file.id
        || ids.has(file.id) || typeof file.name !== 'string' || /[\/\\\0]/.test(file.name) || !file.name || typeof file.isDir !== 'boolean'
        || !Number.isSafeInteger(file.size) || file.size < 0) throw new FileBackupError('WebDAV 返回了不一致的对象信息', 'INCOMPLETE_LISTING')
      ids.add(file.id)
    }
    return listing.files
  }
  listPlans: FileBackupsApi['listPlans'] = () => this.result(() => ({ plans: this.store.plans() }))
  savePlan: FileBackupsApi['savePlan'] = value => this.result(async () => {
    const input = record(value), target = record(input.target), id = input.id === undefined ? undefined : text(input.id, '计划标识', 256)
    const sourcePath = path.resolve(text(input.sourcePath, '本地源目录'))
    if (!path.isAbsolute(String(input.sourcePath))) throw new FileBackupError('本地源目录必须是绝对路径')
    await assertBackupNoLinks(sourcePath)
    if (!(await fsp.lstat(sourcePath)).isDirectory()) throw new FileBackupError('本地源必须是目录')
    if (!Array.isArray(input.exclude) || input.exclude.length > 100) throw new FileBackupError('排除规则不正确')
    const exclude = [...new Set(input.exclude.map(item => {
      const rule = text(item, '排除规则', 512).trim().replace(/\\/g, '/')
      if (rule.startsWith('/') || rule.split('/').includes('..') || rule.includes(':')) throw new FileBackupError('排除规则必须是范围内的相对路径')
      glob(rule); return rule
    }))]
    const planInput: FileBackupPlanInput = { id, expectedVersion: id ? integer(input.expectedVersion, '计划版本', 1, Number.MAX_SAFE_INTEGER) : undefined,
      name: text(input.name, '计划名称', 100).trim(), sourcePath: await fsp.realpath(sourcePath),
      target: { accountId: text(target.accountId, '账号', 256), rootId: text(target.rootId, '目标目录'), rootPath: text(target.rootPath, '目标路径') },
      exclude, keepLast: integer(input.keepLast, '保留版本数', 1, 10_000), keepDays: integer(input.keepDays, '保留天数', 0, 36_500) }
    this.account(planInput.target.accountId)
    if (id) {
      this.assertIdle(id); const old = this.plan(id)
      if (old.version !== planInput.expectedVersion) throw new FileBackupError('计划已被更新，请刷新', 'PLAN_VERSION')
      if (this.store.snapshots(id, true).length && JSON.stringify(old.target) !== JSON.stringify(planInput.target)) throw new FileBackupError('已有版本的计划不能更换远端目标，请新建计划')
    } else if (this.store.plans().length >= 100) throw new FileBackupError('最多保存 100 个文件备份计划')
    return { plan: this.store.savePlan(planInput) }
  })
  removePlan: FileBackupsApi['removePlan'] = id => this.result(() => {
    this.plan(id); this.assertIdle(id)
    if (this.store.snapshots(id).length) throw new FileBackupError('仍有保留版本，请先明确预演并清理对应版本')
    this.store.removePlan(id); return {}
  })
  previewBackup: FileBackupsApi['previewBackup'] = id => this.result(() => this.locked(id, async () => {
    const plan = this.plan(id), account = this.account(plan.target.accountId)
    await this.directory(account, plan.target.rootId, this.lifecycle.signal)
    const scan = await scanBackupSource(plan, this.lifecycle.signal), fingerprint = backupFingerprint(scan.source)
    if (this.plan(id).version !== plan.version) throw new FileBackupError('计划已变化，请重新预演', 'STALE_PREVIEW')
    const previous = this.store.snapshots(id).find(snapshot => snapshot.status === 'ready')
    const items: FileBackupPreviewItem[] = scan.source.map(entry => {
      const object = entry.isDir ? undefined : this.store.findObject(id, entry.sha256!, entry.size)
      return { relativePath: entry.relativePath, isDir: entry.isDir, size: entry.size, sha256: entry.sha256,
        action: entry.isDir ? 'directory' : object?.state === 'verified' ? 'reuse' : 'upload', reason: object?.state === 'uncertain' || object?.state === 'dispatched' ? '已有未确认写入，将先只读核对，不自动重发' : undefined }
    })
    const fileItems = items.filter(item => !item.isDir), uploads = fileItems.filter(item => item.action === 'upload')
    const preview = { id: randomUUID(), planId: id, planVersion: plan.version, fingerprint, createdAt: this.store.now(), complete: !scan.failures.length,
      executable: !scan.failures.length, unchanged: !scan.failures.length && previous?.fingerprint === fingerprint, previousSnapshotId: previous?.id,
      fileCount: fileItems.length, directoryCount: items.length - fileItems.length, totalBytes: fileItems.reduce((sum, item) => sum + item.size, 0),
      uploadFiles: uploads.length, uploadBytes: uploads.reduce((sum, item) => sum + item.size, 0), reusedFiles: fileItems.length - uploads.length,
      excludedCount: scan.excluded.length, failures: scan.failures.slice(0, 100) }
    this.store.savePreview('backup', { preview, items: ordered([...items, ...scan.excluded]), source: scan.source })
    return { preview }
  }))
  getBackupPreview: FileBackupsApi['getBackupPreview'] = value => this.result(() => {
    const input = record(value), paging = page(input), document = this.document<StoredBackupPreview>(text(input.previewId, '预演'), 'backup')
    return { preview: document.preview, items: document.items.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize), total: document.items.length, ...paging }
  })
  executeBackup: FileBackupsApi['executeBackup'] = value => this.result(async () => {
    const input = record(value), planId = text(input.planId, '计划标识', 256)
    return this.locked(planId, async () => {
      const plan = this.plan(planId), document = this.document<StoredBackupPreview>(text(input.previewId, '预演'), 'backup')
      if (!document.preview.executable || document.preview.planId !== planId || document.preview.planVersion !== plan.version) throw new FileBackupError('备份预演不完整或已经过期', 'STALE_PREVIEW')
      const scan = await scanBackupSource(plan, this.lifecycle.signal)
      if (scan.failures.length || backupFingerprint(scan.source) !== document.preview.fingerprint) throw new FileBackupError('源内容已变化，请重新预演', 'STALE_PREVIEW')
      this.account(plan.target.accountId)
      if (document.preview.unchanged && document.preview.previousSnapshotId) {
        const snapshot = this.snapshot(document.preview.previousSnapshotId, true)
        if (snapshot.fingerprint !== document.preview.fingerprint) throw new FileBackupError('保留版本已变化，请重新预演', 'STALE_PREVIEW')
        await this.verifyReadySnapshot(snapshot)
        const afterVerification = await scanBackupSource(plan, this.lifecycle.signal)
        if (afterVerification.failures.length || backupFingerprint(afterVerification.source) !== snapshot.fingerprint) throw new FileBackupError('核对历史备份期间源文件变化，请重新预演', 'STALE_PREVIEW')
        return { snapshot, unchanged: true }
      }
      return this.store.db.transaction(() => {
        const snapshot = this.store.createSnapshot(plan, document), job = this.store.createJob(plan.id, document.preview.id, 'backup', snapshot.fileCount + 1, snapshot.id)
        const taskId = this.enqueue(plan, job, 'file_backup')
        return { snapshot: this.store.patchSnapshot(snapshot.id, { taskId }), taskId, unchanged: false }
      })()
    })
  })
  private enqueue(plan: FileBackupPlan, job: FileBackupJob, type: 'file_backup' | 'file_restore' | 'file_backup_prune'): string {
    const taskId = this.dependencies.enqueueTask({ accountId: plan.target.accountId, platform: 'webdav', type,
      title: `${type === 'file_backup' ? '文件备份' : type === 'file_restore' ? '恢复备份' : '清理备份版本'}：${plan.name}`,
      payload: { planId: plan.id, jobId: job.id, previewId: job.previewId, ...(job.snapshotId ? { snapshotId: job.snapshotId } : {}) } })
    this.store.patchJob(job.id, { taskId }); return taskId
  }
  listSnapshots: FileBackupsApi['listSnapshots'] = value => this.result(() => {
    const input = record(value), plan = this.plan(text(input.planId, '计划标识')), paging = page(input), snapshots = this.store.snapshots(plan.id)
    return { snapshots: snapshots.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize).map(snapshot => ({ ...snapshot, taskStatus: snapshot.taskId ? this.dependencies.getTaskStatus?.(snapshot.taskId) : undefined })), total: snapshots.length, ...paging }
  })
  getSnapshot: FileBackupsApi['getSnapshot'] = value => this.result(() => {
    const input = record(value), snapshot = this.snapshot(text(input.snapshotId, '快照标识')), paging = page(input)
    return { snapshot, entries: this.store.entryPage(snapshot.id, paging.page, paging.pageSize), total: snapshot.fileCount + snapshot.directoryCount, ...paging }
  })
  async restoreTarget(snapshot: FileBackupSnapshot, requested: string): Promise<string> {
    if (!path.isAbsolute(requested)) throw new FileBackupError('恢复目标必须是绝对路径')
    await assertBackupNoLinks(requested, true)
    let existing = path.resolve(requested); const segments: string[] = []
    while (true) {
      try { const stat = await fsp.lstat(existing); if (!stat.isDirectory()) throw new FileBackupError('恢复目标的上级不是目录'); break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; segments.unshift(path.basename(existing)); existing = path.dirname(existing) }
    }
    const result = path.join(await fsp.realpath(existing), ...segments), plan = this.plan(snapshot.planId)
    for (const source of [snapshot.sourcePath, plan.sourcePath]) if (backupInside(source, result, true) || backupInside(result, source, true)) throw new FileBackupError('恢复目录不能与原始备份源目录重叠')
    return result
  }
  restoreEntries(snapshot: FileBackupSnapshot, selection: unknown): { entries: FileBackupEntry[]; relativePaths?: string[] } {
    const entries = this.store.entries(snapshot.id)
    if (selection === undefined) return { entries }
    if (!Array.isArray(selection) || !selection.length || selection.length > 10_000) throw new FileBackupError('请选择 1 至 10000 个文件或目录', 'RESTORE_SCOPE_INVALID')
    const relativePaths = [...new Set(selection.map(value => backupRelative(value, true)))], all = new Map(entries.map(entry => [entry.relativePath, entry]))
    const selected = new Set(relativePaths), directories = new Set<string>(), ancestors = new Set<string>()
    for (const relative of relativePaths) {
      const entry = all.get(relative)
      if (!entry) throw new FileBackupError('所选路径不属于此版本，请刷新版本内容', 'RESTORE_SCOPE_INVALID')
      if (entry.isDir) directories.add(relative)
      let parent = relative
      while (parent) {
        parent = path.posix.dirname(parent); if (parent === '.') parent = ''
        if (!all.get(parent)?.isDir) throw new FileBackupError('版本缺少所选文件的父目录', 'SNAPSHOT_NOT_READY')
        ancestors.add(parent)
      }
    }
    return { relativePaths, entries: entries.filter(entry => {
      if (selected.has(entry.relativePath) || ancestors.has(entry.relativePath) || directories.has('')) return true
      let parent = entry.relativePath
      while (parent) { parent = path.posix.dirname(parent); if (parent === '.') parent = ''; if (directories.has(parent)) return true }
      return false
    }) }
  }
  validateRestoreScope(document: StoredRestorePreview, snapshot: FileBackupSnapshot): void {
    const entries = this.restoreEntries(snapshot, document.preview.relativePaths).entries
    if (backupFingerprint(entries) !== backupFingerprint(document.items) || entries.some((entry, index) => entry.objectId !== document.items[index]?.objectId)
      || document.preview.fileCount !== entries.filter(entry => !entry.isDir).length || document.preview.directoryCount !== entries.filter(entry => entry.isDir).length
      || document.preview.totalBytes !== entries.reduce((sum, entry) => sum + entry.size, 0)) throw new FileBackupError('恢复预演范围与所选版本不一致，请重新预演', 'STALE_PREVIEW')
  }
  previewRestore: FileBackupsApi['previewRestore'] = value => this.result(async () => {
    const input = record(value), snapshot = this.snapshot(text(input.snapshotId, '快照标识'), true)
    return this.locked(snapshot.planId, async () => {
      this.account(this.plan(snapshot.planId).target.accountId)
      if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') throw new FileBackupError('覆盖选项必须是布尔值')
      const overwrite = input.overwrite === true, targetPath = await this.restoreTarget(snapshot, text(input.targetPath, '恢复目录'))
      const selection = this.restoreEntries(snapshot, input.relativePaths)
      const existing: Record<string, RestoreExisting> = {}, items: FileRestorePreviewItem[] = [], failures: Array<{ path: string; error: string }> = []
      if (!overwrite) {
        try { if ((await fsp.readdir(targetPath)).length) failures.push({ path: '', error: '恢复目录必须是新目录或空目录；合并到已有目录须明确启用覆盖并核对预演' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      for (const entry of selection.entries) {
        const file = backupLocalPath(targetPath, entry.relativePath, entry.isDir)
        let action: FileRestorePreviewItem['action'] = entry.isDir ? 'directory' : 'create', reason: string | undefined
        try {
          await assertBackupNoLinks(file, true)
          const stat = await fsp.lstat(file)
          if (entry.isDir && stat.isDirectory()) { /* existing directory is preserved */ }
          else if (!entry.isDir && stat.isFile() && overwrite) { action = 'overwrite'; existing[entry.relativePath] = await readStableBackupFile(file, this.lifecycle.signal) }
          else { action = 'blocked'; reason = '目标类型冲突或未允许覆盖，不会递归删除目录' }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { action = 'blocked'; reason = error instanceof FileBackupError ? error.message : '目标路径无法安全检查' }
        }
        if (action === 'blocked') failures.push({ path: entry.relativePath, error: reason! })
        items.push({ ...entry, action, reason })
      }
      const preview = { id: randomUUID(), snapshotId: snapshot.id, planId: snapshot.planId, targetPath, overwrite, createdAt: this.store.now(), executable: !failures.length,
        relativePaths: selection.relativePaths, fileCount: items.filter(item => !item.isDir).length, directoryCount: items.filter(item => item.isDir).length,
        totalBytes: items.reduce((sum, item) => sum + item.size, 0), overwriteCount: items.filter(item => item.action === 'overwrite').length, failures: failures.slice(0, 100) }
      this.store.savePreview('restore', { preview, items, existing, fingerprint: snapshot.fingerprint })
      return { preview }
    })
  })
  getRestorePreview: FileBackupsApi['getRestorePreview'] = value => this.result(() => {
    const input = record(value), paging = page(input), document = this.document<StoredRestorePreview>(text(input.previewId, '预演'), 'restore')
    return { preview: document.preview, items: document.items.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize), total: document.items.length, ...paging }
  })
  executeRestore: FileBackupsApi['executeRestore'] = id => this.result(() => {
    const document = this.document<StoredRestorePreview>(id, 'restore'), snapshot = this.snapshot(document.preview.snapshotId, true), plan = this.plan(snapshot.planId)
    this.assertIdle(plan.id); this.account(plan.target.accountId)
    if (!document.preview.executable || snapshot.fingerprint !== document.fingerprint) throw new FileBackupError('恢复预演已失效，请重新预演', 'STALE_PREVIEW')
    this.validateRestoreScope(document, snapshot)
    return this.store.db.transaction(() => {
      const job = this.store.createJob(plan.id, id, 'restore', document.items.length, snapshot.id), taskId = this.enqueue(plan, job, 'file_restore')
      return { job: this.store.job(job.id)!, taskId }
    })()
  })
  retentionFingerprint(planId: string): string {
    return backupDigest(JSON.stringify(this.store.snapshots(planId).map(snapshot => ({ id: snapshot.id, status: snapshot.status, fingerprint: snapshot.fingerprint,
      objects: this.store.snapshotObjects(snapshot.id).map(object => ({ id: object.objectId, state: object.state, remoteId: object.remoteId, sha256: object.sha256, size: object.size, references: this.store.references(object.objectId) })) }))))
  }
  retentionPreview: FileBackupsApi['retentionPreview'] = value => this.result(() => {
    const input = record(value), plan = this.plan(text(input.planId, '计划标识')); this.assertIdle(plan.id)
    const snapshots = this.store.snapshots(plan.id), ready = snapshots.filter(snapshot => snapshot.status === 'ready')
    let ids: string[]
    if (input.snapshotIds !== undefined) {
      if (!Array.isArray(input.snapshotIds) || input.snapshotIds.length > 10_000) throw new FileBackupError('版本选择不正确')
      ids = [...new Set(input.snapshotIds.map(id => text(id, '快照标识', 256)))]
      if (ids.some(id => !snapshots.some(snapshot => snapshot.id === id))) throw new FileBackupError('选择的版本不属于该计划')
    } else {
      const protectedIds = new Set(ready.slice(0, plan.keepLast).map(snapshot => snapshot.id))
      const threshold = this.store.now() - plan.keepDays * 86_400_000
      ids = ready.filter(snapshot => !protectedIds.has(snapshot.id) && !(plan.keepDays > 0 && snapshot.createdAt >= threshold)).map(snapshot => snapshot.id)
    }
    const selected = new Set(ids), warnings: string[] = []
    if (ready.length && ready.every(snapshot => selected.has(snapshot.id))) warnings.push('本次显式选择包含最后一个可恢复版本；执行后该计划将没有可恢复备份')
    const objects = [...new Map(ids.flatMap(id => this.store.snapshotObjects(id)).map(object => [object.objectId, object])).values()]
      .filter(object => this.store.references(object.objectId).every(id => selected.has(id)))
      .map(object => ({ objectId: object.objectId, name: object.name, sha256: object.sha256, size: object.size, state: object.state, referenceCount: object.referenceCount }))
    if (objects.some(object => ['dispatched', 'uncertain', 'deleting'].includes(object.state))) warnings.push('存在未知远端写入或删除，只能先核对，不能承诺清理完成')
    const preview = { id: randomUUID(), planId: plan.id, planVersion: plan.version, createdAt: this.store.now(), executable: !!ids.length,
      snapshotIds: ids, retainedSnapshotCount: snapshots.length - ids.length, objectCount: objects.length,
      reclaimBytes: objects.filter(object => object.state !== 'pending' && object.state !== 'deleted').reduce((sum, object) => sum + object.size, 0), warnings }
    this.store.savePreview('prune', { preview, objects, fingerprint: this.retentionFingerprint(plan.id) })
    return { preview }
  })
  getRetentionPreview: FileBackupsApi['getRetentionPreview'] = value => this.result(() => {
    const input = record(value), paging = page(input), document = this.document<StoredRetentionPreview>(text(input.previewId, '预演'), 'prune')
    return { preview: document.preview, objects: document.objects.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize), total: document.objects.length, ...paging }
  })
  prune: FileBackupsApi['prune'] = id => this.result(() => {
    const document = this.document<StoredRetentionPreview>(id, 'prune'), plan = this.plan(document.preview.planId)
    this.assertIdle(plan.id); this.account(plan.target.accountId)
    if (!document.preview.executable || document.preview.planVersion !== plan.version || document.fingerprint !== this.retentionFingerprint(plan.id)) throw new FileBackupError('版本或引用关系已变化，请重新预演清理', 'STALE_PREVIEW')
    return this.store.db.transaction(() => { const job = this.store.createJob(plan.id, id, 'prune', document.objects.length), taskId = this.enqueue(plan, job, 'file_backup_prune'); return { job: this.store.job(job.id)!, taskId } })()
  })
  listJobs: FileBackupsApi['listJobs'] = id => this.result(() => { this.plan(id); return { jobs: this.store.jobs(id).map(job => ({ ...job, taskStatus: this.taskStatus(job) })) } })
  getJob: FileBackupsApi['getJob'] = value => this.result(() => {
    const input = record(value), paging = page(input), job = this.store.job(text(input.jobId, '执行记录'))
    if (!job) throw new FileBackupError('执行记录不存在')
    const items = this.store.jobItems(job.id)
    return { job: { ...job, taskStatus: this.taskStatus(job) }, items: items.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize), total: items.length, ...paging }
  })
}

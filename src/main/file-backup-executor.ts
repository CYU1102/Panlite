import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem } from '../shared/types'
import type { FileBackupJob, FileBackupPlan } from '../shared/file-backup'
import type { TaskExtensionContext } from './task-extensions'
import { guardTaskAdapterMutations } from './task-operations'
import { assertBackupNoLinks, backupDigest, backupFingerprint, backupInside, backupLocalPath, FileBackupError, FileBackupService, readStableBackupFile, scanBackupSource } from './file-backup-service'
import type { BackupObject, StoredBackupPreview, StoredRestorePreview, StoredRetentionPreview } from './file-backup-store'

export interface FileBackupDownloadInput {
  context: TaskExtensionContext; account: DriveAccount; adapter: DriveAdapter; file: FileItem; targetPath: string; expectedSha256: string
  onProgress: (progress: { loaded: number; percent: number; speed: number }) => void
}
export interface FileBackupExecutorDependencies {
  service: FileBackupService
  tempRoot?: string | (() => string)
  download?: (input: FileBackupDownloadInput) => Promise<void>
}
const uncertain = (): FileBackupError => new FileBackupError('远端写入或删除结果待核对；本次不会自动重发', 'REMOTE_RESULT_UNCERTAIN')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const scheduleDeferred = (error: unknown): boolean => (error as { code?: string })?.code === 'TASK_SCHEDULE_DEFERRED'
function claim(context: TaskExtensionContext, dependencies: FileBackupExecutorDependencies, kind: FileBackupJob['kind']): { job: FileBackupJob; plan: FileBackupPlan; token: string } {
  context.assertActive()
  const payload = JSON.parse(context.task.payload) as { planId?: string; jobId?: string; previewId?: string; snapshotId?: string }
  if (!payload.planId || !payload.jobId || !payload.previewId || !context.task.execution_token) throw new FileBackupError('文件备份任务参数不完整')
  const { service } = dependencies, job = service.store.job(payload.jobId), plan = service.plan(payload.planId)
  if (!job || job.kind !== kind || job.planId !== plan.id || job.previewId !== payload.previewId || job.snapshotId !== payload.snapshotId || context.task.account_id !== plan.target.accountId) throw new FileBackupError('任务与备份计划不一致')
  return { plan, token: context.task.execution_token, job: service.store.claimJob(job.id, context.task.id, context.task.execution_token) }
}
async function cleanupTemporary(directory: string | undefined, root: string | undefined): Promise<void> {
  if (!directory || !root) return
  const absolute = path.resolve(directory)
  if (!backupInside(root, absolute) || !path.basename(absolute).startsWith('panlite-file-backup-')) throw new FileBackupError('拒绝清理归属不明的临时目录')
  const stat = await fsp.lstat(absolute)
  if (stat.isSymbolicLink()) throw new FileBackupError('临时目录已被替换为链接')
  await fsp.rm(absolute, { recursive: true, force: true })
}
function execution(dependencies: FileBackupExecutorDependencies, context: TaskExtensionContext, plan: FileBackupPlan, job: FileBackupJob, token: string) {
  const { service } = dependencies, { store } = service, account = service.account(plan.target.accountId)
  const adapter = guardTaskAdapterMutations(service.dependencies.getAdapter('webdav'))
  let temporary: string | undefined, temporaryRoot: string | undefined
  const assert = (): void => { context.assertActive(); store.assertOwner(job.id, token) }
  const request = async <T>(execute: () => Promise<T>): Promise<T> => {
    assert()
    const value = await (service.dependencies.request ? service.dependencies.request(account.id, execute, context.signal) : execute())
    assert(); return value
  }
  const temp = async (): Promise<string> => {
    if (!temporary) {
      const base = typeof dependencies.tempRoot === 'function' ? dependencies.tempRoot() : dependencies.tempRoot ?? os.tmpdir()
      await assertBackupNoLinks(base, true); await fsp.mkdir(base, { recursive: true }); temporaryRoot = await fsp.realpath(base)
      if (backupInside(plan.sourcePath, temporaryRoot, true)) throw new FileBackupError('备份临时目录不能位于源目录树内')
      temporary = await fsp.mkdtemp(path.join(temporaryRoot, 'panlite-file-backup-'))
    }
    return temporary
  }
  const directory = async (id: string): Promise<FileItem[]> => { const files = await service.directory(account, id, context.signal); assert(); return files }
  const patchObject = (id: string, patch: Parameters<typeof store.patchObject>[1]): BackupObject => { assert(); return store.patchObject(id, patch) }
  const recordSuccess = (itemId: string, relativePath: string): void => {
    assert(); store.putJobItem(job.id, { itemId, path: relativePath, status: 'success' }, token)
    context.progress(Math.min(99, store.job(job.id)!.completedItems / Math.max(1, job.totalItems) * 99), `已确认：${relativePath || '根目录'}`)
  }
  const download = dependencies.download ?? (async (input: FileBackupDownloadInput): Promise<void> => {
    if (!input.adapter.download) throw new FileBackupError('WebDAV 账号不支持下载校验')
    const result = await input.adapter.download(input.account, input.file.id, path.dirname(input.targetPath), { signal: context.signal, fileName: path.basename(input.targetPath), onProgress: input.onProgress })
    assert()
    if (!result.success || !result.localPath || path.resolve(result.localPath) !== path.resolve(input.targetPath)) throw new FileBackupError('下载未成功或返回了范围外的本地路径')
  })
  const markCorrupt = (object: BackupObject): never => {
    patchObject(object.objectId, { state: 'corrupt', error: '远端对象内容与保存的 SHA256 不一致' })
    for (const snapshotId of store.references(object.objectId)) if (store.snapshot(snapshotId)?.status === 'ready') store.patchSnapshot(snapshotId, { status: 'damaged', error: '引用的远端对象未通过内容校验' })
    throw new FileBackupError('远端备份对象内容校验失败，不能标记为可恢复', 'OBJECT_CORRUPT')
  }
  const locate = async (object: BackupObject, containerId: string): Promise<FileItem | undefined> => {
    const files = await directory(containerId), named = files.filter(file => file.name === object.name)
    if (named.length > 1 || (named[0] && (named[0].isDir || (object.remoteId && named[0].id !== object.remoteId)))) throw uncertain()
    return named[0]
  }
  const verify = async (object: BackupObject, containerId: string, targetPath?: string): Promise<BackupObject> => {
    const file = await locate(object, containerId)
    if (!file) throw uncertain()
    if (file.size !== object.size) return markCorrupt(object)
    const local = targetPath ?? path.join(await temp(), `verify-${randomUUID()}.bin`)
    try {
      await download({ context, account, adapter, file, targetPath: local, expectedSha256: object.sha256,
        onProgress: progress => { assert(); context.progress(Math.min(99, store.job(job.id)!.completedItems / Math.max(1, job.totalItems) * 99), `校验 ${object.name} (${Math.round(progress.percent)}%)`) } })
      assert()
      const actual = await readStableBackupFile(local, context.signal)
      assert()
      if (actual.sha256 !== object.sha256 || actual.size !== object.size) return markCorrupt(object)
      return patchObject(object.objectId, { state: 'verified', remoteId: file.id, verifiedAt: store.now(), error: undefined })
    } finally { if (!targetPath) await fsp.unlink(local).catch(error => { if (!missing(error)) throw error }) }
  }
  const container = async (create: boolean): Promise<string> => {
    const state = store.container(plan.id), name = `panlite-backup-${plan.id}`
    const matches = (await directory(plan.target.rootId)).filter(file => file.name === name)
    if (matches.length > 1 || (matches[0] && !matches[0].isDir)) throw uncertain()
    if (state.id) {
      if (matches.length !== 1 || matches[0].id !== state.id) throw new FileBackupError('备份专属目录已经变化或丢失', 'REMOTE_RESULT_UNCERTAIN')
      return state.id
    }
    if (matches.length) {
      if (state.state === 'pending') throw new FileBackupError('远端已有同名目录，但未记录属于该计划，拒绝接管')
      assert(); store.setContainer(plan.id, 'verified', matches[0].id); return matches[0].id
    }
    if (!create || state.state !== 'pending') throw uncertain()
    try {
      const result = await context.operation('创建备份专属目录', plan.id, async () => {
        const created = await request(() => {
          assert(); store.setContainer(plan.id, 'dispatched')
          return adapter.mkdir(account, plan.target.rootId, name)
        })
        const confirmed = (await directory(plan.target.rootId)).filter(file => file.id === created.id && file.name === name && file.isDir)
        if (confirmed.length !== 1) throw uncertain()
        assert(); store.setContainer(plan.id, 'verified', confirmed[0].id)
        return { id: confirmed[0].id }
      })
      assert(); store.setContainer(plan.id, 'verified', result.id); return result.id
    } catch (error) {
      if (scheduleDeferred(error)) throw error
      try { store.assertOwner(job.id, token); if (store.container(plan.id).state !== 'verified') store.setContainer(plan.id, 'uncertain') } catch { /* A replacement attempt owns subsequent evidence. */ }
      throw error
    }
  }
  const ensureObject = async (object: BackupObject, containerId: string, getLocal: () => Promise<string>): Promise<{ object: BackupObject; uploaded: boolean }> => {
    assert()
    if (object.state === 'verified') return { object: await verify(object, containerId), uploaded: false }
    if (['dispatched', 'uncertain'].includes(object.state)) return { object: await verify(object, containerId), uploaded: false }
    if (object.state !== 'pending') throw new FileBackupError('备份对象状态不允许写入，请重新预演', 'OBJECT_CORRUPT')
    if (await locate(object, containerId)) throw new FileBackupError('远端已有未登记的同名对象，拒绝覆盖', 'REMOTE_RESULT_UNCERTAIN')
    const local = await getLocal()
    assert()
    let dispatched = false
    try {
      const saved = await context.operation('写入不可变备份对象', object.objectId, async () => {
        if (await locate(object, containerId)) throw uncertain()
        const uploaded = await request(() => {
          assert(); patchObject(object.objectId, { state: 'dispatched' }); dispatched = true
          return adapter.upload!(account, local, containerId, { fileName: object.name, overwrite: false, signal: context.signal })
        })
        if (!uploaded.success) throw uncertain()
        const found = await locate(object, containerId)
        if (!found || (uploaded.fileId && found.id !== uploaded.fileId)) throw uncertain()
        const confirmed = await verify({ ...object, remoteId: found.id }, containerId)
        return { objectId: confirmed.objectId, remoteId: confirmed.remoteId, verifiedAt: confirmed.verifiedAt }
      })
      assert()
      if (!saved || saved.objectId !== object.objectId || !saved.remoteId) throw uncertain()
      return { object: patchObject(object.objectId, { state: 'verified', remoteId: saved.remoteId, verifiedAt: saved.verifiedAt, error: undefined }), uploaded: true }
    } catch (error) {
      if (scheduleDeferred(error)) throw error
      try {
        store.assertOwner(job.id, token)
        const current = store.object(object.objectId)
        if (dispatched && current && !['verified', 'corrupt'].includes(current.state)) store.patchObject(object.objectId, { state: 'uncertain', error: '写入已经发出，必须读取远端内容核对后才能继续' })
      } catch { /* Old attempts cannot overwrite replacement-owner evidence. */ }
      throw error
    }
  }
  return { service, store, account, adapter, assert, request, directory, temp, container, locate, verify, ensureObject, recordSuccess,
    cleanup: async (): Promise<void> => cleanupTemporary(temporary, temporaryRoot) }
}
function failJob(dependencies: FileBackupExecutorDependencies, context: TaskExtensionContext, job: FileBackupJob, token: string, error: unknown): void {
  if (scheduleDeferred(error)) return
  const { store } = dependencies.service
  try {
    store.assertOwner(job.id, token)
    if (context.signal.aborted) return
    context.assertActive()
    const unresolved = error instanceof FileBackupError && error.code === 'REMOTE_RESULT_UNCERTAIN' || (error as { code?: string })?.code === 'REMOTE_RESULT_UNCERTAIN'
    const message = error instanceof FileBackupError ? error.message : '备份任务未完成，已保留执行记录与历史对象'
    store.patchJob(job.id, { status: unresolved ? 'uncertain' : 'failed', error: message }, token)
    if (job.kind === 'backup' && job.snapshotId && store.snapshot(job.snapshotId)?.status !== 'ready') store.patchSnapshot(job.snapshotId, { status: unresolved ? 'uncertain' : 'failed', error: message })
  } catch { /* An interrupted or superseded attempt cannot change current task evidence. */ }
}

/** Local source -> immutable WebDAV objects, entered only through the existing task queue. */
export async function executeFileBackupTask(context: TaskExtensionContext, dependencies: FileBackupExecutorDependencies): Promise<{ summary: string }> {
  const { job, plan, token } = claim(context, dependencies, 'backup'), scope = execution(dependencies, context, plan, job, token)
  const { store, service } = scope, snapshot = service.snapshot(job.snapshotId!), document = service.document<StoredBackupPreview>(job.previewId, 'backup')
  try {
    if (snapshot.planVersion !== plan.version || document.preview.planVersion !== plan.version || snapshot.fingerprint !== document.preview.fingerprint) throw new FileBackupError('备份计划版本已变化，请重新预演', 'STALE_PREVIEW')
    if (snapshot.status === 'ready') { store.patchJob(job.id, { status: 'completed' }, token); return { summary: '该版本已经完整校验，复用成功记录' } }
    const initial = await scanBackupSource(plan, context.signal)
    scope.assert()
    if (initial.failures.length || backupFingerprint(initial.source) !== snapshot.fingerprint) throw new FileBackupError('备份开始前源目录发生变化，请重新预演', 'STALE_PREVIEW')
    store.patchSnapshot(snapshot.id, { status: 'running', error: undefined })
    const containerId = await scope.container(true), entries = store.entries(snapshot.id), handled = new Set<string>()
    let uploadedFiles = snapshot.uploadedFiles, reusedFiles = 0
    for (const entry of entries) {
      scope.assert()
      if (entry.isDir) continue
      const object = store.object(entry.objectId!)!
      if (handled.has(object.objectId)) { reusedFiles++; scope.recordSuccess(entry.relativePath, entry.relativePath); continue }
      let staged: string | undefined
      try {
        const outcome = await scope.ensureObject(object, containerId, async () => {
          staged = path.join(await scope.temp(), `upload-${randomUUID()}.bin`)
          const actual = await readStableBackupFile(backupLocalPath(plan.sourcePath, entry.relativePath), context.signal, staged)
          scope.assert()
          if (actual.sha256 !== entry.sha256 || actual.size !== entry.size) throw new FileBackupError('上传前源文件变化，请重新预演', 'LOCAL_FILE_CHANGED')
          return staged
        })
        if (outcome.uploaded) uploadedFiles++; else reusedFiles++
        handled.add(object.objectId); scope.recordSuccess(entry.relativePath, entry.relativePath)
        store.patchSnapshot(snapshot.id, { uploadedFiles, reusedFiles })
      } catch (error) {
        if (scheduleDeferred(error)) throw error
        try { store.assertOwner(job.id, token); store.putJobItem(job.id, { itemId: entry.relativePath, path: entry.relativePath, status: store.object(object.objectId)?.state === 'uncertain' ? 'uncertain' : 'failed', error: '该文件尚未确认完成' }, token) } catch { /* Superseded worker. */ }
        if (store.object(object.objectId)?.state === 'uncertain') throw uncertain()
        throw error
      } finally { if (staged) await fsp.unlink(staged).catch(error => { if (!missing(error)) throw error }) }
    }
    // Never call a version ready if the source changed while objects were uploaded.
    const final = await scanBackupSource(plan, context.signal)
    scope.assert()
    if (final.failures.length || backupFingerprint(final.source) !== snapshot.fingerprint) throw new FileBackupError('备份期间源目录变化，已保留对象但未生成可恢复版本', 'LOCAL_FILE_CHANGED')
    const manifestText = JSON.stringify({ format: 'panlite-file-backup-v1', snapshotId: snapshot.id, planId: plan.id, planVersion: plan.version,
      fingerprint: snapshot.fingerprint, createdAt: snapshot.createdAt,
      entries: entries.map(entry => ({ ...entry, ...(entry.objectId ? { objectName: store.object(entry.objectId)!.name } : {}) })) })
    let manifest = store.manifestObject(snapshot.id)
    if (!manifest) {
      manifest = store.createObject(plan.id, 'manifest', backupDigest(manifestText), Buffer.byteLength(manifestText), `snapshot-${snapshot.id}.json`)
      store.attachManifest(snapshot.id, manifest.objectId)
    }
    if (manifest.sha256 !== backupDigest(manifestText)) throw new FileBackupError('快照元数据发生变化，拒绝改写不可变版本')
    let manifestFile: string | undefined
    try {
      await scope.ensureObject(manifest, containerId, async () => {
        manifestFile = path.join(await scope.temp(), `manifest-${randomUUID()}.json`)
        await fsp.writeFile(manifestFile, manifestText, { flag: 'wx', mode: 0o600 }); return manifestFile
      })
    } finally { if (manifestFile) await fsp.unlink(manifestFile).catch(error => { if (!missing(error)) throw error }) }
    scope.assert()
    if (store.snapshotObjects(snapshot.id).some(object => object.state !== 'verified')) throw new FileBackupError('仍有未校验对象，不能将版本标为可恢复')
    store.patchSnapshot(snapshot.id, { status: 'ready', completedAt: store.now(), uploadedFiles, reusedFiles, error: undefined })
    scope.recordSuccess('manifest', '版本清单'); store.patchJob(job.id, { status: 'completed', error: undefined }, token)
    context.progress(100, '文件版本及所有内容已回读校验')
    return { summary: `备份版本已校验：${snapshot.fileCount} 个文件，上传 ${uploadedFiles} 个内容对象` }
  } catch (error) { failJob(dependencies, context, job, token, error); throw error }
  finally { await scope.cleanup() }
}

async function ensureLocalDirectory(root: string, relative: string): Promise<void> {
  const absolute = backupLocalPath(root, relative, true)
  await assertBackupNoLinks(absolute, true)
  await fsp.mkdir(absolute, { recursive: true })
  await assertBackupNoLinks(absolute)
  if (!(await fsp.lstat(absolute)).isDirectory()) throw new FileBackupError('恢复目录被其他文件替换')
}
/** Recover an immutable snapshot to a checked local tree; only exact previewed files can be overwritten. */
export async function executeFileRestoreTask(context: TaskExtensionContext, dependencies: FileBackupExecutorDependencies): Promise<{ summary: string }> {
  const { job, plan, token } = claim(context, dependencies, 'restore'), scope = execution(dependencies, context, plan, job, token)
  const { service, store } = scope, document = service.document<StoredRestorePreview>(job.previewId, 'restore')
  try {
    const snapshot = service.snapshot(job.snapshotId!, true)
    if (!document.preview.executable || snapshot.id !== document.preview.snapshotId || snapshot.fingerprint !== document.fingerprint) throw new FileBackupError('恢复预演已过期', 'STALE_PREVIEW')
    service.validateRestoreScope(document, snapshot)
    const target = await service.restoreTarget(snapshot, document.preview.targetPath)
    if (target !== document.preview.targetPath) throw new FileBackupError('恢复目标已变化', 'STALE_PREVIEW')
    const containerId = await scope.container(false), manifest = store.manifestObject(snapshot.id)
    if (!manifest) throw new FileBackupError('快照缺少已经校验的版本清单')
    await scope.verify(manifest, containerId)
    const completed = new Set(store.jobItems(job.id).filter(item => item.status === 'success').map(item => item.itemId))
    if (!document.preview.overwrite && completed.size === 0) {
      try {
        const existing = await fsp.readdir(target)
        if (existing.length) {
          // A crash after a local atomic publish can precede its journal commit. Individual SHA checks below reconcile only identical outputs.
          const allowed = new Set(document.items.filter(item => item.relativePath).map(item => item.relativePath.split('/')[0]))
          if (existing.some(name => !allowed.has(name))) throw new FileBackupError('新恢复目录出现了未预演文件，请重新预演', 'STALE_PREVIEW')
        }
      } catch (error) { if (!missing(error)) throw error }
    }
    for (const entry of document.items) {
      scope.assert()
      const file = backupLocalPath(target, entry.relativePath, entry.isDir)
      if (entry.action === 'blocked') throw new FileBackupError('恢复包含未解决的目标冲突')
      if (entry.isDir) { await ensureLocalDirectory(target, entry.relativePath); scope.assert(); scope.recordSuccess(entry.relativePath, entry.relativePath); continue }
      await ensureLocalDirectory(target, path.posix.dirname(entry.relativePath) === '.' ? '' : path.posix.dirname(entry.relativePath))
      const current = async (): Promise<Awaited<ReturnType<typeof readStableBackupFile>> | undefined> => {
        await assertBackupNoLinks(file, true)
        try { return await readStableBackupFile(file, context.signal) } catch (error) { if (missing(error)) return undefined; throw error }
      }
      const previous = document.existing[entry.relativePath], before = await current()
      if (before && before.sha256 === entry.sha256 && before.size === entry.size) { scope.recordSuccess(entry.relativePath, entry.relativePath); continue }
      if (completed.has(entry.relativePath)) throw new FileBackupError('已恢复文件被再次修改，拒绝自动改写', 'STALE_PREVIEW')
      if (previous ? !before || before.sha256 !== previous.sha256 || before.size !== previous.size : !!before) throw new FileBackupError('恢复目标与预演不一致，请重新预演', 'STALE_PREVIEW')
      const temporary = path.join(path.dirname(file), `.panlite-restore-${randomUUID()}`)
      try {
        const result = await context.operation('恢复已校验备份文件', `${job.id}:${entry.relativePath}`, async () => {
          await scope.verify(store.object(entry.objectId!)!, containerId, temporary)
          const fresh = await current(); scope.assert()
          if (previous ? !fresh || fresh.sha256 !== previous.sha256 || fresh.size !== previous.size : !!fresh) throw new FileBackupError('发布前恢复目标已变化，请重新预演', 'STALE_PREVIEW')
          if (entry.action === 'overwrite') await fsp.rename(temporary, file)
          else await fsp.link(temporary, file)
          scope.assert(); scope.recordSuccess(entry.relativePath, entry.relativePath)
          return { path: entry.relativePath, sha256: entry.sha256 }
        })
        scope.assert()
        const verified = await current()
        if (!result || result.sha256 !== entry.sha256 || !verified || verified.sha256 !== entry.sha256 || verified.size !== entry.size) throw new FileBackupError('恢复输出未通过最终内容校验')
        scope.recordSuccess(entry.relativePath, entry.relativePath)
      } finally { await fsp.unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
    }
    scope.assert(); store.patchJob(job.id, { status: 'completed' }, token); context.progress(100, '所有恢复文件 SHA256 校验一致')
    return { summary: `已恢复 ${document.preview.fileCount} 个文件及 ${document.preview.directoryCount} 个目录` }
  } catch (error) { failJob(dependencies, context, job, token, error); throw error }
  finally { await scope.cleanup() }
}

/** Deletes only explicitly previewed exclusive objects; unknown deletion outcomes are read-reconciled and never blindly repeated. */
export async function executeFileBackupPruneTask(context: TaskExtensionContext, dependencies: FileBackupExecutorDependencies): Promise<{ summary: string }> {
  const { job, plan, token } = claim(context, dependencies, 'prune'), scope = execution(dependencies, context, plan, job, token)
  const { store, service } = scope, document = service.document<StoredRetentionPreview>(job.previewId, 'prune'), selected = new Set(document.preview.snapshotIds)
  try {
    const initialAttempt = store.jobItems(job.id).length === 0 && document.preview.snapshotIds.every(id => store.snapshot(id)?.status !== 'deleting')
    if (!document.preview.executable || document.preview.planVersion !== plan.version || (initialAttempt && document.fingerprint !== service.retentionFingerprint(plan.id))) throw new FileBackupError('版本引用已经变化，请重新预演清理', 'STALE_PREVIEW')
    for (const id of selected) {
      const snapshot = store.snapshot(id)
      if (!snapshot || snapshot.planId !== plan.id || snapshot.status === 'deleted') continue
      scope.assert(); store.patchSnapshot(id, { status: 'deleting' })
    }
    let containerId: string | undefined
    for (const item of document.objects) {
      scope.assert()
      let object = store.object(item.objectId)
      if (!object || object.planId !== plan.id || object.sha256 !== item.sha256 || object.size !== item.size || object.name !== item.name) throw new FileBackupError('清理对象证据已变化', 'STALE_PREVIEW')
      if (store.references(object.objectId).some(id => !selected.has(id))) throw new FileBackupError('对象仍被保留版本引用，禁止删除', 'REFERENCED_OBJECT')
      if (object.state === 'deleted') { scope.recordSuccess(object.objectId, object.name); continue }
      if (object.state === 'pending') { store.patchObject(object.objectId, { state: 'deleted' }); scope.recordSuccess(object.objectId, object.name); continue }
      containerId ??= await scope.container(false)
      const remote = await scope.locate(object, containerId)
      if (object.state === 'deleting') {
        if (remote) throw uncertain()
        store.patchObject(object.objectId, { state: 'deleted' }); scope.recordSuccess(object.objectId, object.name); continue
      }
      if (!remote) {
        // A complete directory read confirms absence. No remote mutation is necessary.
        store.patchObject(object.objectId, { state: 'deleted' }); scope.recordSuccess(object.objectId, object.name); continue
      }
      object = await scope.verify(object, containerId)
      const deleting = object
      try {
        await context.operation('删除独占备份对象', `${job.id}:${object.objectId}`, async () => {
          scope.assert()
          if (store.references(deleting.objectId).some(id => !selected.has(id))) throw new FileBackupError('对象新增了保留引用，禁止删除', 'REFERENCED_OBJECT')
          await scope.request(() => {
            scope.assert(); store.patchObject(deleting.objectId, { state: 'deleting' })
            return scope.adapter.delete(scope.account, [deleting.remoteId!])
          })
          if (await scope.locate(deleting, containerId!)) throw uncertain()
          scope.assert(); store.patchObject(deleting.objectId, { state: 'deleted' }); return { id: deleting.objectId }
        })
        scope.assert(); store.patchObject(object.objectId, { state: 'deleted' }); scope.recordSuccess(object.objectId, object.name)
      } catch (error) {
        if (scheduleDeferred(error)) throw error
        try { store.assertOwner(job.id, token); store.putJobItem(job.id, { itemId: object.objectId, path: object.name, status: 'uncertain', error: '删除已经发出，须先确认远端是否存在，不会自动重删' }, token) } catch { /* Superseded worker. */ }
        if (store.object(object.objectId)?.state === 'deleting') throw uncertain()
        throw error
      }
    }
    scope.assert()
    if (document.objects.some(item => store.object(item.objectId)?.state !== 'deleted')) throw uncertain()
    store.db.transaction(() => {
      for (const id of selected) store.deleteSnapshotReferences(id)
      store.patchPlan(plan.id, { latestSnapshotId: store.snapshots(plan.id).find(snapshot => snapshot.status === 'ready')?.id })
      store.patchJob(job.id, { status: 'completed' }, token)
    })()
    context.progress(100, '只清理了所选版本独占的对象')
    return { summary: `已清理 ${selected.size} 个版本，${document.objects.length} 个独占对象` }
  } catch (error) { failJob(dependencies, context, job, token, error); throw error }
  finally { await scope.cleanup() }
}

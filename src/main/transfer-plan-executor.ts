import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount } from '../shared/types'
import type { TransferPlanObject, TransferPreviewItem } from '../shared/transfer-plan'
import { guardTaskAdapterMutations } from './task-operations'
import type { TaskExtensionContext } from './task-extensions'
import { sameTransferObject, TransferPlanError, TransferPlanService } from './transfer-plan-service'
import type { StoredTransferResult } from './transfer-plan-store'

export interface TransferPlanDownloadInput {
  context: TaskExtensionContext
  account: DriveAccount
  adapter: DriveAdapter
  item: TransferPreviewItem
  targetPath: string
  onProgress: (progress: { loaded: number; percent: number; speed: number }) => void
}
export interface TransferPlanExecutorDependencies {
  service: TransferPlanService
  tempRoot?: string | (() => string)
  /** Production supplies the existing persistent-download integration. */
  download?: (input: TransferPlanDownloadInput) => Promise<void>
  onTargetChanged?: (accountId: string, directoryIds: string[]) => void
}
class UncertainTransferWrite extends TransferPlanError {
  constructor() { super('远端写入结果待核对，已停止自动重发；请在目标目录确认结果', 'REMOTE_RESULT_UNCERTAIN') }
}
function parent(relativePath: string): string { const value = path.posix.dirname(relativePath); return value === '.' ? '' : value }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
async function verifyDownloadedFile(file: string, item: TransferPreviewItem, signal: AbortSignal): Promise<void> {
  const stat = await fsp.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.source.size) throw new TransferPlanError('下载产物类型或长度不匹配')
  if (item.source.hash) {
    const hash = createHash(item.source.hash.algorithm)
    for await (const bytes of fs.createReadStream(file, { signal })) hash.update(bytes)
    if (hash.digest('hex') !== item.source.hash.value) throw new TransferPlanError('下载内容与预演官方哈希不一致', 'STALE_PREVIEW')
  }
}

/** Runs exclusively inside the existing task queue, ownership fence and operation journal. */
export async function executeTransferPlanTask(context: TaskExtensionContext, dependencies: TransferPlanExecutorDependencies): Promise<{ partial?: boolean; summary?: string }> {
  const { service } = dependencies, { store } = service
  context.assertActive()
  const payload = JSON.parse(context.task.payload) as { planId?: string; previewId?: string; runId?: string }
  if (!payload.planId || !payload.previewId || !payload.runId || !context.task.execution_token) throw new TransferPlanError('迁移任务参数不完整')
  const plan = service.plan(payload.planId), document = service.document(payload.previewId)
  const previousRun = store.getRun(payload.runId)
  if (!previousRun || previousRun.planId !== plan.id || previousRun.previewId !== document.preview.id || document.preview.planId !== plan.id
    || previousRun.planVersion !== plan.version || context.task.account_id !== plan.target.accountId) throw new TransferPlanError('迁移任务与计划不匹配')
  const token = context.task.execution_token
  const run = store.claimRun(previousRun.id, context.task.id, token)
  let temporary: string | undefined
  const touched = new Set<string>()
  try {
    // A queue delay or restart can invalidate a preview after the Execute click.
    await service.validateExecution(document, run, context.signal)
    context.assertActive()
    const sourceAccount = service.account(plan.source.accountId), targetAccount = service.account(plan.target.accountId)
    const sourceAdapter = guardTaskAdapterMutations(service.dependencies.getAdapter(sourceAccount.platform))
    const targetAdapter = guardTaskAdapterMutations(service.dependencies.getAdapter(targetAccount.platform))
    const directories = new Map<string, string>([['', plan.target.rootId]])
    for (const entry of document.snapshot.target) if (entry.object.isDir) directories.set(entry.relativePath, entry.object.fileId)
    const recorded = new Map(store.results(run.id).map(result => [result.itemId, result]))
    for (const result of recorded.values()) if (result.status === 'success' && result.object?.isDir) directories.set(result.outputPath, result.remoteId!)
    let done = 0
    const progress = (fraction = 0, label?: string): void => {
      context.assertActive()
      context.progress(Math.min(99, (done + fraction) / Math.max(1, document.items.length) * 99), label)
    }
    const save = (item: TransferPreviewItem, value: Omit<StoredTransferResult, 'itemId' | 'relativePath' | 'outputPath' | 'updatedAt'>): StoredTransferResult => {
      const result: StoredTransferResult = { itemId: item.id, relativePath: item.relativePath, outputPath: item.outputPath, updatedAt: store.now(), ...value }
      store.putResult(run.id, result, token); recorded.set(item.id, result); store.summarizeRun(run.id, token)
      return result
    }
    const sourceUnchanged = async (item: TransferPreviewItem): Promise<void> => {
      context.assertActive()
      const current = (await service.directory(sourceAccount, sourceAdapter, item.source.parentId, context.signal)).find(file => file.id === item.source.fileId)
      if (!current || !sameTransferObject(service.evidence(sourceAccount, current), item.source)) throw new TransferPlanError('源文件已经变化，请重新预演', 'STALE_PREVIEW')
      context.assertActive()
    }
    const targetBefore = async (item: TransferPreviewItem, parentId: string): Promise<TransferPlanObject | undefined> => {
      const name = path.posix.basename(item.outputPath)
      const matches = (await service.directory(targetAccount, targetAdapter, parentId, context.signal)).filter(file => file.name === name)
      const expected = item.outputPath === item.relativePath ? item.target : undefined
      if (matches.length > 1 || (expected ? matches.length !== 1 : matches.length !== 0)) throw new TransferPlanError('目标目录已经变化，请重新预演', 'STALE_PREVIEW')
      const actual = matches[0] ? service.evidence(targetAccount, matches[0]) : undefined
      if (expected && (!actual || !sameTransferObject(expected, actual))) throw new TransferPlanError('目标文件已经变化，请重新预演', 'STALE_PREVIEW')
      context.assertActive()
      return actual
    }
    const confirmWritten = async (item: TransferPreviewItem, parentId: string, remoteId?: string): Promise<TransferPlanObject> => {
      // A successful response alone is insufficient for an invented/placeholder ID.
      // Listing failure or absence means uncertain; the operation stays non-replayable.
      const matches = (await service.directory(targetAccount, targetAdapter, parentId, context.signal)).filter(file => file.name === path.posix.basename(item.outputPath)
        && file.isDir === item.source.isDir && (!remoteId || file.id === remoteId))
      if (matches.length !== 1) throw new UncertainTransferWrite()
      const object = service.evidence(targetAccount, matches[0])
      if (!object.isDir && (object.size !== item.source.size || (object.hash && item.source.hash && object.hash.algorithm === item.source.hash.algorithm && object.hash.value !== item.source.hash.value))) throw new UncertainTransferWrite()
      return object
    }
    const download = dependencies.download ?? (async (input: TransferPlanDownloadInput): Promise<void> => {
      if (!input.adapter.download) throw new TransferPlanError('源账号不支持下载')
      const result = await input.adapter.download(input.account, input.item.source.fileId, path.dirname(input.targetPath), { signal: input.context.signal,
        fileName: path.basename(input.targetPath), onProgress: input.onProgress })
      input.context.assertActive()
      if (!result.success || !result.localPath || path.resolve(result.localPath) !== path.resolve(input.targetPath)) throw new TransferPlanError('下载失败或返回了计划范围外的路径')
    })

    for (const item of document.items) {
      context.assertActive()
      const prior = recorded.get(item.id)
      if (prior?.status === 'success' || prior?.status === 'skipped') { done++; progress(0, `复用执行记录：${item.relativePath}`); continue }
      if (prior?.status === 'uncertain') { done++; progress(0, `等待人工核对：${item.relativePath}`); continue }
      if (item.action === 'review' || item.requiresDecision) throw new TransferPlanError('预演仍有待核对项', 'REVIEW_REQUIRED')
      if (item.action === 'skip') { save(item, { status: 'skipped' }); done++; progress(0, `已跳过：${item.relativePath}`); continue }
      const parentId = directories.get(parent(item.outputPath))
      if (!parentId) { save(item, { status: 'failed', error: '目标上级目录未成功建立，该项没有执行' }); done++; progress(); continue }
      let localPath: string | undefined
      let dispatched = false
      try {
        const result = await context.operation(item.source.isDir ? '计划迁移目录' : '计划迁移文件', `${run.id}:${item.id}`, async () => {
          await sourceUnchanged(item)
          if (item.source.isDir) {
            const existing = await targetBefore(item, parentId)
            if (item.action === 'merge') {
              if (!existing?.isDir) throw new TransferPlanError('预演中的目标目录已变化', 'STALE_PREVIEW')
              return save(item, { status: 'success', remoteId: existing.fileId, object: existing })
            }
            if (existing) throw new TransferPlanError('目标已有同名对象，请重新预演', 'STALE_PREVIEW')
            context.assertActive(); dispatched = true
            const created = await targetAdapter.mkdir(targetAccount, parentId, path.posix.basename(item.outputPath))
            const object = await confirmWritten(item, parentId, created.id)
            touched.add(parentId)
            return save(item, { status: 'success', remoteId: object.fileId, object })
          }
          // Prepare and verify the full local file before any overwrite deletion.
          if (item.mode === 'staged_transfer') {
            if (!temporary) {
              const base = typeof dependencies.tempRoot === 'function' ? dependencies.tempRoot() : dependencies.tempRoot ?? os.tmpdir()
              await fsp.mkdir(base, { recursive: true })
              temporary = await fsp.mkdtemp(path.join(await fsp.realpath(base), 'panlite-plan-transfer-'))
            }
            localPath = path.join(temporary, `${item.id}.bin`)
            await download({ context, account: sourceAccount, adapter: sourceAdapter, item, targetPath: localPath,
              onProgress: value => progress(value.percent / 200, `下载：${item.relativePath} (${Math.round(value.percent)}%)`) })
            await verifyDownloadedFile(localPath, item, context.signal)
            await sourceUnchanged(item)
          }
          const existing = await targetBefore(item, parentId)
          if (existing) {
            if (item.action !== 'overwrite' || existing.isDir) throw new TransferPlanError('目标冲突与预演不一致', 'STALE_PREVIEW')
            context.assertActive(); dispatched = true
            await targetAdapter.delete(targetAccount, [existing.fileId])
            touched.add(parentId)
          }
          context.assertActive()
          let remoteId: string | undefined
          if (item.mode === 'native_copy') {
            if (sourceAccount.id !== targetAccount.id || !sourceAdapter.copy || path.posix.basename(item.outputPath) !== item.source.name) throw new TransferPlanError('该项目无法精确使用原生复制')
            dispatched = true
            await sourceAdapter.copy(sourceAccount, [item.source.fileId], parentId)
          } else {
            if (!targetAdapter.upload || !localPath) throw new TransferPlanError('目标账号不支持上传')
            dispatched = true
            const uploaded = await targetAdapter.upload(targetAccount, localPath, parentId, { signal: context.signal, fileName: path.posix.basename(item.outputPath), overwrite: false,
              onProgress: value => progress(0.5 + value.percent / 200, `上传：${item.relativePath} (${Math.round(value.percent)}%)`) })
            if (!uploaded.success) throw new UncertainTransferWrite()
            remoteId = uploaded.fileId
          }
          touched.add(parentId)
          const object = await confirmWritten(item, parentId, remoteId)
          return save(item, { status: 'success', remoteId: object.fileId, object })
        })
        context.assertActive()
        if (!result || result.itemId !== item.id) throw new UncertainTransferWrite()
        // Also materialize a replayed successful journal result into the report.
        store.putResult(run.id, result, token); recorded.set(item.id, result)
        if (item.source.isDir && result.status === 'success' && result.remoteId) directories.set(item.outputPath, result.remoteId)
      } catch (error) {
        if ((error as { code?: string })?.code === 'TASK_SCHEDULE_DEFERRED') throw error
        if (context.signal.aborted && dispatched && recorded.get(item.id)?.status !== 'success') save(item, { status: 'uncertain', error: '写入期间任务中断，远端结果待核对，禁止自动重发' })
        context.assertActive()
        const uncertain = dispatched || error instanceof UncertainTransferWrite || (error as { code?: string }).code === 'REMOTE_RESULT_UNCERTAIN'
        const message = uncertain ? '远端结果待核对，已停止自动重发' : error instanceof TransferPlanError ? error.message : '文件处理失败，请重试'
        save(item, { status: uncertain ? 'uncertain' : 'failed', error: message })
        context.log('warn', `${item.relativePath}：${message}`)
        // A changed object invalidates the rest of the saved preview as well.
        if (error instanceof TransferPlanError && error.code === 'STALE_PREVIEW') throw error
      } finally {
        if (localPath && temporary && inside(temporary, path.resolve(localPath))) await fsp.unlink(localPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      }
      done++; progress(0, `已处理 ${done}/${document.items.length}`)
    }
    context.assertActive()
    const summary = store.summarizeRun(run.id, token)
    const partial = summary.failed + summary.uncertain > 0
    const message = `${summary.succeeded} 项成功，${summary.skipped} 项跳过，${summary.failed} 项失败，${summary.uncertain} 项待核对`
    store.patchRun(run.id, { status: partial ? 'partial' : 'completed', finishedAt: store.now(), summary: message }, token)
    store.patchPlan(plan.id, { status: partial ? 'partial' : 'completed' })
    context.log(partial ? 'warn' : 'info', message)
    return { ...(partial ? { partial: true } : {}), summary: message }
  } catch (error) {
    if ((error as { code?: string })?.code === 'TASK_SCHEDULE_DEFERRED') throw error
    // Pause/cancel/ownership changes are handled by the original task lifecycle.
    // Keep the run and item evidence; a late attempt cannot rewrite the new owner.
    if (!context.signal.aborted) {
      context.assertActive()
      const stale = error instanceof TransferPlanError && error.code === 'STALE_PREVIEW'
      store.summarizeRun(run.id, token)
      store.patchRun(run.id, { status: stale ? 'stale' : 'failed', summary: stale ? '目录内容变化，必须重新预演' : '迁移执行失败，已保留逐项结果', finishedAt: store.now() }, token)
      store.patchPlan(plan.id, { status: stale ? 'stale' : 'failed' })
    }
    throw error
  } finally {
    if (touched.size) dependencies.onTargetChanged?.(plan.target.accountId, [...touched])
    if (temporary) {
      const absolute = path.resolve(temporary)
      if (path.basename(absolute).startsWith('panlite-plan-transfer-') && !(await fsp.lstat(absolute)).isSymbolicLink()) await fsp.rm(absolute, { recursive: true, force: true })
    }
  }
}

import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem, Platform, TaskStatus } from '../shared/types'
import { extractSourceHash } from '../shared/cloud-transfer'
import type { TransferContentHash, TransferPlan, TransferPlanInput, TransferPlanLocation, TransferPlanObject, TransferPlanResult, TransferPlansApi, TransferPreview, TransferPreviewItem, TransferRun } from '../shared/transfer-plan'
import { TransferPlanStore, type StoredTransferPreview, type TransferSnapshot, type TransferTreeEntry } from './transfer-plan-store'

export interface TransferPlanDependencies {
  getAccount(accountId: string): DriveAccount | undefined
  getAdapter(platform: Platform): DriveAdapter
  enqueueTask(input: { accountId: string; platform: Platform; type: 'planned_transfer'; title: string; payload: { planId: string; previewId: string; runId: string; sourceAccountId: string; targetAccountId: string } }): string
  getTaskStatus?(taskId: string): TaskStatus | undefined
  /** Only authoritative, provider-documented full-file content hashes. Never an arbitrary ETag. */
  getContentHash?(account: DriveAccount, file: FileItem): TransferContentHash | undefined
  request?<T>(accountId: string, execute: () => Promise<T>, signal?: AbortSignal): Promise<T>
}
export class TransferPlanError extends Error {
  constructor(message: string, readonly code = 'PLAN_INVALID') { super(message); this.name = 'TransferPlanError' }
}
const MESSAGES: Record<string, string> = {
  PLAN_MISSING: '迁移计划不存在', PLAN_BUSY: '迁移计划正在预演或执行，暂时不能修改', PLAN_VERSION: '计划已被更新，请刷新后重试',
  STALE_PREVIEW: '源目录或目标目录已变化，请重新预演', RUN_MISSING: '迁移执行记录不存在', TASK_SUPERSEDED: '任务执行权已经转移',
}
const categories = ['add', 'identical', 'changed', 'conflict', 'review', 'excluded', 'directory']
const policies = ['overwrite', 'rename', 'skip']
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TransferPlanError('参数格式不正确')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max) throw new TransferPlanError(`${label}不正确`)
  return value
}
function location(value: unknown): TransferPlanLocation {
  const input = record(value)
  const rootPath = text(input.rootPath, '目录路径').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
  if (!rootPath.startsWith('/') || rootPath.includes('\\') || rootPath.split('/').some(part => part === '.' || part === '..')) throw new TransferPlanError('目录路径不正确')
  return { accountId: text(input.accountId, '账号', 256), rootId: text(input.rootId, '目录标识'), rootPath }
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new TransferPlanError('分页参数不正确')
  return value as number
}
function normalizeHash(value?: TransferContentHash): TransferContentHash | undefined {
  if (!value || !['md5', 'sha1', 'sha256'].includes(value.algorithm) || typeof value.value !== 'string'
    || !/^[a-f\d]+$/i.test(value.value) || value.value.length !== { md5: 32, sha1: 40, sha256: 64 }[value.algorithm]) return undefined
  return { algorithm: value.algorithm, value: value.value.toLowerCase() }
}
export function sameTransferObject(a: TransferPlanObject, b: TransferPlanObject): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function sorted(entries: TransferTreeEntry[]): TransferTreeEntry[] { return [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en') || a.object.fileId.localeCompare(b.object.fileId, 'en')) }
export function transferSnapshotFingerprint(snapshot: TransferSnapshot): string {
  return hash({ source: sorted(snapshot.source), target: sorted(snapshot.target), failures: snapshot.failures })
}
function glob(rule: string): RegExp {
  rule = rule.replace(/\/(?:\*\*)?$/, '')
  let pattern = ''
  for (let index = 0; index < rule.length; index++) {
    const character = rule[index]
    if (character === '*' && rule[index + 1] === '*') { index++; if (rule[index + 1] === '/') { index++; pattern += '(?:.*/)?' } else pattern += '.*' }
    else if (character === '*') pattern += '[^/]*'
    else if (character === '?') pattern += '[^/]'
    else pattern += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}(?:/.*)?$`, 'u')
}
function parent(relativePath: string): string { const value = path.posix.dirname(relativePath); return value === '.' ? '' : value }
function safeName(name: string): boolean { return !!name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name) && name.length <= 1024 }
const descendant = (child: string, directory: string): boolean => child.startsWith(`${directory}/`)

export class TransferPlanService implements TransferPlansApi {
  private readonly lifecycle = new AbortController()
  constructor(readonly store: TransferPlanStore, readonly dependencies: TransferPlanDependencies) {}
  dispose(): void { this.lifecycle.abort(new Error('Transfer plan service stopped')) }
  /** Invoke once during normal startup; never dispatches remote reads or writes. */
  recoverInterruptedPreviews(): { previews: number; queues: number } {
    let previews = 0, queues = 0
    this.store.db.transaction(() => {
      for (const plan of this.store.listPlans()) {
        if (plan.status === 'previewing') { this.store.patchPlan(plan.id, { status: 'draft', latestPreviewId: undefined }); previews++ }
        for (const run of this.store.listRuns(plan.id)) if (run.status === 'queued' && !run.taskId) {
          this.store.patchRun(run.id, { status: 'failed', finishedAt: this.store.now(), summary: '任务创建前进程中断，请重新预演后执行' })
          if (plan.latestRunId === run.id) this.store.patchPlan(plan.id, { status: 'draft', latestPreviewId: undefined })
          queues++
        }
      }
    })()
    return { previews, queues }
  }
  private async result<T extends object>(work: () => T | Promise<T>): Promise<TransferPlanResult<T>> {
    try { this.lifecycle.signal.throwIfAborted(); return { success: true, ...await work() } }
    catch (error) {
      if (error instanceof TransferPlanError) return { success: false, error: error.message, code: error.code }
      if (error instanceof Error && MESSAGES[error.message]) return { success: false, error: MESSAGES[error.message], code: error.message }
      return { success: false, error: '迁移计划操作失败，请重试', code: 'PLAN_ERROR' }
    }
  }
  account(id: string): DriveAccount {
    const account = this.dependencies.getAccount(id)
    if (!account || account.status !== 'active') throw new TransferPlanError('账号不可用，请重新登录', 'ACCOUNT_UNAVAILABLE')
    return account
  }
  plan(id: string): TransferPlan {
    let plan = this.store.getPlan(text(id, '计划标识', 256))
    if (!plan) throw new TransferPlanError(MESSAGES.PLAN_MISSING, 'PLAN_MISSING')
    this.refreshRun(plan.latestRunId)
    plan = this.store.getPlan(plan.id)!
    return plan
  }
  document(id: string): StoredTransferPreview {
    const document = this.store.getPreview(text(id, '预演标识', 256))
    if (!document) throw new TransferPlanError('预演不存在，请重新预演', 'STALE_PREVIEW')
    return document
  }
  evidence(account: DriveAccount, file: FileItem): TransferPlanObject {
    const contentHash = normalizeHash(this.dependencies.getContentHash?.(account, file) ?? extractSourceHash(account.platform, file.raw))
    return { fileId: file.id, parentId: file.parentId, name: file.name, isDir: file.isDir, size: file.isDir ? 0 : file.size, updatedAt: file.updatedAt, ...(contentHash ? { hash: contentHash } : {}) }
  }
  async directory(account: DriveAccount, adapter: DriveAdapter, directoryId: string, signal?: AbortSignal): Promise<FileItem[]> {
    signal?.throwIfAborted()
    const listing = await (this.dependencies.request ? this.dependencies.request(account.id, () => adapter.listFiles(account, directoryId), signal) : adapter.listFiles(account, directoryId))
    signal?.throwIfAborted()
    if (listing.hasMore !== false || !Array.isArray(listing.files) || listing.files.length > 200_000 || listing.parentId !== directoryId) throw new TransferPlanError('目录列表不完整，无法确认全部内容', 'INCOMPLETE_LISTING')
    const ids = new Set<string>()
    return listing.files.map(file => {
      const rootAlias = directoryId === '0' && ((account.platform === 'baidu' && file.parentId === '/') || (account.platform === 'aliyun_web' && file.parentId === 'root') || (account.platform === 'xunlei' && file.parentId === ''))
      if (!file || !safeName(file.name) || !file.id || file.id.includes('\0') || file.id.length > 4096 || ids.has(file.id)
        || file.accountId !== account.id || file.platform !== account.platform || (!rootAlias && file.parentId !== directoryId)
        || typeof file.isDir !== 'boolean' || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isFinite(file.updatedAt)) throw new TransferPlanError('目录返回了不一致的文件标识', 'INCOMPLETE_LISTING')
      ids.add(file.id)
      return { ...file, parentId: directoryId }
    })
  }
  async scan(plan: TransferPlan, signal?: AbortSignal): Promise<TransferSnapshot> {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal
    signal.throwIfAborted()
    const snapshot: TransferSnapshot = { source: [], target: [], sourceDirectoryIds: [], targetDirectoryIds: [], failures: [] }
    for (const side of ['source', 'target'] as const) {
      const account = this.account(plan[side].accountId), adapter = this.dependencies.getAdapter(account.platform)
      const queue = [{ id: plan[side].rootId, relativePath: '' }]
      const visited = new Set<string>()
      while (queue.length) {
        signal?.throwIfAborted()
        const current = queue.shift()!
        if (visited.has(current.id)) { snapshot.failures.push({ side, path: current.relativePath, reason: '目录形成循环或身份重复' }); continue }
        visited.add(current.id)
        snapshot[side === 'source' ? 'sourceDirectoryIds' : 'targetDirectoryIds'].push(current.id)
        if (visited.size > 100_000 || snapshot[side].length > 200_000 || current.relativePath.split('/').length > 128) {
          snapshot.failures.push({ side, path: current.relativePath, reason: '目录范围过大或层级过深，请缩小范围' }); break
        }
        try {
          const files = await this.directory(account, adapter, current.id, signal)
          for (const file of files) {
            const relativePath = current.relativePath ? `${current.relativePath}/${file.name}` : file.name
            snapshot[side].push({ relativePath, object: this.evidence(account, file) })
            if (file.isDir) queue.push({ id: file.id, relativePath })
          }
        } catch (error) {
          signal?.throwIfAborted()
          snapshot.failures.push({ side, path: current.relativePath, reason: error instanceof TransferPlanError ? error.message : '目录读取失败，不能视为目录为空' })
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      snapshot[side] = sorted(snapshot[side])
    }
    if (plan.source.accountId === plan.target.accountId) {
      const sourceIds = new Set([...snapshot.sourceDirectoryIds, ...snapshot.source.map(entry => entry.object.fileId)])
      if ([...snapshot.targetDirectoryIds, ...snapshot.target.map(entry => entry.object.fileId)].some(id => sourceIds.has(id))) throw new TransferPlanError('同一账号的源与目标含重叠目录或相同对象，请选择互不包含的范围', 'OVERLAPPING_DIRECTORIES')
      if (snapshot.failures.length) throw new TransferPlanError('目录扫描不完整，无法排除同账号目录重叠', 'INCOMPLETE_LISTING')
    }
    signal.throwIfAborted()
    return snapshot
  }
  private mode(plan: TransferPlan, action: TransferPreviewItem['action']): TransferPreviewItem['mode'] {
    const source = this.account(plan.source.accountId), target = this.account(plan.target.accountId)
    const sourceAdapter = this.dependencies.getAdapter(source.platform), targetAdapter = this.dependencies.getAdapter(target.platform)
    if (source.id === target.id && sourceAdapter.copy && action !== 'rename') return 'native_copy'
    if (!sourceAdapter.download || !targetAdapter.upload) throw new TransferPlanError('所选账号不支持本地中转下载和上传；当前计划不使用分享批量转存', 'TRANSFER_UNSUPPORTED')
    return 'staged_transfer'
  }
  private items(plan: TransferPlan, snapshot: TransferSnapshot): TransferPreviewItem[] {
    const rules = plan.exclude.map(glob)
    const targets = new Map<string, TransferPlanObject[]>()
    const sourceCounts = new Map<string, number>()
    for (const entry of snapshot.source) sourceCounts.set(entry.relativePath, (sourceCounts.get(entry.relativePath) ?? 0) + 1)
    for (const entry of snapshot.target) targets.set(entry.relativePath, [...targets.get(entry.relativePath) ?? [], entry.object])
    return snapshot.source.map(entry => {
      const matches = targets.get(entry.relativePath) ?? [], existing = matches[0]
      let category: TransferPreviewItem['category'] = 'add', action: TransferPreviewItem['action'] = 'create', reason = '目标中不存在'
      if (rules.some(rule => rule.test(entry.relativePath))) { category = 'excluded'; action = 'skip'; reason = '匹配排除规则' }
      else if ((sourceCounts.get(entry.relativePath) ?? 0) > 1) { category = 'conflict'; action = 'review'; reason = '源目录有多个同名对象，请分别改名或跳过' }
      else if (matches.length > 1) { category = 'conflict'; action = 'review'; reason = '目标有多个同名对象，必须保留或改名' }
      else if (existing) {
        if (existing.isDir !== entry.object.isDir) { category = 'conflict'; action = 'review'; reason = '文件与目录类型冲突，不允许递归覆盖目录' }
        else if (existing.isDir) { category = 'directory'; action = 'merge'; reason = '复用已有目录并逐项比较内容' }
        else if (existing.hash && entry.object.hash && existing.hash.algorithm === entry.object.hash.algorithm) {
          if (existing.hash.value === entry.object.hash.value && existing.size === entry.object.size) { category = 'identical'; action = 'skip'; reason = '同算法官方内容哈希一致' }
          else { category = 'changed'; action = plan.conflictPolicy; reason = '官方内容证据不同，按已选冲突策略处理' }
        } else { category = 'review'; action = 'review'; reason = '缺少可比较的官方内容哈希，名称、大小和时间不能证明相同' }
      }
      return { id: hash([entry.relativePath, entry.object.fileId]), relativePath: entry.relativePath, outputPath: entry.relativePath,
        source: entry.object, ...(existing ? { target: existing } : {}), category, action, requiresDecision: action === 'review', reason, mode: this.mode(plan, action) }
    })
  }
  private recompute(plan: TransferPlan, document: StoredTransferPreview): void {
    const decisions = new Map(document.items.filter(item => item.decision).map(item => [item.id, item.decision!]))
    document.items = this.items(plan, document.snapshot).map(item => {
      const decision = decisions.get(item.id)
      return decision ? { ...item, action: decision, decision, requiresDecision: false, reason: '用户已明确选择处理方式' } : item
    })
    const occupied = new Set(document.snapshot.target.map(entry => entry.relativePath))
    const remaps: Array<{ from: string; to: string }> = []
    const skipped: string[] = []
    const sourcePaths = new Set<string>()
    for (const item of document.items) {
      let outputPath = item.relativePath
      const remap = [...remaps].reverse().find(rule => descendant(outputPath, rule.from))
      if (remap) {
        outputPath = remap.to + outputPath.slice(remap.from.length)
        if (item.category !== 'excluded' && !item.decision) {
          item.action = 'create'; item.requiresDecision = false; item.reason = '上级目录已改名，将复制到新目录'
        }
      }
      if (skipped.some(directory => descendant(item.relativePath, directory))) { item.action = 'skip'; item.requiresDecision = false; item.reason = '上级目录已选择跳过' }
      if (item.action === 'rename') {
        const directory = parent(outputPath), name = path.posix.basename(outputPath)
        const extension = item.source.isDir ? '' : path.posix.extname(name), stem = name.slice(0, name.length - extension.length)
        let index = 1
        do { outputPath = `${directory ? directory + '/' : ''}${stem} (迁移 ${index++})${extension}` } while (occupied.has(outputPath))
        if (item.source.isDir) remaps.push({ from: item.relativePath, to: outputPath })
      }
      if (item.action === 'skip' && item.source.isDir) skipped.push(item.relativePath)
      if (sourcePaths.has(outputPath) && !['skip', 'review'].includes(item.action)) {
        item.category = 'conflict'; item.action = 'review'; item.requiresDecision = true; item.reason = '多个源对象使用相同输出路径，请明确改名或跳过'
      }
      item.outputPath = outputPath
      if (!['skip', 'review'].includes(item.action)) { occupied.add(outputPath); sourcePaths.add(outputPath) }
      item.mode = this.mode(plan, item.action)
    }
    const summary: TransferPreview['summary'] = { totalItems: document.items.length, fileCount: 0, directoryCount: 0, addCount: 0, identicalCount: 0,
      changedCount: 0, conflictCount: 0, reviewCount: 0, skipCount: 0, transferBytes: 0, tempBytes: 0 }
    for (const item of document.items) {
      if (item.source.isDir) summary.directoryCount++; else summary.fileCount++
      if (item.category === 'add') summary.addCount++
      if (item.category === 'identical') summary.identicalCount++
      if (item.category === 'changed') summary.changedCount++
      if (item.category === 'conflict') summary.conflictCount++
      if (item.requiresDecision) summary.reviewCount++
      if (item.action === 'skip') summary.skipCount++
      if (!item.source.isDir && !['skip', 'review'].includes(item.action) && item.mode === 'staged_transfer') {
        summary.transferBytes += item.source.size * 2; summary.tempBytes = Math.max(summary.tempBytes, item.source.size * 3)
      }
    }
    if (!Number.isSafeInteger(summary.transferBytes) || !Number.isSafeInteger(summary.tempBytes)) throw new TransferPlanError('预计传输字节超过支持范围')
    document.preview.summary = summary
    document.preview.complete = !document.snapshot.failures.length
    document.preview.executable = document.preview.complete && summary.reviewCount === 0
  }
  listPlans(): ReturnType<TransferPlansApi['listPlans']> { return this.result(() => ({ plans: this.store.listPlans().map(plan => { this.refreshRun(plan.latestRunId); return this.store.getPlan(plan.id)! }) })) }
  savePlan(input: TransferPlanInput): ReturnType<TransferPlansApi['savePlan']> {
    return this.result(() => {
      const value = record(input), source = location(value.source), target = location(value.target)
      if (value.id !== undefined) this.plan(text(value.id, '计划标识', 256))
      this.account(source.accountId); this.account(target.accountId)
      if (!Array.isArray(value.exclude) || value.exclude.length > 100) throw new TransferPlanError('排除规则最多 100 条')
      const exclude = [...new Set(value.exclude.map(rule => text(rule, '排除规则', 512).trim()))]
      if (exclude.some(rule => rule.startsWith('/') || rule.includes('\\') || rule.split('/').some(part => part === '.' || part === '..'))) throw new TransferPlanError('排除规则必须是安全相对路径')
      if (!policies.includes(value.conflictPolicy as string)) throw new TransferPlanError('冲突策略不正确')
      if (source.accountId === target.accountId && source.rootId === target.rootId) throw new TransferPlanError('源目录与目标目录不能相同', 'OVERLAPPING_DIRECTORIES')
      const saved = this.store.savePlan({ ...(value.id !== undefined ? { id: text(value.id, '计划标识', 256), expectedVersion: integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER) } : {}),
        name: text(value.name, '计划名称', 200).trim(), source, target, exclude, conflictPolicy: value.conflictPolicy as TransferPlanInput['conflictPolicy'] })
      return { plan: saved }
    })
  }
  removePlan(planId: string): ReturnType<TransferPlansApi['removePlan']> { return this.result(() => { this.plan(planId); this.store.removePlan(text(planId, '计划标识', 256)); return {} }) }
  previewPlan(planId: string): ReturnType<TransferPlansApi['previewPlan']> {
    return this.result(async () => {
      this.plan(planId)
      const plan = this.store.beginPreview(text(planId, '计划标识', 256))
      try {
        const snapshot = await this.scan(plan)
        const preview = { id: randomUUID(), planId, planVersion: plan.version, fingerprint: transferSnapshotFingerprint(snapshot), createdAt: this.store.now(),
          complete: false, executable: false, summary: {} as TransferPreview['summary'], failures: snapshot.failures }
        const document = { preview, snapshot, items: this.items(plan, snapshot) }
        this.recompute(plan, document); this.store.savePreview(document)
        return { preview }
      } catch (error) { this.store.patchPlan(plan.id, { status: 'failed' }); throw error }
    })
  }
  getPreview(input: Parameters<TransferPlansApi['getPreview']>[0]): ReturnType<TransferPlansApi['getPreview']> {
    return this.result(() => {
      const value = record(input), document = this.document(text(value.previewId, '预演标识', 256))
      if (value.category !== undefined && !categories.includes(value.category as string)) throw new TransferPlanError('分类不正确')
      const page = integer(value.page, 1, 1_000_000), pageSize = integer(value.pageSize, 100, 200)
      const items = document.items.filter(item => value.category === undefined || item.category === value.category)
      return { preview: document.preview, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize }
    })
  }
  resolvePreview(input: Parameters<TransferPlansApi['resolvePreview']>[0]): ReturnType<TransferPlansApi['resolvePreview']> {
    return this.result(() => {
      const value = record(input), document = this.document(text(value.previewId, '预演标识', 256)), plan = this.plan(document.preview.planId)
      if (plan.status === 'running' || plan.status === 'previewing') throw new TransferPlanError(MESSAGES.PLAN_BUSY, 'PLAN_BUSY')
      if (plan.version !== document.preview.planVersion || plan.latestPreviewId !== document.preview.id) throw new TransferPlanError(MESSAGES.STALE_PREVIEW, 'STALE_PREVIEW')
      if (!Array.isArray(value.decisions) || !value.decisions.length || value.decisions.length > 1000) throw new TransferPlanError('每次请处理 1 至 1000 项')
      for (const raw of value.decisions) {
        const decision = record(raw), item = document.items.find(item => item.id === decision.itemId)
        if (!item || !policies.includes(decision.action as string)) throw new TransferPlanError('待核对项或处理方式不正确')
        if (['excluded', 'identical'].includes(item.category)) throw new TransferPlanError('排除项和已确认一致项保持跳过')
        if (decision.action === 'overwrite' && (!item.target || item.source.isDir || item.target.isDir
          || document.snapshot.target.filter(entry => entry.relativePath === item.relativePath).length !== 1)) throw new TransferPlanError('此冲突只能改名或跳过，不能覆盖目录或不明确的目标')
        item.action = decision.action as 'overwrite' | 'rename' | 'skip'; item.decision = item.action; item.requiresDecision = false; item.reason = '用户已明确选择处理方式'
      }
      this.recompute(plan, document); this.store.savePreview(document)
      return { preview: document.preview }
    })
  }
  async validateExecution(document: StoredTransferPreview, run?: TransferRun, signal?: AbortSignal): Promise<TransferSnapshot> {
    const plan = this.plan(document.preview.planId)
    if (plan.version !== document.preview.planVersion || plan.latestPreviewId !== document.preview.id || !document.preview.executable) throw new TransferPlanError(MESSAGES.STALE_PREVIEW, 'STALE_PREVIEW')
    const fresh = await this.scan(plan, signal)
    if (fresh.failures.length || hash(sorted(fresh.source)) !== hash(sorted(document.snapshot.source))) throw new TransferPlanError(MESSAGES.STALE_PREVIEW, 'STALE_PREVIEW')
    let expectedEntries = [...document.snapshot.target]
    if (run) for (const result of this.store.results(run.id)) if (result.status === 'success' && result.object) {
      expectedEntries = expectedEntries.filter(entry => entry.relativePath !== result.outputPath)
      expectedEntries.push({ relativePath: result.outputPath, object: result.object })
    }
    // Directory modification times can legitimately change when our recorded
    // child writes succeed; retain IDs/names/types while comparing file evidence.
    const normalize = (entries: TransferTreeEntry[]): TransferTreeEntry[] => sorted(entries.map(entry => ({ ...entry, object: entry.object.isDir ? { ...entry.object, updatedAt: 0 } : entry.object })))
    if (hash(normalize(fresh.target)) !== hash(normalize(expectedEntries))) throw new TransferPlanError(MESSAGES.STALE_PREVIEW, 'STALE_PREVIEW')
    return fresh
  }
  executePlan(input: Parameters<TransferPlansApi['executePlan']>[0]): ReturnType<TransferPlansApi['executePlan']> {
    return this.result(async () => {
      const value = record(input), plan = this.plan(text(value.planId, '计划标识', 256)), document = this.document(text(value.previewId, '预演标识', 256))
      if (document.preview.planId !== plan.id || plan.latestPreviewId !== document.preview.id) throw new TransferPlanError(MESSAGES.STALE_PREVIEW, 'STALE_PREVIEW')
      if (!document.preview.executable) throw new TransferPlanError('请先完成目录扫描并处理全部待核对项', 'REVIEW_REQUIRED')
      if (plan.status === 'running' || plan.status === 'previewing') throw new TransferPlanError(MESSAGES.PLAN_BUSY, 'PLAN_BUSY')
      // Claim before the asynchronous check so two execute clicks cannot enqueue twice.
      const run = this.store.createRun(document.preview)
      try {
        await this.validateExecution(document, undefined, this.lifecycle.signal)
        const account = this.account(plan.target.accountId)
        const taskId = this.dependencies.enqueueTask({ accountId: account.id, platform: account.platform, type: 'planned_transfer', title: `迁移计划：${plan.name}`, payload: { planId: plan.id, previewId: document.preview.id, runId: run.id, sourceAccountId: plan.source.accountId, targetAccountId: plan.target.accountId } })
        return { taskId, run: this.store.patchRun(run.id, { taskId }) }
      } catch (error) {
        const stale = error instanceof TransferPlanError && error.code === 'STALE_PREVIEW'
        this.store.patchRun(run.id, { status: stale ? 'stale' : 'failed', finishedAt: this.store.now(), summary: stale ? MESSAGES.STALE_PREVIEW : '迁移任务未能启动' })
        this.store.patchPlan(plan.id, { status: stale ? 'stale' : 'failed' }); throw error
      }
    })
  }
  private refreshRun(runId?: string): TransferRun | undefined {
    if (!runId) return undefined
    const run = this.store.getRun(runId)
    if (!run) return undefined
    const taskStatus = run.taskId ? this.dependencies.getTaskStatus?.(run.taskId) : undefined
    if (taskStatus && ['pending', 'running', 'paused'].includes(taskStatus) && this.store.getPlan(run.planId)?.latestRunId === run.id) {
      this.store.patchPlan(run.planId, { status: 'running' })
    }
    if (taskStatus && ['cancelled', 'failed'].includes(taskStatus) && ['queued', 'running'].includes(run.status)) {
      this.store.patchPlan(run.planId, { status: 'failed' })
      return this.store.patchRun(run.id, { status: 'failed', taskStatus, summary: taskStatus === 'cancelled' ? '任务已取消，保留已有逐项结果' : '任务已失败，保留已有逐项结果', finishedAt: this.store.now() })
    }
    return { ...run, ...(taskStatus ? { taskStatus } : {}) }
  }
  listRuns(planId: string): ReturnType<TransferPlansApi['listRuns']> { return this.result(() => { this.plan(planId); return { runs: this.store.listRuns(planId).map(run => this.refreshRun(run.id)!) } }) }
  getReport(input: Parameters<TransferPlansApi['getReport']>[0]): ReturnType<TransferPlansApi['getReport']> {
    return this.result(() => {
      const value = record(input), runId = text(value.runId, '执行标识', 256), run = this.refreshRun(runId)
      if (!run) throw new TransferPlanError(MESSAGES.RUN_MISSING, 'RUN_MISSING')
      const page = integer(value.page, 1, 1_000_000), pageSize = integer(value.pageSize, 100, 200)
      const items = this.store.results(runId).map(({ object: _object, ...item }) => item)
      return { run, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize }
    })
  }
  exportPlan(input: Parameters<TransferPlansApi['exportPlan']>[0]): ReturnType<TransferPlansApi['exportPlan']> {
    return this.result(() => {
      const value = record(input), plan = this.plan(text(value.planId, '计划标识', 256))
      const preview = value.previewId ? this.document(text(value.previewId, '预演标识', 256)) : undefined
      const run = value.runId ? this.store.getRun(text(value.runId, '执行标识', 256)) : undefined
      if ((preview && preview.preview.planId !== plan.id) || (run && run.planId !== plan.id)) throw new TransferPlanError('导出记录与计划不匹配')
      return { fileName: `transfer-plan-${plan.id}.json`, json: JSON.stringify({ format: 'panlite-transfer-plan-v1', plan, ...(preview ? { preview: preview.preview, items: preview.items } : {}), ...(run ? { run, results: this.store.results(run.id) } : {}) }, null, 2) }
    })
  }
}

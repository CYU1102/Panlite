import { getAccountById, getAllTasks, getDb, getSetting, invalidateFilesCacheParents, type DbAccount, type DbTask } from './db'
import { decryptCredential } from './crypto'
import { getAdapter } from '../adapters/registry'
import { fatal, isPermanentError } from '../adapters/errors'
import { createAndEnqueueTask, pauseTask, resumeTask, cancelTask, retryTask } from './task-runner'
import { accountRequestBudget } from './account-request-budget'
import { guardTaskAdapterMutations } from './task-operations'
import type { TaskExtensionContext } from './task-extensions'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount } from '../shared/types'
import { supportsRecursiveSubscriptions, type ShareSubscription, type ShareSubscriptionInput, type SubscriptionRun, type SubscriptionTaskPayload } from '../shared/subscription-types'
import { SubscriptionStore } from './subscription-store'
import { planSubscription, scanSubscription, type SubscriptionRequest } from './subscription-recursive'
import { sanitizeFileName } from './file-transfer'

export interface ShareSubscriptionEvents {
  onSynced(info: { subscriptionId: string; title: string; savedCount: number }): void
  onFailed(info: { subscriptionId: string; title: string; error: string }): void
}
export interface ShareSubscriptionScheduler {
  start(): void
  stop(): void
  restart(): void
  runNow(subscriptionId: string): Promise<boolean>
  list(): ShareSubscription[]
  save(input: ShareSubscriptionInput): Promise<ShareSubscription>
  remove(id: string): void
  toggle(id: string, active: boolean): void
  execute(context: TaskExtensionContext): Promise<{ summary?: string }>
}
export interface SubscriptionDependencies {
  store: SubscriptionStore
  getAccount(id: string): DriveAccount | undefined
  getAdapter(platform: string): DriveAdapter
  getTasks(): DbTask[]
  enqueue(accountId: string, platform: string, type: string, title: string, payload: Record<string, unknown>): string
  taskAction(action: 'pause' | 'resume' | 'cancel' | 'retry', taskId: string): boolean
  request: SubscriptionRequest
  intervalMinutes(): number
  clock(): number
  invalidate(accountId: string, directoryIds: string[]): void
}
function toDriveAccount(row: DbAccount | undefined): DriveAccount | undefined {
  if (!row) return undefined
  let credential: DriveAccount['credential'] = {}
  try { credential = JSON.parse(decryptCredential(row.encrypted_credential)) } catch { /* Let the adapter report invalid credentials. */ }
  return { id: row.id, platform: row.platform as DriveAccount['platform'], nickname: row.nickname || row.id,
    loginType: row.login_type as DriveAccount['loginType'], credential, status: row.status as DriveAccount['status'], createdAt: row.created_at, updatedAt: row.updated_at }
}
let instance: ShareSubscriptionScheduler | null = null
export function getShareSubscriptionScheduler(): ShareSubscriptionScheduler | null { return instance }

function normalizedInput(input: ShareSubscriptionInput, account: DriveAccount, adapter: DriveAdapter): ShareSubscriptionInput {
  const text = (value: unknown, name: string, max = 4096): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${name}不正确`)
    return value.trim()
  }
  const terms = (value: unknown, extension = false): string[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 100) throw new Error('筛选条件过多或格式不正确')
    const result = [...new Set(value.map(item => text(item, '筛选条件', 100).toLocaleLowerCase().replace(extension ? /^\*?\./ : /^$/, '')))]
    if (extension && result.some(item => !/^[a-z\d][a-z\d_+-]{0,31}$/.test(item))) throw new Error('扩展名应为 mkv、mp4 等格式')
    return result
  }
  const url = text(input.url, '分享链接')
  const parsed = new URL(url)
  const hosts: Record<string, string[]> = { quark: ['pan.quark.cn'], uc: ['drive.uc.cn'], baidu: ['pan.baidu.com'], xunlei: ['pan.xunlei.com'],
    aliyun_web: ['www.alipan.com', 'alipan.com', 'www.aliyundrive.com', 'aliyundrive.com'] }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || !hosts[account.platform]?.includes(parsed.hostname)) throw new Error('分享链接与所选账号平台不匹配')
  if (!adapter.saveSharedFiles || (!adapter.getShareDetail && !adapter.listSharedDirectory)) throw new Error('此账号平台不支持分享订阅')
  if (input.scope !== undefined && !['root', 'recursive'].includes(input.scope)) throw new Error('订阅范围不正确')
  if (input.initialMode !== undefined && !['baseline', 'save_existing'].includes(input.initialMode)) throw new Error('首次检查方式不正确')
  if ((input.preserveStructure !== undefined && typeof input.preserveStructure !== 'boolean') || (input.detectChanges !== undefined && typeof input.detectChanges !== 'boolean')) throw new Error('订阅开关参数不正确')
  if (input.scope === 'recursive' && (!supportsRecursiveSubscriptions(account.platform) || !adapter.listSharedDirectory)) throw new Error('此平台暂不支持递归订阅，请选择根目录')
  if (input.id && !Number.isSafeInteger(input.expectedVersion)) throw new Error('缺少订阅配置版本，请刷新后重试')
  return { ...input, accountId: account.id, platform: account.platform, url,
    title: input.title ? text(input.title, '订阅名称', 200) : '', password: input.password ? text(input.password, '提取码', 128) : '',
    targetDirId: text(input.targetDirId || '0', '目标目录'), targetDirPath: input.targetDirPath ? text(input.targetDirPath, '目标路径') : '',
    includeKeywords: terms(input.includeKeywords), excludeKeywords: terms(input.excludeKeywords), extensions: terms(input.extensions, true) }
}
function taskPayload(task: DbTask): Partial<SubscriptionTaskPayload> & { subscriptionSync?: { subscriptionId?: string; seenFileIds?: string[] }; targetDirId?: string } {
  try { const parsed = JSON.parse(task.payload); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}

export function createShareSubscriptionScheduler(events: ShareSubscriptionEvents, overrides: Partial<SubscriptionDependencies> = {}): ShareSubscriptionScheduler {
  const deps: SubscriptionDependencies = {
    store: overrides.store || new SubscriptionStore(getDb()), getAccount: id => toDriveAccount(getAccountById(id)), getAdapter,
    getTasks: getAllTasks, enqueue: createAndEnqueueTask,
    taskAction: (action, id) => ({ pause: pauseTask, resume: resumeTask, cancel: cancelTask, retry: retryTask })[action](id),
    request: (id, execute, signal) => accountRequestBudget.run(id, 'background', execute, signal),
    intervalMinutes: () => Math.max(5, Math.min(1440, Number(getSetting('shareSubscriptionIntervalMinutes')?.value) || 15)),
    clock: Date.now, invalidate: invalidateFilesCacheParents, ...overrides,
  }
  const { store } = deps
  const checks = new Map<string, { controller: AbortController; promise: Promise<boolean> }>()
  const executions = new Map<string, AbortController>()
  let timer: NodeJS.Timeout | null = null
  let polling = false
  let epoch = 0
  const nextCheck = () => deps.clock() + deps.intervalMinutes() * 60_000
  const current = (config: ShareSubscription) => {
    const row = store.get(config.id)
    return Boolean(row && row.status === 'active' && row.configVersion === config.configVersion)
  }
  const assertCurrent = (config: ShareSubscription) => { if (!current(config)) throw fatal('订阅已暂停、删除或修改，当前检查已停止', { code: 'SUBSCRIPTION_SUPERSEDED' }) }

  function attachRun(run: SubscriptionRun, manual: boolean): void {
    const tasks = deps.getTasks()
    const task = tasks.find(item => item.id === run.taskId) || tasks.find(item => item.task_type === 'subscription_sync' && taskPayload(item).runId === run.id)
    if (task) {
      run.taskId = task.id
      const restarted = manual && (task.status === 'paused' ? deps.taskAction('resume', task.id)
        : ['failed', 'partial_success', 'cancelled'].includes(task.status) && deps.taskAction('retry', task.id))
      if (restarted) {
        run.state = 'pending'; run.error = ''
        store.patch(run.subscriptionId, run.configVersion, { lastError: '' })
      } else if (['failed', 'partial_success', 'cancelled'].includes(task.status)) {
        run.state = 'blocked'; run.error = task.error_message || '关联任务未完成，请在任务日志核对后重试'
        store.patch(run.subscriptionId, run.configVersion, { lastError: run.error })
      }
      store.updateRun(run)
      store.patch(run.subscriptionId, run.configVersion, { taskId: task.id })
      return
    }
    if (run.taskId) {
      // A deleted task may have dispatched a mutation. Keep its evidence instead of sending a new save.
      run.state = 'blocked'; run.error = '关联任务记录已删除，转存结果需核对；请重新配置订阅建立基线'
      store.updateRun(run); store.patch(run.subscriptionId, run.configVersion, { lastError: run.error })
      return
    }
    const config = run.config
    run.taskId = deps.enqueue(config.accountId, config.platform, 'subscription_sync', `订阅更新：${config.title || config.url}`,
      { subscriptionId: config.id, configVersion: config.configVersion, runId: run.id })
    store.updateRun(run)
    store.patch(config.id, config.configVersion, { taskId: run.taskId })
  }

  async function check(id: string, manual: boolean, signal: AbortSignal): Promise<boolean> {
    const config = store.get(id)
    if (!config) return false
    if (config.status !== 'active') return true
    if (!manual && config.nextCheckAt > deps.clock()) return true
    try {
      const run = store.activeRun(id, config.configVersion)
      if (run) { attachRun(run, manual); return true }
      const account = deps.getAccount(config.accountId)
      if (!account) throw fatal('账号不存在或已删除')
      const adapter = deps.getAdapter(account.platform)
      if (!adapter.saveSharedFiles) throw fatal('此平台不支持分享转存')
      // Reuse old queued transfers after upgrade, and import their proven successful IDs once.
      if (config.configVersion === 1 && config.scope === 'root') {
        const legacy = deps.getTasks().filter(task => task.task_type === 'transfer' && taskPayload(task).subscriptionSync?.subscriptionId === id)
        if (legacy.some(task => ['pending', 'running', 'paused'].includes(task.status))) return true
        const observed = new Map(store.observations(id).map(entry => [entry.fileId, entry]))
        for (const task of legacy.filter(task => task.status === 'success' && (!taskPayload(task).targetDirId || taskPayload(task).targetDirId === config.targetDirId))) {
          for (const fileId of taskPayload(task).subscriptionSync?.seenFileIds || []) {
            if (!observed.has(fileId)) observed.set(fileId, { fileId, name: '', isDir: false, parentId: '0', relativePath: '' })
          }
        }
        if (observed.size > store.observations(id).length) store.commitBaseline(config, [...observed.values()], nextCheck())
      }
      const snapshot = await scanSubscription(config, account, adapter, { signal, request: deps.request, assertCurrent: () => assertCurrent(config) })
      assertCurrent(config)
      const work = planSubscription(config, snapshot, store.observations(id))
      if (!work.length) { store.commitBaseline(config, snapshot, nextCheck()); return true }
      const created = store.createRun(config, snapshot, work)
      if (created) attachRun(created, false)
    } catch (error) {
      if (signal.aborted || !current(config)) return true
      const message = error instanceof Error ? error.message : String(error)
      const failureCount = config.failureCount + 1
      store.patch(id, config.configVersion, { lastError: message, failureCount, lastCheckedAt: deps.clock(),
        nextCheckAt: isPermanentError(error) ? Number.MAX_SAFE_INTEGER : deps.clock() + Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(failureCount - 1, 10)) })
      if (config.lastError !== message) try { events.onFailed({ subscriptionId: id, title: config.title || config.url, error: message }) } catch { /* Notification failure cannot change the cursor. */ }
    }
    return true
  }
  function checkOnce(id: string, manual: boolean): Promise<boolean> {
    const existing = checks.get(id)
    if (existing) return existing.promise
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => check(id, manual, controller.signal)).finally(() => {
      if (checks.get(id)?.controller === controller) checks.delete(id)
    })
    checks.set(id, { controller, promise })
    return promise
  }
  async function poll(): Promise<void> {
    if (polling) return
    polling = true
    const generation = epoch
    try {
      for (const config of store.list()) {
        if (generation !== epoch) break
        if (config.status === 'active') await checkOnce(config.id, false)
      }
    }
    finally { polling = false }
  }

  const scheduler: ShareSubscriptionScheduler = {
    start() {
      if (timer) return
      epoch++
      timer = setInterval(() => { void poll().catch(() => undefined) }, 30_000)
      timer.unref?.(); void poll().catch(() => undefined)
    },
    stop() { epoch++; if (timer) clearInterval(timer); timer = null; for (const value of checks.values()) value.controller.abort() },
    restart() { scheduler.stop(); scheduler.start() },
    runNow(id) { return checkOnce(id, true) },
    list() { return store.list() },
    async save(input) {
      if (!input || typeof input !== 'object') throw new Error('订阅参数不正确')
      const account = deps.getAccount(input.accountId)
      if (!account) throw new Error('账号不存在或已删除')
      const adapter = deps.getAdapter(account.platform)
      const normalized = normalizedInput(input, account, adapter)
      if (adapter.parseShareLink) await adapter.parseShareLink(normalized.url, normalized.password)
      const previous = input.id ? store.get(input.id) : undefined
      const saved = store.save(normalized)
      if (previous) {
        checks.get(previous.id)?.controller.abort(); executions.get(previous.id)?.abort()
        if (previous.taskId) deps.taskAction('cancel', previous.taskId)
      }
      return saved
    },
    remove(id) {
      const config = store.get(id)
      store.remove(id); checks.get(id)?.controller.abort(); executions.get(id)?.abort()
      if (config?.taskId) deps.taskAction('cancel', config.taskId)
    },
    toggle(id, active) {
      const config = store.get(id)
      if (!config) throw new Error('订阅不存在')
      store.patch(id, config.configVersion, { status: active ? 'active' : 'paused', nextCheckAt: 0 })
      if (!active) { checks.get(id)?.controller.abort(); executions.get(id)?.abort() }
      if (config.taskId) deps.taskAction(active ? 'resume' : 'pause', config.taskId)
    },
    async execute(context) {
      const payload = taskPayload(context.task)
      const run = typeof payload.runId === 'string' ? store.getRun(payload.runId) : undefined
      if (!run || run.subscriptionId !== payload.subscriptionId || run.configVersion !== payload.configVersion
        || context.task.account_id !== run.config.accountId || context.task.platform !== run.config.platform) throw fatal('订阅任务配置不存在或不匹配')
      if (run.state === 'success') return {}
      const config = run.config
      assertCurrent(config)
      const foundAccount = deps.getAccount(config.accountId)
      if (!foundAccount) throw fatal('账号不存在或已删除')
      const account: DriveAccount = foundAccount
      const adapter = guardTaskAdapterMutations(deps.getAdapter(account.platform))
      if (!adapter.saveSharedFiles) throw fatal('此平台不支持分享转存')
      const controller = new AbortController()
      const abort = () => controller.abort()
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) controller.abort()
      executions.set(config.id, controller)
      const assertActive = () => { context.assertActive(); controller.signal.throwIfAborted(); assertCurrent(config) }
      const request = <T>(execute: () => Promise<T>) => deps.request(account.id, async () => { assertActive(); return execute() }, controller.signal)
      const identity = (data: unknown) => JSON.stringify([config.id, config.configVersion, run.id, data])
      const directories = new Map<string, string>([['', config.targetDirId]])
      const touched = new Set<string>()
      async function targetDirectory(relativePath: string): Promise<string> {
        if (directories.has(relativePath)) return directories.get(relativePath)!
        let parentId = config.targetDirId
        let prefix = ''
        for (const name of relativePath.split('/')) {
          const safeName = sanitizeFileName(name)
          prefix = prefix ? `${prefix}/${name}` : name
          if (directories.has(prefix)) { parentId = directories.get(prefix)!; continue }
          assertActive()
          const parent = parentId
          const directory = await context.operation('订阅创建目录', identity([parent, prefix]), async () => {
            const listing = await request(() => adapter.listFiles(account, parent))
            if (listing.hasMore) throw new Error('目标目录列表不完整，停止创建目录')
            const matches = listing.files.filter(file => file.name === safeName)
            if (matches.length > 1 || (matches.length === 1 && !matches[0].isDir)) throw fatal(`目标路径冲突：${prefix}`)
            if (matches.length === 1) return matches[0]
            const result = await request(() => adapter.mkdir(account, parent, safeName))
            if (!result.id || !result.isDir) throw new Error('创建目标目录未返回有效目录标识')
            return result
          })
          assertActive(); parentId = directory.id; directories.set(prefix, parentId); touched.add(parent)
        }
        return parentId
      }
      run.state = 'running'; run.taskId = context.task.id; store.updateRun(run)
      try {
        let completed = 0
        for (const work of run.work) {
          assertActive()
          if (work.done) { completed++; continue }
          const target = await targetDirectory(work.targetRelativePath)
          if (work.kind === 'save') {
            const fileIds = work.entries.map(entry => entry.fileId).sort()
            const result = await context.operation('订阅转存', identity([work.parentId, target, fileIds]), () => request(async () => {
              const saved = await adapter.saveSharedFiles!(account, { url: config.url, password: config.password, fileIds }, target,
                { sourceParentId: work.parentId, signal: controller.signal })
              if (!saved.success || (saved.savedCount !== undefined && saved.savedCount < fileIds.length) || saved.error) throw new Error(saved.error || '订阅转存未确认全部文件成功')
              return { savedCount: saved.savedCount ?? fileIds.length }
            }))
            // Pause can prevent cursor advancement, but cannot erase evidence of a proven save.
            store.completeWork(run.id, work.id, result.savedCount); touched.add(target)
          } else store.completeWork(run.id, work.id, 0)
          assertActive()
          context.progress(Math.round(++completed / Math.max(1, run.work.length) * 99), `订阅更新 ${completed}/${run.work.length}`)
        }
        assertActive()
        if (!store.commitRun(run.id, nextCheck())) throw fatal('订阅配置已变化，保留执行记录但未更新当前基线')
        const savedCount = store.getRun(run.id)!.work.reduce((sum, work) => sum + (work.savedCount || 0), 0)
        try { events.onSynced({ subscriptionId: config.id, title: config.title || config.url, savedCount }) } catch { /* Ignore notification failures. */ }
        context.log('info', `订阅更新完成：已保存 ${savedCount} 个条目`)
        return { summary: `订阅更新完成：${savedCount} 个条目` }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'TASK_SCHEDULE_DEFERRED') throw error
        if (current(config) && !controller.signal.aborted) store.patch(config.id, config.configVersion, { lastError: error instanceof Error ? error.message : String(error) })
        throw error
      } finally {
        context.signal.removeEventListener('abort', abort)
        if (executions.get(config.id) === controller) executions.delete(config.id)
        if (touched.size) deps.invalidate(account.id, [...touched])
      }
    },
  }
  return scheduler
}
export function initShareSubscriptionScheduler(events: ShareSubscriptionEvents): ShareSubscriptionScheduler {
  if (instance) return instance
  instance = createShareSubscriptionScheduler(events)
  instance.start()
  return instance
}

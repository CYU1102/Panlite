import { randomUUID } from 'node:crypto'
import type { TaskStatus } from '../shared/types'
import type { AutomationAction, AutomationActionOption, AutomationPreview, AutomationResult, AutomationRule, AutomationRuleInput, AutomationRulesApi, AutomationRun, AutomationTrigger } from '../shared/automation-rules'
import { AutomationRuleStore } from './automation-rule-store'
import { withAutomationOrigin } from './automation-origin'

export interface AutomationRuleDependencies {
  listActions(): Promise<AutomationActionOption[]>
  prepare(action: AutomationAction): Promise<AutomationPreview>
  execute(action: AutomationAction, previewId: string): Promise<{ taskId?: string; summary?: string }>
  task(id: string): { id: string; status: TaskStatus; summary?: string } | undefined
  findTaskByRun(runId: string): { id: string; status: TaskStatus; summary?: string } | undefined
  onError?(): void
}
const errors: Record<string, string> = { RULE_MISSING: '规则不存在', RULE_VERSION: '规则已更新，请刷新后重试', RULE_BUSY: '规则已有未完成执行，请先处理该任务',
  RULE_DISABLED: '规则已暂停，不会创建新任务', PLAN_VERSION: '引用的计划已变化，请重新选择计划版本并试运行', RULE_CYCLE: '规则不能形成循环触发', RUN_MISSING: '执行记录不存在' }
class RuleError extends Error { constructor(message: string, readonly code = 'RULE_INVALID') { super(message) } }
function text(value: unknown, max = 256): string { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new RuleError('参数格式不正确'); return value.trim() }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuleError('参数格式不正确'); return value as Record<string, unknown> }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new RuleError('数值超出允许范围'); return value as number }
export function nextAutomationTime(trigger: AutomationTrigger, after: number): number | undefined {
  if (trigger.kind === 'interval') return after + trigger.everyMinutes * 60_000
  if (trigger.kind !== 'daily') return undefined
  const [hour, minute] = trigger.time.split(':').map(Number)
  const next = new Date(after); next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= after) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export class AutomationRuleService implements AutomationRulesApi {
  private disposed = false
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private readonly jobs = new Map<string, Promise<void>>()
  constructor(readonly store: AutomationRuleStore, readonly dependencies: AutomationRuleDependencies) {}
  private async result<T extends object>(work: () => T | Promise<T>): Promise<AutomationResult<T>> {
    try { if (this.disposed) throw new RuleError('规则中心已停止'); return { success: true, ...await work() } }
    catch (error) {
      if (error instanceof RuleError) return { success: false, error: error.message, code: error.code }
      const code = error instanceof Error ? error.message : ''
      return { success: false, error: errors[code] ?? '规则操作未完成，请重试', code: errors[code] ? code : 'RULE_ERROR' }
    }
  }
  private rule(id: string): AutomationRule { const rule = this.store.get(text(id)); if (!rule) throw new Error('RULE_MISSING'); return rule }
  private async validateAction(action: AutomationAction): Promise<void> {
    const options = await this.dependencies.listActions()
    if (!options.some(option => option.kind === action.kind && option.planId === action.planId && option.planVersion === action.planVersion)) throw new Error('PLAN_VERSION')
  }
  private trigger(value: unknown): AutomationTrigger {
    const input = object(value)
    if (input.kind === 'manual') return { kind: 'manual' }
    if (input.kind === 'task_success') return { kind: 'task_success', sourceRuleId: text(input.sourceRuleId) }
    if (input.missed !== 'skip' && input.missed !== 'run_once') throw new RuleError('请选择错过执行时间后的处理方式')
    if (input.kind === 'interval') return { kind: 'interval', everyMinutes: integer(input.everyMinutes, 5, 43_200), missed: input.missed }
    if (input.kind === 'daily' && typeof input.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return { kind: 'daily', time: input.time, missed: input.missed }
    throw new RuleError('触发时间格式不正确')
  }
  private checkCycle(id: string | undefined, trigger: AutomationTrigger): void {
    if (trigger.kind !== 'task_success') return
    let current: string | undefined = trigger.sourceRuleId
    const visited = new Set([id ?? '__new__'])
    while (current) {
      if (visited.has(current)) throw new Error('RULE_CYCLE')
      visited.add(current)
      const source = this.rule(current)
      current = source.trigger.kind === 'task_success' ? source.trigger.sourceRuleId : undefined
    }
  }
  listActions(): ReturnType<AutomationRulesApi['listActions']> { return this.result(async () => ({ actions: await this.dependencies.listActions() })) }
  listRules(): ReturnType<AutomationRulesApi['listRules']> { return this.result(() => { this.reconcile(); return { rules: this.store.list() } }) }
  saveRule(input: AutomationRuleInput): ReturnType<AutomationRulesApi['saveRule']> {
    return this.result(async () => {
      const raw = object(input), rawAction = object(raw.action), trigger = this.trigger(raw.trigger)
      if (rawAction.kind !== 'migration' && rawAction.kind !== 'backup') throw new RuleError('请选择迁移或备份计划')
      const action: AutomationAction = { kind: rawAction.kind, planId: text(rawAction.planId), planVersion: integer(rawAction.planVersion, 1, Number.MAX_SAFE_INTEGER) }
      if (typeof raw.enabled !== 'boolean') throw new RuleError('规则状态不正确')
      const id = raw.id === undefined ? undefined : text(raw.id)
      this.checkCycle(id, trigger); await this.validateAction(action)
      if (this.disposed) throw new RuleError('规则中心已停止')
      this.checkCycle(id, trigger)
      const rule = this.store.save({ id, expectedVersion: id ? integer(raw.expectedVersion, 1, Number.MAX_SAFE_INTEGER) : undefined,
        name: text(raw.name, 120), enabled: raw.enabled, action, trigger }, raw.enabled ? nextAutomationTime(trigger, this.store.now()) : undefined)
      return { rule }
    })
  }
  setEnabled(input: { id: string; enabled: boolean; expectedVersion: number }): ReturnType<AutomationRulesApi['setEnabled']> {
    return this.result(async () => {
      const raw = object(input), rule = this.rule(text(raw.id))
      if (rule.version !== integer(raw.expectedVersion, 1, Number.MAX_SAFE_INTEGER)) throw new Error('RULE_VERSION')
      if (typeof raw.enabled !== 'boolean') throw new RuleError('规则状态不正确')
      if (raw.enabled) await this.validateAction(rule.action)
      const latest = this.rule(rule.id)
      if (latest.version !== rule.version) throw new Error('RULE_VERSION')
      const updated: AutomationRule = { ...latest, enabled: raw.enabled, version: latest.version + 1, updatedAt: this.store.now(), error: undefined,
        nextRunAt: raw.enabled ? nextAutomationTime(latest.trigger, this.store.now()) : undefined, triggerSince: this.store.now() }
      this.store.put(updated); return { rule: updated }
    })
  }
  removeRule(id: string): ReturnType<AutomationRulesApi['removeRule']> { return this.result(() => {
    const rule = this.rule(id)
    if (this.store.active(rule.id)) throw new Error('RULE_BUSY')
    if (this.store.list().some(item => item.trigger.kind === 'task_success' && item.trigger.sourceRuleId === rule.id)) throw new RuleError('其他规则引用了此规则，请先修改关联触发器')
    this.store.remove(rule.id); return {}
  }) }
  dryRun(id: string): ReturnType<AutomationRulesApi['dryRun']> { return this.result(async () => {
    const rule = this.rule(id)
    if (this.store.active(rule.id)) throw new Error('RULE_BUSY')
    await this.validateAction(rule.action)
    const preview = await this.dependencies.prepare(rule.action)
    if (this.rule(id).version !== rule.version) throw new Error('RULE_VERSION')
    return { preview }
  }) }
  runNow(input: Parameters<AutomationRulesApi['runNow']>[0]): ReturnType<AutomationRulesApi['runNow']> { return this.result(() => {
    const raw = typeof input === 'string' ? { id: input } : object(input)
    const rule = this.rule(text(raw.id))
    if (typeof input !== 'string' && rule.version !== integer(raw.expectedVersion, 1, Number.MAX_SAFE_INTEGER)) throw new Error('RULE_VERSION')
    const run = this.store.claim(rule, `manual:${randomUUID()}`)
    this.dispatch(run); return { run }
  }) }
  listRuns(input: { ruleId: string; page?: number; pageSize?: number }): ReturnType<AutomationRulesApi['listRuns']> { return this.result(() => {
    const raw = object(input); this.rule(text(raw.ruleId)); this.reconcile()
    const page = integer(raw.page ?? 1, 1, 1_000_000), pageSize = integer(raw.pageSize ?? 50, 1, 200)
    const runs = this.store.runs(input.ruleId)
    return { runs: runs.slice((page - 1) * pageSize, page * pageSize), total: runs.length, page, pageSize }
  }) }
  private finish(run: AutomationRun, status: 'success' | 'failed' | 'attention', summary: string): void {
    this.store.db.transaction(() => {
      this.store.patchRun(run.id, { status, summary, finishedAt: this.store.now() })
      const rule = this.store.get(run.ruleId)
      if (!rule || rule.lastRunId !== run.id || rule.version !== run.ruleVersion) return
      this.store.put(status === 'success' ? { ...rule, lastSuccessAt: this.store.now(), updatedAt: this.store.now(), error: undefined,
        nextRunAt: rule.enabled ? nextAutomationTime(rule.trigger, this.store.now()) : undefined }
        : { ...rule, enabled: false, nextRunAt: undefined, updatedAt: this.store.now(), error: summary })
    })()
  }
  private dispatch(run: AutomationRun): Promise<void> | undefined {
    if (this.disposed || this.jobs.has(run.id) || run.status !== 'preparing') return
    const job = this.perform(run).catch(() => { this.dependencies.onError?.() }).finally(() => { this.jobs.delete(run.id) })
    this.jobs.set(run.id, job)
    return job
  }
  private async perform(run: AutomationRun): Promise<void> {
    try {
      await this.validateAction(run.action)
      const preview = await this.dependencies.prepare(run.action)
      if (this.disposed) return
      const rule = this.rule(run.ruleId)
      if (!rule.enabled || rule.version !== run.ruleVersion) { this.finish(run, 'failed', '规则在准备期间被暂停或更新，未创建任务'); return }
      if (!preview.executable || !preview.previewId) { this.finish(run, 'attention', preview.summary || '预演需要人工核对，未创建任务'); return }
      await this.validateAction(run.action)
      if (this.disposed) return
      const latest = this.rule(run.ruleId)
      if (!latest.enabled || latest.version !== run.ruleVersion) { this.finish(run, 'failed', '规则在准备期间被暂停或更新，未创建任务'); return }
      this.store.patchRun(run.id, { status: 'dispatching', previewId: preview.previewId, summary: preview.summary })
      const dispatched = await withAutomationOrigin({ ruleId: run.ruleId, runId: run.id, taskType: run.action.kind === 'migration' ? 'planned_transfer' : 'file_backup',
        assertAllowed: () => {
          const current = this.rule(run.ruleId)
          if (this.disposed || !current.enabled || current.version !== run.ruleVersion) throw new Error('RULE_DISABLED')
        } },
        () => this.dependencies.execute(run.action, preview.previewId!))
      if (this.disposed) return
      if (dispatched.taskId) this.store.patchRun(run.id, { status: 'running', taskId: dispatched.taskId, summary: dispatched.summary ?? '已提交任务，等待执行完成' })
      else this.finish(run, 'success', dispatched.summary ?? '内容未变化，无需创建传输任务')
    } catch (error) {
      if (this.disposed) return
      const queued = this.dependencies.findTaskByRun(run.id)
      if (queued) { this.store.patchRun(run.id, { status: 'running', taskId: queued.id }); return }
      const summary = error instanceof RuleError ? error.message : error instanceof Error && errors[error.message] ? errors[error.message] : '执行准备未完成，请检查计划；规则已暂停'
      this.finish(run, 'attention', summary)
    }
  }
  reconcile(): void {
    for (const run of this.store.activeRuns()) {
      if (run.status !== 'running') continue
      const task = run.taskId ? this.dependencies.task(run.taskId) : this.dependencies.findTaskByRun(run.id)
      if (!task) { this.finish(run, 'attention', '关联任务记录缺失，已停止自动执行'); continue }
      if (task.status === 'success') this.finish(run, 'success', task.summary ?? '关联任务已成功完成')
      else if (['failed', 'partial_success', 'cancelled'].includes(task.status)) this.finish(run, 'attention', task.summary ?? '关联任务未全部完成，请核对任务记录')
    }
  }
  /** Recover provenance from the original queue; never dispatch an ambiguous run twice. */
  recover(): void {
    for (const run of this.store.activeRuns()) {
      const task = run.taskId ? this.dependencies.task(run.taskId) : this.dependencies.findTaskByRun(run.id)
      if (task) this.store.patchRun(run.id, { status: 'running', taskId: task.id })
      else this.finish(run, 'attention', '上次执行在准备或提交时中断，未自动重发，请核对后重新启用')
    }
    this.reconcile()
  }
  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return
    this.ticking = true
    const started: Promise<void>[] = []
    try {
      this.reconcile()
      for (const rule of this.store.list()) {
        if (!rule.enabled || this.store.active(rule.id)) continue
        let event: string | undefined
        if (rule.trigger.kind === 'task_success') {
          const sourceRuleId = rule.trigger.sourceRuleId
          const previous = this.store.runs(sourceRuleId).filter(run => run.status === 'success' && (run.finishedAt ?? 0) >= rule.triggerSince)
            .reverse().find(run => !this.store.findEvent(rule.id, `success:${run.id}`))
          if (previous) event = `success:${previous.id}`
        } else if ((rule.trigger.kind === 'interval' || rule.trigger.kind === 'daily') && rule.nextRunAt !== undefined && rule.nextRunAt <= this.store.now()) {
          if (this.store.now() - rule.nextRunAt > 60_000 && rule.trigger.missed === 'skip') {
            this.store.put({ ...rule, nextRunAt: nextAutomationTime(rule.trigger, this.store.now()), updatedAt: this.store.now() }); continue
          }
          event = `time:${rule.nextRunAt}`
        }
        if (event) {
          try {
            const job = this.dispatch(this.store.claim(rule, event))
            if (job) started.push(job)
          } catch { /* A concurrent click or pause owns this rule now. */ }
        }
      }
    } finally { this.ticking = false }
    // Pending network preparation belongs to its rule and must not hold the scheduler lock.
    await Promise.allSettled(started)
  }
  start(): void {
    if (this.timer || this.disposed) return
    this.recover()
    const tick = (): void => { void this.tick().catch(() => { this.dependencies.onError?.() }) }
    tick(); this.timer = setInterval(tick, 15_000); this.timer.unref?.()
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined }
  async waitForIdle(): Promise<void> { await Promise.allSettled([...this.jobs.values()]) }
}
